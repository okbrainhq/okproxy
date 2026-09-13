// Regression tests: domain-metadata crash safety, fail-closed routing, atomic
// metadata writes and certificate-revocation session eviction.
//
// Verified defects:
//   * MultiClientManager.reloadIssuedDomainIndex() threw on truncated/wrong-shape
//     issued-domains.json. Because resolveByHost() is called from inside the HTTP
//     request handler, one corrupt file turned every public request into an
//     uncaught exception.
//   * Metadata writes used plain writeFileSync (truncated file on crash).
//   * Revoking a certificate did not touch already-authenticated sessions.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, readdirSync, appendFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { MultiClientManager } = require('../../../apps/server/lib/multi-client-manager');
const { revokeCertificate } = require('../../../apps/server/lib/ca');
const { createHTTPServer } = require('../../../apps/server/lib/http-router');
const { httpRequest } = require('./http-router-harness-008');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeCA(certs = []) {
  const caDir = mkdtempSync(join(tmpdir(), 'okproxy-008-ca-'));
  writeFileSync(join(caDir, 'crl.txt'), '');
  writeFileSync(join(caDir, 'certs.json'), JSON.stringify({ version: 1, certs }, null, 2) + '\n');
  writeFileSync(join(caDir, 'issued-domains.json'), JSON.stringify({ version: 1, domains: {} }, null, 2) + '\n');
  return caDir;
}

function makeManager(caDir, extra = {}) {
  return new MultiClientManager({
    caDir,
    issuedDomainIndex: join(caDir, 'issued-domains.json'),
    maxConcurrentStreams: 10,
    ...extra
  });
}

function fakeSocket() {
  return {
    destroyed: false,
    write() { return true; },
    destroy() { this.destroyed = true; },
    setMaxListeners() {}
  };
}

function fakeCert(domain) {
  return { subjectaltname: `DNS:${domain}` };
}

