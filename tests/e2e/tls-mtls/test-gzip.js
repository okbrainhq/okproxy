// Test to verify content-encoding header passes through (multipath-compatible)
const { createTLSServer } = require('../../../apps/server/lib/tls-server');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { ConnectionPool } = require('../../../apps/server/lib/connection-pool');
const { VirtualSocket } = require('../../../apps/client/lib/virtual-socket');
const { createProxy } = require('../../../apps/client/lib/proxy');
const http = require('http');
const { initCA, issueClientCertificate, issueServerCertificate } = require('../../../apps/server/lib/ca');
const { mkdtempSync, mkdirSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

async function test() {
  const testCaDir = mkdtempSync(join(tmpdir(), 'tunnel-ca-'));
  const testCertDir = mkdtempSync(join(tmpdir(), 'tunnel-certs-'));
  initCA(testCaDir);
  
  const serverDir = join(testCertDir, 'server');
  mkdirSync(serverDir, { recursive: true });
  issueServerCertificate('localhost', serverDir, testCaDir);
  
  const clientDir = join(testCertDir, 'client');
  mkdirSync(clientDir, { recursive: true });
  issueClientCertificate(clientDir, testCaDir);

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
  
  const connectionPool = new ConnectionPool();
  const tlsPort = 19443;
  const httpPort = 18080;
  
  const tlsServer = createTLSServer(connectionPool, {
    serverKey: join(serverDir, 'server-key.pem'),
    serverCert: join(serverDir, 'server-cert.pem'),
    caCert: join(testCaDir, 'ca-cert.pem'),
    caDir: testCaDir,
  });

  const httpServer = createHTTPServer(connectionPool, tlsServer);

  await new Promise(r => tlsServer.listen(tlsPort, r));
  await new Promise(r => httpServer.listen(httpPort, r));
  
  let clientProxy = null;
  
  const vs = new VirtualSocket({
    serverHost: 'localhost',
    serverPort: tlsPort,
    clientKey: join(clientDir, 'client-key.pem'),
    clientCert: join(clientDir, 'client-cert.pem'),
    caCert: join(clientDir, 'ca-cert.pem')
  });

  vs.on('ready', () => {
    console.log('Client connected');
    clientProxy = createProxy(vs, targetPort);
  });

  vs.on('frame', (frame) => {
    if (clientProxy && frame.streamId > 0) {
      clientProxy.handleFrame(frame);
    }
  });

  vs.on('error', (err) => {
    console.error('VirtualSocket error:', err.message);
  });

  vs.start();
  
  await new Promise(r => setTimeout(r, 1000));
  
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: httpPort,
      path: '/',
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  
  console.log('Response status:', response.status);
  console.log('Response headers:', JSON.stringify(response.headers));
  console.log('Response body length:', response.body.length);
  
  // Verify content-encoding header passes through
  if (response.headers['content-encoding'] === 'gzip') {
    console.log('✓ content-encoding: gzip header passed through successfully');
  } else {
    console.error('✗ content-encoding header NOT passed through!');
    console.error('  Headers:', JSON.stringify(response.headers));
    process.exit(1);
  }
  
  // Verify body is unchanged (85 bytes = decoded gzip binary)
  if (response.body.length === 85) {
    console.log('✓ Body length correct (85 bytes)');
  } else {
    console.error(`✗ Body length mismatch: expected 85, got ${response.body.length}`);
    process.exit(1);
  }

  console.log('✓ Gzip test passed');
  
  // Cleanup
  vs.destroy();
  tlsServer.close();
  httpServer.close();
  targetServer.close();
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
