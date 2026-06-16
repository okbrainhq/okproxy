// E2E: certificate-bound multi-client domain routing

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { connect: netConnect } = require('node:net');
const crypto = require('node:crypto');
const { join } = require('node:path');
const { createTLSServer } = require('../../../apps/server/lib/tls-server');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { MultiClientManager } = require('../../../apps/server/lib/multi-client-manager');
const { VirtualSocket } = require('../../../apps/client/lib/virtual-socket');
const { createProxy } = require('../../../apps/client/lib/proxy');
const { revokeCertificate } = require('../../../apps/server/lib/ca');
const { readFileSync, writeFileSync } = require('node:fs');
const { getPort, getCertPaths, issueTestClientCertificate, httpRequest } = require('./setup');

function createNamedTarget(name) {
  const activeSockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, host: req.headers.host, xfHost: req.headers['x-forwarded-host'] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(name);
  });

  server.on('upgrade', (req, socket) => {
    activeSockets.add(socket);
    socket.on('close', () => activeSockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const acceptHash = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptHash}`,
      '',
      ''
    ].join('\r\n'));
    socket.on('data', () => {
      const payload = Buffer.from(name);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
  });

  server.forceCloseAllSockets = () => {
    for (const socket of activeSockets) socket.destroy();
    activeSockets.clear();
  };
  return server;
}

async function startVirtualClient({ tlsPort, cert, targetPort, domains = [], extraRealSocket = false }) {
  const vs = new VirtualSocket({
    serverHost: 'localhost',
    serverPort: tlsPort,
    clientKey: cert.clientKey,
    clientCert: cert.clientCert,
    caCert: cert.clientCa,
    domains
  });
  let proxy;
  await new Promise((resolve, reject) => {
    const fail = (err) => { try { proxy?.destroy(); vs.destroy(); } catch {} reject(err); };
    const timeout = setTimeout(() => fail(new Error('client connection timeout')), 5000);
    vs.on('ready', () => {
      clearTimeout(timeout);
      proxy = createProxy(vs, targetPort, 'localhost', 100);
      resolve();
    });
    vs.on('frame', (frame) => proxy && proxy.handleFrame(frame));
    vs.on('error', (err) => {
      clearTimeout(timeout);
      fail(err);
    });
    vs.start();
  });
  if (extraRealSocket) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('extra socket timeout')), 5000);
      vs.once('socketConnected', (interfaceName) => {
        if (interfaceName === 'extra-test') {
          clearTimeout(timeout);
          resolve();
        }
      });
      vs._createRealSocket('extra-test', null);
    });
  }
  return { vs, proxy, stop: () => { proxy?.destroy(); vs.destroy(); } };
}

async function createMultiEnv() {
  const certs = getCertPaths();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const domains = {
    a: `a-${suffix}.example.com`,
    b: `b-${suffix}.example.com`,
    offline: `offline-${suffix}.example.com`,
    revoked: `revoked-${suffix}.example.com`
  };
  const certA = issueTestClientCertificate(`client-a-${suffix}`, [domains.a]);
  const certB = issueTestClientCertificate(`client-b-${suffix}`, [domains.b]);
  issueTestClientCertificate(`client-offline-${suffix}`, [domains.offline]);
  const certRevoked = issueTestClientCertificate(`client-revoked-${suffix}`, [domains.revoked]);

  const tlsPort = await getPort();
  const httpPort = await getPort();
  const targetAPort = await getPort();
  const targetBPort = await getPort();

  const manager = new MultiClientManager({
    caDir: certs.caDir,
    issuedDomainIndex: join(certs.caDir, 'issued-domains.json'),
    maxConcurrentStreams: 100
  });
  const tlsServer = createTLSServer(manager, {
    serverKey: certs.serverKey,
    serverCert: certs.serverCert,
    caCert: certs.caCert,
    caDir: certs.caDir,
    certBoundDomains: true,
    maxConcurrentStreams: 100,
    keepaliveInterval: 10000,
    keepaliveTimeout: 25000,
    initTimeout: 10000
  });
  const httpServer = createHTTPServer(manager, tlsServer, {
    certBoundDomains: true,
    maxConcurrentStreams: 100,
    streamTimeout: 30000
  });
  const targetA = createNamedTarget('target-a');
  const targetB = createNamedTarget('target-b');

  await new Promise(resolve => tlsServer.listen(tlsPort, resolve));
  await new Promise(resolve => httpServer.listen(httpPort, resolve));
  await new Promise(resolve => targetA.listen(targetAPort, resolve));
  await new Promise(resolve => targetB.listen(targetBPort, resolve));

  const clients = [];
  async function cleanup() {
    for (const client of clients) client.stop();
    targetA.forceCloseAllSockets();
    targetB.forceCloseAllSockets();
    await Promise.all([
      new Promise(resolve => tlsServer.close(resolve)),
      new Promise(resolve => httpServer.close(resolve)),
      new Promise(resolve => targetA.close(resolve)),
      new Promise(resolve => targetB.close(resolve))
    ]);
  }

  return { certs, certA, certB, certRevoked, domains, ports: { tlsPort, httpPort, targetAPort, targetBPort }, clients, cleanup };
}

function websocketRequest({ port, host }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = netConnect(port, 'localhost', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n'));
    });
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('websocket timeout')); }, 5000);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headers = buffer.subarray(0, headerEnd).toString();
        assert.match(headers, /101 Switching Protocols/);
        upgraded = true;
        buffer = buffer.subarray(headerEnd + 4);
        const payload = Buffer.from('ping');
        const mask = Buffer.from([1, 2, 3, 4]);
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
      }
      if (upgraded && buffer.length >= 2) {
        const len = buffer[1] & 0x7f;
        if (buffer.length >= 2 + len) {
          clearTimeout(timeout);
          const body = buffer.subarray(2, 2 + len).toString();
          socket.destroy();
          resolve(body);
        }
      }
    });
    socket.on('error', reject);
  });
}

test('cert-bound mode routes two domains to isolated clients', async () => {
  const env = await createMultiEnv();
  try {
    env.clients.push(await startVirtualClient({ tlsPort: env.ports.tlsPort, cert: env.certA, targetPort: env.ports.targetAPort, extraRealSocket: true }));
    env.clients.push(await startVirtualClient({ tlsPort: env.ports.tlsPort, cert: env.certB, targetPort: env.ports.targetBPort }));

    const resA = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/echo', headers: { host: env.domains.a } });
    const resB = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/echo', headers: { host: env.domains.b } });
    assert.equal(resA.statusCode, 200);
    assert.equal(resB.statusCode, 200);
    assert.equal(JSON.parse(resA.body).name, 'target-a');
    assert.equal(JSON.parse(resB.body).name, 'target-b');
    assert.equal(JSON.parse(resA.body).xfHost, env.domains.a);

    const resAWithPort = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/echo', headers: { host: `${env.domains.a.toUpperCase()}.:${env.ports.httpPort}` } });
    assert.equal(resAWithPort.statusCode, 200);
    assert.equal(JSON.parse(resAWithPort.body).name, 'target-a');

    const wsBody = await websocketRequest({ port: env.ports.httpPort, host: env.domains.b });
    assert.equal(wsBody, 'target-b');
  } finally {
    await env.cleanup();
  }
});

test('cert-bound mode rejects unknown host and returns 502 for authorized disconnected domain', async () => {
  const env = await createMultiEnv();
  try {
    env.clients.push(await startVirtualClient({ tlsPort: env.ports.tlsPort, cert: env.certA, targetPort: env.ports.targetAPort }));
    const unknown = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/', headers: { host: `unknown-${Date.now()}.example.com` } });
    assert.equal(unknown.statusCode, 404);

    const offline = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/', headers: { host: env.domains.offline } });
    assert.equal(offline.statusCode, 502);

    const askOk = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: `/_okproxy/caddy-ask?domain=${env.domains.offline.toUpperCase()}.`, headers: { host: '127.0.0.1' } });
    assert.equal(askOk.statusCode, 200);
    const askNo = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/_okproxy/caddy-ask?domain=nope.example.com', headers: { host: '127.0.0.1' } });
    assert.equal(askNo.statusCode, 404);

    const invalid = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: '/', headers: { host: 'bad_host' } });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await env.cleanup();
  }
});

test('connected client certificate domains are saved to issued domain index for Caddy ask', async () => {
  const env = await createMultiEnv();
  try {
    const issuedDomainIndex = join(env.certs.caDir, 'issued-domains.json');
    writeFileSync(issuedDomainIndex, JSON.stringify({ version: 1, domains: {} }, null, 2) + '\n');

    const askBefore = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: `/_okproxy/caddy-ask?domain=${env.domains.a}`, headers: { host: '127.0.0.1' } });
    assert.equal(askBefore.statusCode, 404);

    env.clients.push(await startVirtualClient({ tlsPort: env.ports.tlsPort, cert: env.certA, targetPort: env.ports.targetAPort }));

    const metadata = JSON.parse(readFileSync(join(env.certs.caDir, 'certs.json'), 'utf8'));
    const cert = metadata.certs.find(c => c.domains.includes(env.domains.a));
    const index = JSON.parse(readFileSync(issuedDomainIndex, 'utf8'));
    assert.deepEqual(index.domains[env.domains.a], { serials: [String(cert.serial)], status: 'valid' });

    const askAfter = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: `/_okproxy/caddy-ask?domain=${env.domains.a}`, headers: { host: '127.0.0.1' } });
    assert.equal(askAfter.statusCode, 200);
  } finally {
    await env.cleanup();
  }
});


test('runtime domain claims cannot add domains and revoked certs cannot connect', async () => {
  const env = await createMultiEnv();
  try {
    await assert.rejects(
      startVirtualClient({ tlsPort: env.ports.tlsPort, cert: env.certA, targetPort: env.ports.targetAPort, domains: [env.domains.b] }),
      /All connections failed|client connection timeout/
    );

    // The issued helper returns paths, not serial; discover serial from metadata by domain.
    const metadata = require('node:fs').readFileSync(join(env.certs.caDir, 'certs.json'), 'utf8');
    const cert = JSON.parse(metadata).certs.find(c => c.domains.includes(env.domains.revoked));
    revokeCertificate(parseInt(cert.serial, 10), env.certs.caDir);
    await assert.rejects(
      startVirtualClient({ tlsPort: env.ports.tlsPort, cert: env.certRevoked, targetPort: env.ports.targetAPort }),
      /All connections failed|client connection timeout/
    );

    const askRevoked = await httpRequest({ port: env.ports.httpPort, hostname: 'localhost', path: `/_okproxy/caddy-ask?domain=${env.domains.revoked}`, headers: { host: '127.0.0.1' } });
    assert.equal(askRevoked.statusCode, 404);
  } finally {
    await env.cleanup();
  }
});


test('cert-bound mode rejects client certificates without SAN DNS domains', async () => {
  const env = await createMultiEnv();
  try {
    const noDomainCert = issueTestClientCertificate(`no-domain-${Date.now()}`, []);
    await assert.rejects(
      startVirtualClient({ tlsPort: env.ports.tlsPort, cert: noDomainCert, targetPort: env.ports.targetAPort }),
      /All connections failed|client connection timeout/
    );
  } finally {
    await env.cleanup();
  }
});

test('CA rejects duplicate valid domain issuance by default', () => {
  getCertPaths();
  const domain = `dup-${Date.now()}-${Math.floor(Math.random() * 100000)}.example.com`;
  issueTestClientCertificate(`dup-a-${domain}`, [domain]);
  assert.throws(
    () => issueTestClientCertificate(`dup-b-${domain}`, [domain]),
    /Domain already issued/
  );
});