function connectSession(manager, { serial, domain, socket = fakeSocket() }) {
  const result = manager.addTunnelConnection({
    serial,
    cert: fakeCert(domain),
    interfaceName: 'eth0',
    socket,
    requestedDomains: [domain]
  });
  return { result, socket };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test.describe('domain metadata crash safety + revocation eviction', () => {
  test('corrupt or wrong-shaped metadata never throws and fails closed over HTTP', async () => {
    const caDir = makeCA();
    const manager = makeManager(caDir);
    const httpServer = createHTTPServer(manager, { allocateStreamId() { return 1; }, releaseStreamId() {} }, {
      certBoundDomains: true
    });
    const port = await listen(httpServer);
    const indexPath = join(caDir, 'issued-domains.json');

    try {
      const validUnknown = await httpRequest({ port, path: '/', headers: { host: 'nope.example.com' } });
      assert.equal(validUnknown.statusCode, 404);

      const malformed = [
        '{"version":1,"domains":{',
        'null',
        '[]',
        '{"version":1,"domains":null}',
        '{"version":1,"domains":[]}',
        '{"version":1,"domains":{"a.example.com":null}}',
        '{"version":1,"domains":{"a.example.com":{"serials":"nope"}}}'
      ];

      for (const content of malformed) {
        writeFileSync(indexPath, content);
        assert.doesNotThrow(() => manager.reloadIssuedDomainIndex());
        assert.doesNotThrow(() => manager.resolveByHost('a.example.com'));
        assert.doesNotThrow(() => manager.isAskAllowed('a.example.com'));

        const res = await httpRequest({ port, path: '/', headers: { host: 'a.example.com' } });
        assert.ok(res.statusCode === 503 || res.statusCode === 404, `controlled fail-closed status, got ${res.statusCode}`);
        assert.ok(!res.requestError, 'routing must not crash the listener');
      }

      // Truncated JSON is an error state: explicit fail-closed 503 + ask deny.
      writeFileSync(indexPath, '{"version":1,"domains":{');
      manager.reloadIssuedDomainIndex();
      assert.equal(manager.issuedIndexState, 'error');
      const afterCorrupt = await httpRequest({ port, path: '/', headers: { host: 'a.example.com' } });
      assert.equal(afterCorrupt.statusCode, 503);
      assert.equal(manager.resolveByHost('a.example.com').status, 'metadata-error');
      assert.equal(manager.isAskAllowed('a.example.com'), false);

      const askCorrupt = await httpRequest({
        port,
        path: '/_okproxy/caddy-ask?domain=a.example.com',
        headers: { host: '127.0.0.1' }
      });
      assert.equal(askCorrupt.statusCode, 404, 'ask endpoint must deny while metadata is unreadable');

      // Listener still serves the next request (no process-level failure).
      const stillAlive = await httpRequest({ port, path: '/', headers: { host: 'a.example.com' } });
      assert.equal(stillAlive.statusCode, 503);
    } finally {
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(resolve));
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('unreadable index path fails closed instead of throwing', () => {
    const caDir = makeCA();
    const manager = new MultiClientManager({ caDir, issuedDomainIndex: caDir });
    try {
      assert.equal(manager.issuedIndexState, 'error');
      assert.equal(manager.isAskAllowed('a.example.com'), false);
      assert.equal(manager.resolveByHost('a.example.com').status, 'metadata-error');
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('writes the issued-domain index atomically and refuses to clobber corrupt metadata', () => {
    const caDir = makeCA();
    const manager = makeManager(caDir);
    const indexPath = join(caDir, 'issued-domains.json');
    try {
      const { result } = connectSession(manager, { serial: 'A', domain: 'a.example.com' });
      assert.equal(result.ok, true);

      const written = JSON.parse(readFileSync(indexPath, 'utf8'));
      assert.deepEqual(written.domains['a.example.com'], { serials: ['10'], status: 'valid' });
      assert.deepEqual(readdirSync(caDir).filter((file) => file.includes('.tmp-')), [], 'no temp files left behind');

      // Corrupt the file, then confirm a new connection cannot overwrite it.
      writeFileSync(indexPath, '{"version":1,"domains":{');
      const before = readFileSync(indexPath, 'utf8');
      connectSession(manager, { serial: 'B', domain: 'b.example.com' });
      assert.equal(readFileSync(indexPath, 'utf8'), before, 'unreadable metadata must be preserved, not clobbered');

      // Documented recovery path: rebuild from certs.json.
      const rebuilt = manager.rebuildIndexFromCerts();
      assert.equal(rebuilt.ok, true);
      assert.equal(manager.issuedIndexState, 'ok');
      assert.doesNotThrow(() => JSON.parse(readFileSync(indexPath, 'utf8')));
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('revoking a certificate evicts the live session via the CA event interface', () => {
    const caDir = makeCA([{ serial: '10', name: 'a', status: 'valid', issuedAt: 'x', domains: ['a.example.com'] }]);
    const manager = makeManager(caDir);
    try {
      const { result, socket } = connectSession(manager, { serial: 'A', domain: 'a.example.com' });
      assert.equal(result.ok, true);
      assert.equal(manager.resolveByHost('a.example.com').status, 'active');

      const evicted = [];
      manager.events.on('session-evicted', (event) => evicted.push(event));

      revokeCertificate(10, caDir);

      assert.equal(manager.sessionsBySerial.size, 0, 'revoked session must be removed');
      assert.equal(socket.destroyed, true, 'tunnel sockets must be destroyed so tls-server drops them');
      assert.equal(manager.resolveByHost('a.example.com').status, 'unknown');
      assert.equal(manager.isAskAllowed('a.example.com'), false);
      assert.equal(evicted.length, 1);
      assert.deepEqual(evicted[0].domains, ['a.example.com']);
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('evictRevokedSessions evicts only sessions whose serial is in the CRL', () => {
    const caDir = makeCA();
    const manager = makeManager(caDir);
    try {
      const revoked = connectSession(manager, { serial: 'B', domain: 'b.example.com' }); // hex B -> decimal 11
      const kept = connectSession(manager, { serial: 'C', domain: 'c.example.com' }); // hex C -> decimal 12
      assert.equal(revoked.result.ok, true);
      assert.equal(kept.result.ok, true);

      appendFileSync(join(caDir, 'crl.txt'), '11\n');
      assert.equal(manager.evictRevokedSessions(), 1);
      assert.equal(revoked.socket.destroyed, true);
      assert.equal(kept.socket.destroyed, false);
      assert.equal(manager.sessionsBySerial.size, 1);
      assert.equal(manager.resolveByHost('c.example.com').status, 'active');

      // Missing CRL is not an error.
      rmSync(join(caDir, 'crl.txt'), { force: true });
      assert.equal(manager.evictRevokedSessions(), 0);
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('revocation events match equivalent caDir spellings (trailing slash / relative)', () => {
    const caDir = makeCA([{ serial: '10', name: 'a', status: 'valid', issuedAt: 'x', domains: ['a.example.com'] }]);
    // Configure the manager with a non-canonical spelling of the same path.
    const manager = makeManager(`${caDir}/`);
    try {
      const { socket } = connectSession(manager, { serial: 'A', domain: 'a.example.com' });
      assert.equal(manager.sessionsBySerial.size, 1);

      revokeCertificate(10, caDir); // absolute, canonical spelling

      assert.equal(manager.sessionsBySerial.size, 0, 'equivalent path spellings must still trigger eviction');
      assert.equal(socket.destroyed, true);
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('startRevocationWatch evicts revoked sessions without tls-server changes', async () => {
    const caDir = makeCA();
    const manager = makeManager(caDir, { revocationWatch: true, revocationWatchIntervalMs: 25 });
    try {
      const { socket } = connectSession(manager, { serial: 'B', domain: 'b.example.com' });
      appendFileSync(join(caDir, 'crl.txt'), '11\n');

      await waitFor(() => manager.sessionsBySerial.size === 0, 2000, 'revocation watch eviction');
      assert.equal(socket.destroyed, true);

      manager.dispose();
      assert.equal(manager.revocationWatchTimer, null, 'dispose must stop the watcher');
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('evicting a revoked session tears down pool state and fails in-flight streams', () => {
    const caDir = makeCA([{ serial: '10', name: 'a', status: 'valid', issuedAt: 'x', domains: ['a.example.com'] }]);
    const manager = makeManager(caDir);
    try {
      const { socket } = connectSession(manager, { serial: 'A', domain: 'a.example.com' });
      const session = manager.sessionsBySerial.get('A');
      assert.ok(session, 'session must be registered');
      const pool = session.pool;

      // Simulate two concurrent public requests the router has registered.
      const failures = [];
      for (const streamId of [7, 8]) {
        pool.registerStream(streamId, {
          frameHandler() {},
          errorHandler(err) { failures.push(err.message); }
        });
      }
      assert.equal(pool.activeStreams.size, 2);
      assert.equal(pool.connections.size, 1);

      revokeCertificate(10, caDir);

      assert.equal(manager.sessionsBySerial.size, 0, 'session must be removed');
      assert.equal(pool.connections.size, 0, 'pool must drop the tunnel connection entry (no leak)');
      assert.equal(pool.activeStreams.size, 0, 'in-flight stream handlers must be cleared');
      assert.equal(failures.length, 2, 'in-flight public requests must be failed, not left hanging');
      assert.equal(socket.destroyed, true);
      assert.equal(session.evicted, true);
      assert.equal(manager.resolveByHost('a.example.com').status, 'unknown');

      // tls-server's async 'close' handler runs after eviction. It must be a
      // harmless no-op (previously it was the only teardown path, and it could
      // no longer find the session).
      assert.doesNotThrow(() => manager.removeTunnelConnection(socket));
      assert.equal(pool.connections.size, 0);
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });

  test('evict() uses the transport pool.evictAll hook when present and survives a broken hook', () => {
    const caDir = makeCA([{ serial: '10', name: 'a', status: 'valid', issuedAt: 'x', domains: ['a.example.com'] }]);
    const manager = makeManager(caDir);
    try {
      const { socket } = connectSession(manager, { serial: 'A', domain: 'a.example.com' });
      const session = manager.sessionsBySerial.get('A');
      const pool = session.pool;

      const calls = [];
      pool.evictAll = (reason) => { calls.push(reason); throw new Error('transport hook exploded'); };
      const failures = [];
      pool.registerStream(9, { frameHandler() {}, errorHandler(err) { failures.push(err.message); } });

      revokeCertificate(10, caDir);

      assert.deepEqual(calls, ['certificate revoked'], 'feature-detected evictAll must be invoked');
      assert.equal(pool.connections.size, 0, 'fallback teardown must still drop connections');
      assert.equal(pool.activeStreams.size, 0, 'fallback teardown must still clear streams');
      assert.equal(failures.length, 1, 'in-flight stream must still be failed');
      assert.equal(socket.destroyed, true);
    } finally {
      manager.dispose();
      rmSync(caDir, { recursive: true, force: true });
    }
  });
});
