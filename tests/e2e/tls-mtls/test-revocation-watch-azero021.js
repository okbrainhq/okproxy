// External (`ca` CLI) certificate revocation must evict an ESTABLISHED
// default-mode tunnel. The in-process `certificate-revoked` event only fires for
// revocations made in this process, and the `ca` CLI runs in its own process, so
// the default (non-cert-bound) pool polls the CRL (bounded, unref'd interval).
//
// Loopback only: no external services, devices, SSH or live services involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, appendFileSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const { createTLSServer } = require('../../../apps/server/lib/tls-server');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { ConnectionPool } = require('../../../apps/server/lib/connection-pool');
const { MultiClientManager } = require('../../../apps/server/lib/multi-client-manager');
const { VirtualSocket } = require('../../../apps/client/lib/virtual-socket');
const { createProxy } = require('../../../apps/client/lib/proxy');
const { initCA, issueServerCertificate, issueClientCertificate } = require('../../../apps/server/lib/ca');
const { FrameType, encodeFrame } = require('../../../packages/frame-protocol');
const { VERSION, CAPABILITY, nonce } = require('../../../packages/frame-protocol/transport-session');
const { parseArgs: parseServerArgs } = require('../../../apps/server/index.js');
const { createMockTarget } = require('./mock-target');
const { getPort, httpRequest } = require('./setup');

const CA_CLI = join(__dirname, '../../../apps/server/bin/tunnel-ca.js');
const WATCH_INTERVAL_MS = 25;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, label, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timeout: ' + label);
    await delay(10);
  }
}

/** Throwaway CA + certs so this file never pollutes the shared suite CA. */
function makeCerts() {
  const base = mkdtempSync(join(tmpdir(), 'revocation-watch-'));
  const caDir = join(base, 'ca');
  const serverDir = join(base, 'server');
  const clientDir = join(base, 'client');
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  initCA(caDir);
  issueServerCertificate('localhost', serverDir, caDir);
  const client = issueClientCertificate(clientDir, caDir);
  return {
    base,
    caDir,
    serverKey: join(serverDir, 'server-key.pem'),
    serverCert: join(serverDir, 'server-cert.pem'),
    caCert: join(caDir, 'ca-cert.pem'),
    clientKey: join(clientDir, 'client-key.pem'),
    clientCert: join(clientDir, 'client-cert.pem'),
    clientCa: join(clientDir, 'ca-cert.pem'),
    clientSerial: client.serial
  };
}

/** Real loopback default-mode server + tunnel client (proxying the mock target). */
async function startEnv({ revocationWatch, intervalMs = WATCH_INTERVAL_MS } = {}) {
  const certs = makeCerts();
  const tlsPort = await getPort();
  const httpPort = await getPort();
  const targetPort = await getPort();

  const connectionPool = new ConnectionPool({
    caDir: certs.caDir,
    revocationWatch,
    revocationWatchIntervalMs: intervalMs
  });
  const tlsServer = createTLSServer(connectionPool, {
    serverKey: certs.serverKey,
    serverCert: certs.serverCert,
    caCert: certs.caCert,
    caDir: certs.caDir,
    maxConcurrentStreams: 100,
    streamTimeout: 30000
  });
  const httpServer = createHTTPServer(connectionPool, tlsServer, {
    maxConcurrentStreams: 100,
    streamTimeout: 30000
  });

  const target = createMockTarget();
  let heldRequestStarted = false;
  target.removeAllListeners('request');
  target.on('request', (req, res) => {
    // /hold stays open forever: the stream remains registered/in-flight.
    if (req.url.split('?')[0] === '/hold') { heldRequestStarted = true; return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK');
  });

  await Promise.all([
    new Promise(r => tlsServer.listen(tlsPort, r)),
    new Promise(r => httpServer.listen(httpPort, r)),
    new Promise(r => target.listen(targetPort, r))
  ]);

  let vs = null;
  let proxy = null;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('client connection timeout')), 5000);
    vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: tlsPort,
      clientKey: certs.clientKey,
      clientCert: certs.clientCert,
      caCert: certs.clientCa
    });
    vs.on('ready', () => {
      clearTimeout(timeout);
      proxy = createProxy(vs, targetPort, 'localhost', 100);
      resolve();
    });
    vs.on('frame', frame => proxy && proxy.handleFrame(frame));
    vs.on('error', err => { clearTimeout(timeout); reject(err); });
    vs.start();
  });

  return {
    certs,
    ports: { tlsPort, httpPort, targetPort },
    connectionPool,
    tlsServer,
    httpServer,
    target,
    isHeldRequestStarted: () => heldRequestStarted,
    /** Revoke in a separate process: the in-process CA event must NOT fire. */
    revokeViaCli() {
      execFileSync(
        process.execPath,
        [CA_CLI, 'revoke', '--serial', String(certs.clientSerial), '--ca-dir', certs.caDir],
        { stdio: 'pipe' }
      );
    },
    async closeServers() {
      if (proxy) { try { proxy.destroy(); } catch { /* ignore */ } proxy = null; }
      if (vs) { try { vs.destroy(); } catch { /* ignore */ } vs = null; }
      target.forceCloseAllSockets?.();
      await Promise.all([
        new Promise(r => tlsServer.close(r)),
        new Promise(r => httpServer.close(r)),
        new Promise(r => target.close(r))
      ]);
    },
    async cleanup() {
      await this.closeServers();
      rmSync(certs.base, { recursive: true, force: true });
    }
  };
}

