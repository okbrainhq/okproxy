// Shared test setup for TLS e2e tests

const { createTLSServer } = require('../../../apps/server/lib/tls-server');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { ClientManager } = require('../../../apps/server/lib/client-manager');
const { createTLSConnection } = require('../../../apps/client/lib/tls-connection');
const { createProxy } = require('../../../apps/client/lib/proxy');
const { createMockTarget } = require('./mock-target');
const { initCA, issueClientCertificate, issueServerCertificate } = require('../../../apps/server/lib/ca');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

let testCaDir = null;
let testCertDir = null;

// Initialize test CA and generate certificates
function initTestCerts() {
  if (testCaDir) return;

  // Create temp directories
  testCaDir = mkdtempSync(join(tmpdir(), 'tunnel-ca-'));
  testCertDir = mkdtempSync(join(tmpdir(), 'tunnel-certs-'));

  // Initialize CA
  initCA(testCaDir);

  // Issue server certificate for localhost
  const serverDir = join(testCertDir, 'server');
  mkdirSync(serverDir, { recursive: true });
  issueServerCertificate('localhost', serverDir, testCaDir);

  // Issue client certificate
  const clientDir = join(testCertDir, 'client');
  mkdirSync(clientDir, { recursive: true });
  issueClientCertificate(clientDir, testCaDir);
}

// Get certificate paths
function getCertPaths() {
  initTestCerts();
  return {
    caCert: join(testCaDir, 'ca-cert.pem'),
    caDir: testCaDir,
    serverKey: join(testCertDir, 'server', 'server-key.pem'),
    serverCert: join(testCertDir, 'server', 'server-cert.pem'),
    clientKey: join(testCertDir, 'client', 'client-key.pem'),
    clientCert: join(testCertDir, 'client', 'client-cert.pem'),
    clientCa: join(testCertDir, 'client', 'ca-cert.pem')
  };
}

// Get available ports
async function getPort() {
  const { createServer } = require('node:net');
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// Create a test environment with TLS
async function createTestEnv(options = {}) {
  const certs = getCertPaths();
  const tlsPort = await getPort();
  const httpPort = await getPort();
  const targetPort = await getPort();

  const clientManager = new ClientManager();
  const tlsServer = createTLSServer(clientManager, {
    serverKey: certs.serverKey,
    serverCert: certs.serverCert,
    caCert: certs.caCert,
    caDir: certs.caDir,
    maxConcurrentStreams: options.maxStreams || 100,
    streamTimeout: options.streamTimeout || 30000,
    keepaliveInterval: options.keepaliveInterval || 30000,
    keepaliveTimeout: options.keepaliveTimeout || 10000,
    initTimeout: options.initTimeout || 10000
  });

  const httpServer = createHTTPServer(clientManager, tlsServer, {
    maxConcurrentStreams: options.maxStreams || 100,
    streamTimeout: options.streamTimeout || 30000,
    maxBodySize: options.maxBodySize
  });

  const mockTarget = createMockTarget(options.mockTarget);

  // Start all servers
  await new Promise((resolve) => tlsServer.listen(tlsPort, resolve));
  await new Promise((resolve) => httpServer.listen(httpPort, resolve));
  await new Promise((resolve) => mockTarget.listen(targetPort, resolve));

  // Create client connection
  let clientConnection = null;
  let clientProxy = null;
  let clientConnected = false;
  let clientDisconnected = false;

  function doConnect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Client connection timeout'));
      }, 5000);

      clientConnection = createTLSConnection(
        {
          serverHost: 'localhost',
          serverPort: tlsPort,
          clientKey: certs.clientKey,
          clientCert: certs.clientCert,
          caCert: certs.clientCa
        },
        (frame) => {
          if (clientProxy) {
            clientProxy.handleFrame(frame);
          }
        },
        () => {
          clearTimeout(timeout);
          clientConnected = true;
          clientDisconnected = false;
          clientProxy = createProxy(clientConnection, targetPort);
          resolve();
        },
        () => {
          clientDisconnected = true;
          clientConnected = false;
          if (clientProxy) {
            clientProxy.destroy();
            clientProxy = null;
          }
        }
      );
    });
  }

  function startClient() {
    clientConnected = false;
    clientDisconnected = false;
    return doConnect();
  }

  function disconnectClient() {
    // Kill the TLS socket but keep the connection object alive
    // so its built-in reconnection logic kicks in
    if (clientConnection && clientConnection.socket) {
      clientConnection.socket.destroy();
    }
  }

  function stopClient() {
    clientDisconnected = false;
    if (clientConnection) {
      clientConnection.destroy();
      clientConnection = null;
    }
    if (clientProxy) {
      clientProxy.destroy();
      clientProxy = null;
    }
    clientConnected = false;
  }

  function isClientConnected() {
    return clientConnection && clientConnection.isConnected();
  }

  async function cleanup() {
    stopClient();
    await Promise.all([
      new Promise(r => tlsServer.close(r)),
      new Promise(r => httpServer.close(r)),
      new Promise(r => mockTarget.close(r))
    ]);
  }

  return {
    ports: { tlsPort, httpPort, targetPort },
    certs,
    servers: { tlsServer, httpServer, mockTarget },
    clientManager,
    clientConnection: () => clientConnection,
    clientProxy: () => clientProxy,
    startClient,
    stopClient,
    disconnectClient,
    isClientConnected,
    isConnected: () => clientConnected,
    isDisconnected: () => clientDisconnected,
    cleanup
  };
}

// HTTP request helper
function httpRequest(options) {
  const { request } = require('node:http');
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// Streaming HTTP request helper
function httpRequestStream(options, onData) {
  const { request } = require('node:http');
  return new Promise((resolve, reject) => {
    const req = request(options, (res) => {
      res.on('data', onData);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

module.exports = {
  getPort,
  getCertPaths,
  createTestEnv,
  httpRequest,
  httpRequestStream
};
