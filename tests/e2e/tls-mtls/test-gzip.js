// Test to verify content-encoding header passes through
const { createTLSServer } = require('../../../apps/server/lib/tls-server');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { ClientManager } = require('../../../apps/server/lib/client-manager');
const { createTLSConnection } = require('../../../apps/client/lib/tls-connection');
const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');
const http = require('http');
const { initCA, issueClientCertificate, issueServerCertificate } = require('../../../apps/server/lib/ca');
const { mkdtempSync, mkdirSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

async function test() {
  // Create test CA
  const testCaDir = mkdtempSync(join(tmpdir(), 'tunnel-ca-'));
  const testCertDir = mkdtempSync(join(tmpdir(), 'tunnel-certs-'));
  initCA(testCaDir);
  
  const serverDir = join(testCertDir, 'server');
  mkdirSync(serverDir, { recursive: true });
  issueServerCertificate('localhost', serverDir, testCaDir);
  
  const clientDir = join(testCertDir, 'client');
  mkdirSync(clientDir, { recursive: true });
  issueClientCertificate(clientDir, testCaDir);

  // Create a target that returns gzip content with content-encoding header
  const targetServer = http.createServer((req, res) => {
    const gzipData = Buffer.from('H4sIAAAAAAAAA0vOz0vMS9VNzs8tKE5VSEnPL0ktUihOLSpJzU3MzFNIS8wpSXVJzE1VSE0pzc3P0yiB8BKLS1I9SvJTUjU0rTmCBADfrPG7XQAAAA==', 'base64');
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'Content-Encoding': 'gzip',
      'Content-Length': gzipData.length
    });
    res.end(gzipData);
  });

  const targetPort = await new Promise(r => targetServer.listen(0, () => r(targetServer.address().port)));
  console.log('Target server on port', targetPort);
  
  // Create tunnel servers
  const clientManager = new ClientManager();
  const tlsPort = 19443;
  const httpPort = 18080;
  
  const tlsServer = createTLSServer(clientManager, {
    serverKey: join(serverDir, 'server-key.pem'),
    serverCert: join(serverDir, 'server-cert.pem'),
    caCert: join(testCaDir, 'ca-cert.pem'),
    caDir: testCaDir,
  });

  const httpServer = createHTTPServer(clientManager, tlsServer);

  await new Promise(r => tlsServer.listen(tlsPort, r));
  await new Promise(r => httpServer.listen(httpPort, r));
  
  // Create proxy
  const { createProxy } = require('../../../apps/client/lib/proxy');
  let clientProxy = null;
  
  // Create client
  const clientConnection = createTLSConnection(
    {
      serverHost: 'localhost',
      serverPort: tlsPort,
      clientKey: join(clientDir, 'client-key.pem'),
      clientCert: join(clientDir, 'client-cert.pem'),
      caCert: join(clientDir, 'ca-cert.pem')
    },
    (frame) => {
      if (frame.streamId > 0 && clientProxy) {
        clientProxy.handleFrame(frame);
      }
    },
    () => { 
      console.log('Client connected');
      clientProxy = createProxy(clientConnection, targetPort);
    },
    () => { console.log('Client disconnected'); }
  );
  
  // Wait for client to connect
  await new Promise(r => setTimeout(r, 1000));
  
  // Make request through tunnel
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: httpPort,
      path: '/test',
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
  
  console.log('\n=== Tunnel Response Headers ===');
  for (const [key, value] of Object.entries(response.headers)) {
    console.log(key + ':', value);
  }
  console.log('\nHas content-encoding?', 'content-encoding' in response.headers);
  console.log('Has content-type?', 'content-type' in response.headers);
  console.log('Body is gzip?', response.body.toString('hex').slice(0, 20) === '1f8b08000000000000');
  
  // Cleanup
  clientConnection.destroy();
  httpServer.close();
  tlsServer.close();
  targetServer.close();
  
  // Verify
  if (!('content-encoding' in response.headers)) {
    console.log('\nFAIL: content-encoding header was stripped!');
    process.exit(1);
  } else if (!('content-type' in response.headers)) {
    console.log('\nFAIL: content-type header was stripped!');
    process.exit(1);
  } else {
    console.log('\nPASS: content-encoding and content-type headers preserved');
    process.exit(0);
  }
}

test().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