/** True only if the server accepts and answers INIT (proves auth was accepted). */
function isAcceptedByServer(certs, port) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const socket = tls.connect({
      host: 'localhost',
      port,
      key: readFileSync(certs.clientKey),
      cert: readFileSync(certs.clientCert),
      ca: readFileSync(certs.caCert),
      servername: 'localhost'
    });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    timer = setTimeout(() => done(false), 3000);
    socket.on('secureConnect', () => socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
      version: VERSION, capability: CAPABILITY, clientSession: nonce()
    }))));
    socket.on('data', () => done(true));
    socket.on('error', () => done(false));
    socket.on('close', () => done(false));
  });
}

test('external ca CLI revoke evicts an established default-mode tunnel within the interval', { timeout: 20000 }, async () => {
  const env = await startEnv({ revocationWatch: true });
  let pending = null;
  try {
    const pool = env.connectionPool;
    assert.deepEqual(env.tlsServer.activeSerials().length, 1, 'one authenticated serial');
    assert.ok(pool.revocationWatchTimer, 'default-mode pool must arm the CRL watcher');
    assert.equal(pool.count, 1);
    const lane = [...pool.connections.values()][0];

    // In-flight public request: target accepted it and never responds.
    pending = httpRequest({ hostname: 'localhost', port: env.ports.httpPort, path: '/hold' }).then(r => r, e => e);
    await until(() => env.isHeldRequestStarted(), 'allocated in-flight request');
    assert.equal(pool.activeStreams.size, 1);

    env.revokeViaCli();
    assert.match(readFileSync(join(env.certs.caDir, 'crl.txt'), 'utf8'),
      new RegExp(`^${env.certs.clientSerial}$`, 'm'), 'CLI must have written the CRL');

    const startedAt = Date.now();
    await until(() => pool.count === 0 && pool.activeStreams.size === 0, 'revoked tunnel terminated', 3000);
    assert.ok(Date.now() - startedAt < 2000, 'eviction must be bounded by the poll interval, not the next handshake');
    assert.equal(lane.destroyed, true, 'revoked lane socket must be destroyed');
    assert.equal(pool.transport.bytes, 0, 'transport state must be released');

    const result = await pending;
    pending = null;
    assert.ok(result instanceof Error || result.statusCode === 502, 'in-flight request must fail, not hang');

    // New public requests are unavailable while nothing is connected.
    const after = await httpRequest({ hostname: 'localhost', port: env.ports.httpPort, path: '/json' });
    assert.equal(after.statusCode, 502);

    // New handshakes with the revoked certificate are rejected too.
    assert.equal(await isAcceptedByServer(env.certs, env.ports.tlsPort), false);
  } finally {
    if (pending) { try { await pending; } catch { /* ignore */ } }
    await env.cleanup();
  }
});

test('revocationWatch:false (--no-revocation-watch) leaves an established tunnel serving', { timeout: 20000 }, async () => {
  const env = await startEnv({ revocationWatch: false });
  try {
    const pool = env.connectionPool;
    assert.equal(pool.revocationWatchTimer, null, 'opt-out must not arm a watcher');
    const lane = [...pool.connections.values()][0];

    env.revokeViaCli();
    await delay(300); // many would-be poll intervals

    assert.equal(pool.revocationWatchTimer, null, 'no watcher is created by the CRL change');
    assert.equal(pool.count, 1, 'existing tunnel must not be evicted without a watcher');
    assert.equal(lane.destroyed, false);
    const served = await httpRequest({ hostname: 'localhost', port: env.ports.httpPort, path: '/json' });
    assert.equal(served.statusCode, 200, 'opt-out is explicit: no polling, no eviction');
  } finally {
    await env.cleanup();
  }
});

test('watcher lifecycle: dispose and tlsServer.close both stop CRL polling', { timeout: 15000 }, async () => {
  const env = await startEnv({ revocationWatch: true });
  try {
    assert.ok(env.connectionPool.revocationWatchTimer);
    env.connectionPool.dispose();
    assert.equal(env.connectionPool.revocationWatchTimer, null, 'dispose must stop the watcher');
    env.connectionPool.dispose(); // idempotent
    env.connectionPool.startRevocationWatch(WATCH_INTERVAL_MS);
    assert.ok(env.connectionPool.revocationWatchTimer);

    await env.closeServers();
    assert.equal(env.connectionPool.revocationWatchTimer, null, 'tlsServer.close must stop pool CRL polling');
  } finally {
    await env.cleanup();
  }
});

