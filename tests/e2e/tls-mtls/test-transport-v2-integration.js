// Real TLS + HTTP integrity regressions. No external services, devices or ports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const tls = require('node:tls');
const { readFileSync } = require('node:fs');
const { createTestEnv, httpRequest } = require('./setup');
const { ConnectionPool } = require('../../../apps/server/lib/connection-pool');
const { createTLSServer } = require('../../../apps/server/lib/tls-server');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { RealSocket } = require('../../../apps/client/lib/real-socket');
const { FrameType: T, encodeFrame, createFrameDecoder } = require('../../../packages/frame-protocol');
const { VERSION, CAPABILITY, nonce } = require('../../../packages/frame-protocol/transport-session');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('Timeout: ' + label); await delay(10); }
}
function request(env, path = '/json', extra = {}) {
  return httpRequest({ hostname: 'localhost', port: env.ports.httpPort, path, method: 'GET', ...extra });
}
function replaceTarget(env, handler) {
  env.servers.mockTarget.removeAllListeners('request'); env.servers.mockTarget.on('request', handler);
}
function lanes(vs) { return [...vs.realSockets.values()]; }

test('real target never receives a successful suffix-only upload when DATA2 precedes HEADERS1', { timeout: 10000 }, async () => {
  const env = await createTestEnv(); let completed = 0, received = 0;
  replaceTarget(env, (req, res) => { req.on('data', b => received += b.length); req.on('end', () => { completed++; res.end('OK'); }); });
  try {
    await env.startClient();
    const pool = env.connectionPool; const original = pool.send.bind(pool); let intercepted = false;
    pool.send = buf => {
      if (!intercepted && buf[4] === T.HEADERS) {
        intercepted = true;
        const id = buf.readUInt32BE(0);
        // Advertise server allocation but inject the exact reviewed wire order.
        pool.transport.open(id);
        const head = Buffer.from(buf); head.writeUInt32BE(1, 5);
        const wire = Buffer.concat([encodeFrame(id, T.DATA, 'PREFIX', 2), head, encodeFrame(id, T.DATA, 'SUFFIX', 3), encodeFrame(id, T.FIN, '', 4)]);
        for (const s of pool.connections.values()) s.write(wire);
        return true;
      }
      if (intercepted && buf[4] === T.FIN) return true;
      return original(buf);
    };
    const response = await request(env, '/upload', { method: 'POST' });
    assert.equal(response.statusCode, 502); assert.equal(completed, 0); assert.equal(received, 0);
    assert.equal(env.connectionPool.activeStreams.size, 0);
  } finally { await env.cleanup(); }
});

test('real request and response bodies are byte-identical after reordered/duplicated DATA', { timeout: 10000 }, async () => {
  const env = await createTestEnv({ parallelSockets: 2 });
  const body = Buffer.from('PREFIX\u0000' + 'payload-'.repeat(32000) + 'SUFFIX');
  let targetBody;
  replaceTarget(env, (req, res) => {
    const chunks = []; req.on('data', b => chunks.push(b));
    req.on('end', () => { targetBody = Buffer.concat(chunks); res.end(targetBody); });
  });
  try {
    await env.startClient(); await until(() => env.connectionPool.count === 2, 'two lanes');
    const pool = env.connectionPool, vs = env.virtualSocket();
    const original = pool.send.bind(pool); let held = null, altered = false;
    pool.send = buf => {
      if (buf[4] !== T.DATA || altered) return original(buf);
      if (!held) { held = Buffer.from(buf); return true; }
      altered = true;
      const id = buf.readUInt32BE(0), state = pool.transport.streams.get(id);
      const first = ++state.seq; const second = ++state.seq;
      held.writeUInt32BE(first, 5); const later = Buffer.from(buf); later.writeUInt32BE(second, 5);
      for (const s of pool.connections.values()) { s.write(later); s.write(held); s.write(later); }
      return true;
    };
    const response = await request(env, '/upload', { method: 'POST', body });
    assert.equal(altered, true); assert.equal(response.statusCode, 200);
    assert.deepEqual(targetBody, body); assert.deepEqual(response.body, body);
    await until(() => pool.transport.streams.size === 0 && vs.transport.streams.size === 0, 'immediate release');
    assert.equal(pool.transport.bytes + vs.transport.bytes, 0);
  } finally { await env.cleanup(); }
});

