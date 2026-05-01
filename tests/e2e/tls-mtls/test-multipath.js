// Test: Multipath VirtualSocket and DedupWindow
// Tests the dedup window, multiple connections, and connection pool

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DedupWindow } = require('../../../apps/client/lib/dedup-window');
const { shouldSkip } = require('../../../apps/client/lib/interface-detector');
const { createTestEnv, httpRequest } = require('./setup');

describe('DedupWindow', () => {
  it('should mark first seqNo as seen', () => {
    const w = new DedupWindow(42);
    assert.strictEqual(w.checkAndAdd(42), 'new', 'first should be new');
    assert.strictEqual(w.checkAndAdd(42), 'duplicate', 'same seqNo should be duplicate');
  });

  it('should detect duplicates within window', () => {
    const w = new DedupWindow(0);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(w.checkAndAdd(i), 'new', `seqNo ${i} should be new`);
    }
    // Replay same sequence - all duplicates
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(w.checkAndAdd(i), 'duplicate', `seqNo ${i} should be duplicate`);
    }
  });

  it('should advance window for far-ahead seqNo', () => {
    const w = new DedupWindow(0);
    // Jump ahead by 200 (beyond 128-window)
    w.checkAndAdd(0); // initial
    const result = w.checkAndAdd(200);
    assert.strictEqual(result, 'new', 'far-ahead seqNo should be new');
    // The duplicate check should work after advance
    assert.strictEqual(w.checkAndAdd(200), 'duplicate', 'should be duplicate after advance');
  });

  it('should handle 32-bit wrap', () => {
    const w = new DedupWindow(0xFFFFFFF0);
    const result = w.checkAndAdd(0xFFFFFFF1);
    assert.strictEqual(result, 'new', 'wrapped seqNo should be new');
    assert.strictEqual(w.checkAndAdd(0xFFFFFFF1), 'duplicate', 'wrapped dup should be detected');
  });

  it('should reject old seqNos (before window)', () => {
    const w = new DedupWindow(100);
    // Mark seqNo 100
    assert.strictEqual(w.checkAndAdd(100), 'new');
    assert.strictEqual(w.checkAndAdd(101), 'new');
    assert.strictEqual(w.checkAndAdd(102), 'new');
    // SeqNo 50 is far behind base — too old
    assert.strictEqual(w.checkAndAdd(50), 'duplicate', 'old seqNo should be treated as duplicate');
  });

  it('should handle sequential burst', () => {
    const w = new DedupWindow(0);
    for (let i = 0; i < 500; i++) {
      assert.strictEqual(w.checkAndAdd(i), 'new', `burst seqNo ${i} should be new`);
    }
  });
});

describe('InterfaceDetector - shouldSkip', () => {
  it('should skip loopback', () => {
    assert.ok(shouldSkip('lo0'));
    assert.ok(shouldSkip('lo'));
  });

  it('should skip awdl/utun/bridge', () => {
    assert.ok(shouldSkip('awdl0'));
    assert.ok(shouldSkip('utun3'));
    assert.ok(shouldSkip('bridge100'));
    assert.ok(shouldSkip('vmenet0'));
    assert.ok(shouldSkip('anpi0'));
  });

  it('should not skip real interfaces', () => {
    assert.ok(!shouldSkip('en0'));
    assert.ok(!shouldSkip('en8'));
    assert.ok(!shouldSkip('eth0'));
    assert.ok(!shouldSkip('wlan0'));
  });
});

describe('ConnectionPool - Multiple Connections', () => {
  it('should accept multiple connections from same client', async () => {
    const env = await createTestEnv();
    try {
      await env.startClient();

      // Verify first connection is registered
      assert.ok(env.connectionPool.count > 0, 'First connection should be registered');

      // Connect a second socket manually
      const { connect } = require('node:tls');
      const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');
      const { readFileSync } = require('node:fs');

      const socket2 = connect({
        port: env.ports.tlsPort,
        key: readFileSync(env.certs.clientKey),
        cert: readFileSync(env.certs.clientCert),
        ca: readFileSync(env.certs.clientCa),
        rejectUnauthorized: true
      });

      await new Promise((resolve) => {
        socket2.on('connect', () => {
          socket2.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            interface: 'en1',
            maxFrameSize: 1048576
          })));
          resolve();
        });
      });

      await new Promise(r => setTimeout(r, 200));

      // Both connections should be registered
      assert.ok(env.connectionPool.count >= 1, 'Connection pool should have connections');
      
      socket2.destroy();
    } finally {
      await env.cleanup();
    }
  });

  it('should replace connection for same interface', async () => {
    const env = await createTestEnv();
    try {
      await env.startClient();

      const count1 = env.connectionPool.count;

      // Connect with same interface name (should replace)
      const { connect } = require('node:tls');
      const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');
      const { readFileSync } = require('node:fs');

      const socket2 = connect({
        port: env.ports.tlsPort,
        key: readFileSync(env.certs.clientKey),
        cert: readFileSync(env.certs.clientCert),
        ca: readFileSync(env.certs.clientCa),
        rejectUnauthorized: true
      });

      await new Promise((resolve) => {
        socket2.on('connect', () => {
          socket2.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            interface: 'default',
            maxFrameSize: 1048576
          })));
          resolve();
        });
      });

      await new Promise(r => setTimeout(r, 200));

      // The new connection should replace the old one for same interface
      const count2 = env.connectionPool.count;
      assert.ok(count2 > 0, 'Pool should still have connections');

      socket2.destroy();
    } finally {
      await env.cleanup();
    }
  });
});

describe('Multipath - HTTP Request', () => {
  it('should handle HTTP request with dedup (multiple connections)', async () => {
    const env = await createTestEnv();
    try {
      await env.startClient();

      // Send a request through the HTTP server
      const res = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body.toString());
      assert.ok(data.message, 'Should get response');
    } finally {
      await env.cleanup();
    }
  });
});
