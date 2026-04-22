// Debug script for WebSocket testing

const { createTLSServer } = require('./apps/server/lib/tls-server');
const { createHTTPServer } = require('./apps/server/lib/http-router');
const { ClientManager } = require('./apps/server/lib/client-manager');
const { createTLSConnection } = require('./apps/client/lib/tls-connection');
const { createProxy } = require('./apps/client/lib/proxy');
const { createMockTarget } = require('./tests/e2e/tls-mtls/mock-target');
const { initCA, issueClientCertificate, issueServerCertificate } = require('./apps/server/lib/ca');
const { mkdtempSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { request } = require('node:http');

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

async function main() {
  console.log('Setting up test environment...');

  // Create temp directories
  const testCaDir = mkdtempSync(join(tmpdir(), 'tunnel-ca-'));
  const testCertDir = mkdtempSync(join(tmpdir(), 'tunnel-certs-'));

  // Initialize CA
  initCA(testCaDir);

  // Issue server certificate
  const serverDir = join(testCertDir, 'server');
  mkdirSync(serverDir, { recursive: true });
  issueServerCertificate('localhost', serverDir, testCaDir);

  // Issue client certificate
  const clientDir = join(testCertDir, 'client');
  mkdirSync(clientDir, { recursive: true });
  issueClientCertificate(clientDir, testCaDir);

  const certs = {
    caCert: join(testCaDir, 'ca-cert.pem'),
    caDir: testCaDir,
    serverKey: join(serverDir, 'server-key.pem'),
    serverCert: join(serverDir, 'server-cert.pem'),
    clientKey: join(clientDir, 'client-key.pem'),
    clientCert: join(clientDir, 'client-cert.pem'),
    clientCa: join(clientDir, 'ca-cert.pem')
  };

  const tlsPort = await getPort();
  const httpPort = await getPort();
  const targetPort = await getPort();

  console.log(`Ports: TLS=${tlsPort}, HTTP=${httpPort}, Target=${targetPort}`);

  // Create servers
  const clientManager = new ClientManager();
  const tlsServer = createTLSServer(clientManager, {
    serverKey: certs.serverKey,
    serverCert: certs.serverCert,
    caCert: certs.caCert,
    caDir: certs.caDir
  });

  const httpServer = createHTTPServer(clientManager, tlsServer, {
    streamTimeout: 30000
  });

  // Mock target with WebSocket support
  const mockTarget = createMockTarget();

  await new Promise(r => tlsServer.listen(tlsPort, r));
  await new Promise(r => httpServer.listen(httpPort, r));
  await new Promise(r => mockTarget.listen(targetPort, r));

  console.log('Servers started');

  // Create client connection
  let clientProxy = null;
  
  const clientConnection = createTLSConnection(
    {
      serverHost: 'localhost',
      serverPort: tlsPort,
      clientKey: certs.clientKey,
      clientCert: certs.clientCert,
      caCert: certs.clientCa
    },
    (frame) => {
      console.log('Client received frame:', frame.streamId, frame.type, frame.payload?.length);
      if (clientProxy) {
        clientProxy.handleFrame(frame);
      }
    },
    () => {
      console.log('Client connected');
      clientProxy = createProxy(clientConnection, targetPort, 'localhost');
    },
    () => {
      console.log('Client disconnected');
    }
  );

  // Wait for client to connect
  await new Promise(r => setTimeout(r, 500));

  console.log('Attempting WebSocket upgrade...');

  // Perform WebSocket handshake
  const wsKey = 'dGhlIHNhbXBsZSBub25jZQ=='; // Sample nonce

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'localhost',
      port: httpPort,
      path: '/ws-echo',
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13'
      }
    }, (res) => {
      console.log('Got HTTP response (not upgrade):', res.statusCode);
      res.on('data', d => console.log('Response data:', d.toString()));
      res.on('end', () => {
        resolve();
      });
    });

    req.on('upgrade', (res, socket, head) => {
      console.log('WebSocket upgrade successful!');
      console.log('Status:', res.statusCode);
      console.log('Headers:', res.headers);
      
      // Send a text frame
      const message = 'Hello WebSocket';
      const masked = true;
      const payloadLen = message.length;
      const maskKey = Buffer.from([0x01, 0x02, 0x03, 0x04]); // Fixed mask for testing
      
      const frame = Buffer.allocUnsafe(2 + 4 + payloadLen);
      frame[0] = 0x81; // FIN=1, opcode=1 (text)
      frame[1] = 0x80 | payloadLen; // MASK=1, length
      maskKey.copy(frame, 2);
      
      // Mask the payload
      const payload = Buffer.from(message);
      for (let i = 0; i < payload.length; i++) {
        frame[6 + i] = payload[i] ^ maskKey[i % 4];
      }
      
      socket.write(frame);
      console.log('Sent message:', message);

      // Wait for echo
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        console.log('Received data, buffer length:', buffer.length);
        
        // Parse WebSocket frame
        if (buffer.length >= 2) {
          const opcode = buffer[0] & 0x0f;
          const payloadLen = buffer[1] & 0x7f;
          console.log('Frame opcode:', opcode, 'payloadLen:', payloadLen);
          
          if (buffer.length >= 2 + payloadLen) {
            const payload = buffer.subarray(2, 2 + payloadLen);
            console.log('Echo received:', payload.toString());
            socket.destroy();
            resolve();
          }
        }
      });

      socket.on('close', () => {
        console.log('Socket closed');
        resolve();
      });

      socket.on('error', (err) => {
        console.error('Socket error:', err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error('Request error:', err);
      reject(err);
    });

    req.end();

    // Timeout
    setTimeout(() => {
      req.destroy();
      reject(new Error('Timeout waiting for upgrade'));
    }, 5000);
  }).finally(async () => {
    clientConnection.destroy();
    await Promise.all([
      new Promise(r => tlsServer.close(r)),
      new Promise(r => httpServer.close(r)),
      new Promise(r => mockTarget.close(r))
    ]);
    console.log('Cleanup complete');
  });
}

main()
  .then(() => {
    console.log('Test completed');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