test('HTTP 200 prefix followed by missing DATA and FIN ends as truncation, never normal success', { timeout: 10000 }, async () => {
  const env = await createTestEnv();
  replaceTarget(env, (req, res) => { res.write('PREFIX'); setTimeout(() => res.end('SUFFIX'), 50); });
  try {
    await env.startClient(); const vs = env.virtualSocket(), original = vs.write.bind(vs);
    let data = 0;
    vs.write = buf => {
      if (buf[4] === T.DATA && ++data === 2) {
        // Sender advances the sequence but drops this unique copy. FIN must not
        // leap over it and give the public client a clean chunked end.
        return vs.transport.prepare(buf);
      }
      return original(buf);
    };
    let receivedStatus = null, normalEnd = false, bytes = '';
    await new Promise((resolve, reject) => {
      const req = http.get({ hostname: 'localhost', port: env.ports.httpPort }, res => {
        receivedStatus = res.statusCode;
        res.on('data', b => bytes += b);
        res.on('end', () => { normalEnd = true; resolve(); });
        res.on('error', resolve);
      }); req.on('error', reject);
    });
    assert.equal(receivedStatus, 200); assert.equal(bytes, 'PREFIX'); assert.equal(normalEnd, false);
    assert.equal(env.connectionPool.transport.bytes, 0);
  } finally { await env.cleanup(); }
});

test('new server session reuses ID1 while old lane remains live: actual old target response cannot leak', { timeout: 15000 }, async () => {
  const env = await createTestEnv(); let oldResponse = null;
  replaceTarget(env, (req, res) => {
    if (req.url === '/old') { oldResponse = res; return; }
    res.end('NEW-SESSION-BODY');
  });
  const pool2 = new ConnectionPool();
  const server2 = createTLSServer(pool2, { ...env.certs, caCert: env.certs.caCert });
  const public2 = createHTTPServer(pool2, server2);
  await new Promise(r => server2.listen(0, 'localhost', r));
  await new Promise(r => public2.listen(0, 'localhost', r));
  try {
    await env.startClient(); const vs = env.virtualSocket();
    const old = request(env, '/old').then(r => r, e => e);
    await until(() => oldResponse, 'actual old target request');
    const oldLane = lanes(vs)[0]; assert.equal(oldLane.isConnected(), true);
    const before = vs.sessionGeneration;
    // Model reconnect reaching a fresh server process before old TCP close is
    // observable, on another local listener (no real service restart).
    const port2 = server2.address().port;
    vs.config.serverPort = port2;
    for (const rs of lanes(vs)) rs.config.serverPort = port2;
    vs._createRealSocket('new-server', null);
    await until(() => vs.sessionGeneration > before, 'wire-session fence');
    await until(() => vs.isConnected() && pool2.count === 2, 'new server lanes');
    const fresh = httpRequest({ hostname: 'localhost', port: public2.address().port, path: '/new' });
    oldResponse.end('OLD-SESSION-SECRET');
    const response = await fresh;
    assert.equal(response.statusCode, 200); assert.equal(response.body.toString(), 'NEW-SESSION-BODY');
    assert.equal(pool2.transport.known.has(1), true, 'fresh allocator really reused ID1');
    const oldResult = await old;
    assert.ok(oldResult instanceof Error || oldResult.statusCode === 502);
    assert.equal(response.body.includes(Buffer.from('OLD-SESSION-SECRET')), false);
    assert.equal(oldLane.socket?.destroyed || oldLane.clientSession === vs.clientSession, true);
  } finally {
    oldResponse?.destroy(); pool2.evictAll();
    await env.cleanup();
    await Promise.all([new Promise(r => public2.close(r)), new Promise(r => server2.close(r))]);
  }
});

test('stream pause keeps real bidirectional heartbeats and sibling traffic alive, including a late lane', { timeout: 10000 }, async () => {
  const env = await createTestEnv({ keepaliveInterval: 30, keepaliveTimeout: 300 });
  replaceTarget(env, (req, res) => { res.end('BODY'); });
  try {
    await env.startClient(); const vs = env.virtualSocket();
    for (const rs of lanes(vs)) { rs._pingInterval = 30; rs._pongTimeout = 300; rs._startKeepalive(); }
    let pausedId;
    const original = env.connectionPool._routeToHandler.bind(env.connectionPool);
    env.connectionPool._routeToHandler = f => {
      original(f);
      if (f.type === T.HEADERS && !pausedId) { pausedId = f.streamId; env.connectionPool.pauseStream(pausedId); }
    };
    const pending = request(env);
    await until(() => pausedId, 'paused response');
    vs.config.pingInterval = 30; vs.config.pongTimeout = 300;
    vs._createRealSocket('late', null);
    await until(() => env.connectionPool.count === 2, 'late lane');
    const second = await request(env); assert.equal(second.body.toString(), 'BODY');
    await delay(900); // three heartbeat deadlines, without timeout exemptions
    assert.equal(vs.sessionGeneration, 0); assert.equal(env.connectionPool.count, 2);
    for (const socket of env.connectionPool.connections.values()) assert.equal(socket.isPaused(), false);
    env.connectionPool.resumeStream(pausedId);
    assert.equal((await pending).body.toString(), 'BODY');
  } finally { await env.cleanup(); }
});