test('cert-bound mode keeps exactly one watcher; session pools never arm a duplicate', { timeout: 15000 }, async () => {
  const certs = makeCerts();
  const manager = new MultiClientManager({
    caDir: certs.caDir,
    issuedDomainIndex: join(certs.caDir, 'issued-domains.json'),
    revocationWatch: true,
    revocationWatchIntervalMs: WATCH_INTERVAL_MS
  });
  const tlsServer = createTLSServer(manager, {
    serverKey: certs.serverKey,
    serverCert: certs.serverCert,
    caCert: certs.caCert,
    caDir: certs.caDir,
    certBoundDomains: true
  });
  const port = await getPort();
  await new Promise(r => tlsServer.listen(port, r));
  try {
    const timer = manager.revocationWatchTimer;
    assert.ok(timer, 'the manager owns the single cert-bound watcher');

    // Inner pool of a ClientSession: must never start its own interval.
    const sessionPool = new ConnectionPool({ clientSerial: 'A', maxTrackedStreams: 10 });
    assert.equal(sessionPool.revocationWatchTimer, null);

    assert.equal(manager.revocationWatchTimer, timer, 'tls-server must not add a second watcher');
    await new Promise(r => tlsServer.close(r));
    assert.equal(manager.revocationWatchTimer, null, 'server close stops the single watcher');
  } finally {
    manager.dispose();
    rmSync(certs.base, { recursive: true, force: true });
  }
});

test('CRL polling only evicts exact decimal-normalized CRL matches', () => {
  const dirs = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'crl-normalize-'));
    dirs.push(dir);
    return dir;
  };
  const withCrl = (lines) => {
    const dir = makeDir();
    writeFileSync(join(dir, 'crl.txt'), lines.map(s => `${s}\n`).join(''), { mode: 0o600 });
    return dir;
  };
  const pool = (serial, caDir) => {
    const p = new ConnectionPool({ clientSerial: serial, caDir });
    const socket = { destroyed: false, destroy() { this.destroyed = true; } };
    // Only register a lane when the serial is usable, so 'add' rejection is visible.
    if (serial) assert.equal(p.add(serial, 'iface', socket), true);
    return { p, socket };
  };

  try {
    // CRL decimal 16 -> cert serialNumber is hex "10". No false positive on 10.
    const ca16 = withCrl(['16']);
    const hex16 = pool('10', ca16);
    assert.equal(hex16.p.evictRevokedSessions(), 1, 'hex 10 === decimal 16 must match');
    assert.equal(hex16.p.count, 0);
    assert.equal(hex16.socket.destroyed, true);

    const dec10 = pool('A', ca16); // hex A === decimal 10
    assert.equal(dec10.p.evictRevokedSessions(), 0, 'decimal 10 must not match revoked 16');
    assert.equal(dec10.p.count, 1);
    assert.equal(dec10.socket.destroyed, false);

    // CRL decimal 10: hex "A"/"0A" match, hex "10" (decimal 16) must not.
    const ca10 = withCrl(['10']);
    assert.equal(pool('A', ca10).p.evictRevokedSessions(), 1);
    assert.equal(pool('0A', ca10).p.evictRevokedSessions(), 1);
    const noFalsePositive = pool('10', ca10);
    assert.equal(noFalsePositive.p.evictRevokedSessions(), 0, 'decimal 10 vs hex 10 (decimal 16)');
    assert.equal(noFalsePositive.socket.destroyed, false);

    // Malformed/absent input permits authorization: evicts nothing, never throws
    // (inherited isRevoked() storage limitation, not a fail-closed guarantee).
    const missingCrl = makeDir();
    assert.equal(pool('A', missingCrl).p.evictRevokedSessions(), 0);
    const junkCrl = withCrl(['not-a-serial']);
    assert.equal(pool('A', junkCrl).p.evictRevokedSessions(), 0);
    assert.equal(pool('', junkCrl).p.evictRevokedSessions(), 0, 'blank serial must not be looked up');

    // Invalid intervals fall back to the documented default and stays bounded.
    const watched = new ConnectionPool({ clientSerial: 'A', caDir: junkCrl, revocationWatch: true, revocationWatchIntervalMs: 0 });
    assert.ok(watched.revocationWatchTimer);
    watched.dispose();
    assert.equal(watched.revocationWatchTimer, null);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('server CLI options: revocation watch defaults on, is interval-tunable and disableable', () => {
  const defaults = parseServerArgs([]);
  assert.equal(defaults.revocationWatch, true);
  assert.equal(defaults.revocationWatchIntervalMs, 5000);
  assert.equal(parseServerArgs(['--no-revocation-watch']).revocationWatch, false);
  assert.equal(parseServerArgs(['--revocation-watch-interval', '250']).revocationWatchIntervalMs, 250);
});