test('v2 server rejects old/malformed capabilities and v2 client rejects old ACK before ready', { timeout: 10000 }, async () => {
  const env = await createTestEnv();
  try {
    for (const hello of [{ version: 1 }, { version: VERSION, capability: CAPABILITY, clientSession: 'bad' }]) {
      let ack = false;
      const socket = tls.connect({ host: 'localhost', port: env.ports.tlsPort,
        key: readFileSync(env.certs.clientKey), cert: readFileSync(env.certs.clientCert), ca: readFileSync(env.certs.caCert) });
      socket.on('secureConnect', () => socket.write(encodeFrame(0, T.INIT, JSON.stringify(hello))));
      socket.on('data', () => ack = true); socket.on('error', () => {});
      await new Promise(r => socket.once('close', r));
      assert.equal(ack, false); assert.equal(env.connectionPool.count, 0);
    }
    const legacy = tls.createServer({ key: readFileSync(env.certs.serverKey), cert: readFileSync(env.certs.serverCert) }, s => {
      s.on('error', () => {});
      s.once('data', () => s.write(encodeFrame(0, T.INIT, JSON.stringify({ maxConcurrentStreams: 100 }))));
    });
    await new Promise(r => legacy.listen(0, 'localhost', r));
    const rs = new RealSocket({ serverHost: 'localhost', serverPort: legacy.address().port,
      clientKey: env.certs.clientKey, clientCert: env.certs.clientCert, caCert: env.certs.caCert, interfaceName: 'legacy' });
    let ready = false; rs.on('connected', () => ready = true); rs.start();
    await until(() => rs.reconnectAttempts > 0, 'incompatible ACK rejected');
    assert.equal(ready, false); rs.destroy();
    await new Promise(r => legacy.close(r));
  } finally { await env.cleanup(); }
});

test('allocated real HTTP response holds DATA2 until HEADERS1 and preserves status and every byte', { timeout: 10000 }, async () => {
  const env = await createTestEnv();
  const body = Buffer.from(Array.from({ length: 200000 }, (_, i) => i % 256));
  replaceTarget(env, (req, res) => { res.statusCode = 201; res.end(body); });
  try {
    await env.startClient(); const vs = env.virtualSocket(), original = vs.write.bind(vs);
    let held = null, reordered = false;
    vs.write = buf => {
      if (buf[4] === T.HEADERS && !reordered) {
        assert.equal(vs.transport.prepare(buf), true); held = Buffer.from(buf); return true;
      }
      if (held && buf[4] === T.DATA) {
        assert.equal(vs.transport.prepare(buf), true);
        for (const rs of lanes(vs)) { rs.write(buf); rs.write(held); rs.write(buf); }
        held = null; reordered = true; return true;
      }
      return original(buf);
    };
    const response = await request(env);
    assert.equal(reordered, true); assert.equal(response.statusCode, 201);
    assert.ok(response.body.equals(body), 'no response prefix was discarded');
  } finally { await env.cleanup(); }
});

test('real live legacy-pool CA revocation fails allocated HTTP work and releases state synchronously', { timeout: 10000 }, async () => {
  const { revokeCertificate } = require('../../../apps/server/lib/ca');
  const env = await createTestEnv(); let targetStarted = false;
  replaceTarget(env, () => { targetStarted = true; });
  try {
    await env.startClient(); const pending = request(env).then(r => r, e => e);
    await until(() => targetStarted, 'allocated target request');
    const pool = env.connectionPool;
    const state = [...pool.transport.streams.values()][0];
    pool.pauseStream(state.id);
    pool.onFrame({ streamId: state.id, type: T.DATA, seqNo: 3, payload: Buffer.from('retained') }, [...pool.connections.values()][0]);
    revokeCertificate(2, env.certs.caDir);
    assert.equal(pool.count, 0); assert.equal(pool.activeStreams.size, 0);
    assert.equal(pool.transport.bytes, 0); assert.equal(state.timer, null); assert.equal(state.window.gapTimer, null);
    const result = await pending; assert.ok(result instanceof Error || result.statusCode === 502);
  } finally { await env.cleanup(); }
});
