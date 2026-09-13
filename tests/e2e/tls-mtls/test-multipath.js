const { VERSION, CAPABILITY, nonce } = require('../../../packages/frame-protocol/transport-session');
// Test: Multipath VirtualSocket and DedupWindow
// Tests the dedup window, multiple connections, and connection pool

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DedupWindow, FrameType, encodeFrame } = require('../../../packages/frame-protocol');
const { shouldSkip } = require('../../../apps/client/lib/interface-detector');
const { createTestEnv, httpRequest, getCertPaths } = require('./setup');
const { VirtualSocket } = require('../../../apps/client/lib/virtual-socket');
const { ConnectionPool } = require('../../../apps/server/lib/connection-pool');

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
            version: VERSION, capability: CAPABILITY, clientSession: env.virtualSocket().clientSession,
            interface: 'en1',
            maxFrameSize: 1048576
          })));
          resolve();
        });
      });

      await new Promise(r => setTimeout(r, 200));

      // Both connections should be registered
      assert.equal(env.connectionPool.count, 2, 'Both compatible lanes must be registered');
      
      socket2.destroy();
    } finally {
      await env.cleanup();
    }
  });

  it('should reject replacement of a still-live interface', async () => {
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
            version: VERSION, capability: CAPABILITY, clientSession: env.virtualSocket().clientSession,
            interface: 'default',
            maxFrameSize: 1048576
          })));
          resolve();
        });
      });

      await new Promise(r => setTimeout(r, 200));

      // The new connection should replace the old one for same interface
      const count2 = env.connectionPool.count;
      assert.equal(count2, count1, 'live lane was not replaced');
      assert.ok(socket2.destroyed, 'duplicate interface must be rejected');

      socket2.destroy();
    } finally {
      await env.cleanup();
    }
  });
});

describe('Path-selected single-flow streams', () => {
  function fakeSocket(label) {
    return {
      label,
      destroyed: false,
      writableNeedDrain: false,
      writes: [],
      write(buf) {
        this.writes.push(buf);
        return true;
      },
      once() {},
      removeListener() {},
      pause() { this.paused = true; },
      resume() { this.paused = false; }
    };
  }

  it('server pool should broadcast normal streams and pin single-flow streams', () => {
    const pool = new ConnectionPool();
    const a = fakeSocket('a');
    const b = fakeSocket('b');
    pool.add('serial', 'lane-a', a);
    pool.add('serial', 'lane-b', b);

    pool.send(encodeFrame(1, FrameType.HEADERS, '{}'));
    pool.send(encodeFrame(1, FrameType.DATA, Buffer.from('normal-stream')));

    assert.strictEqual(a.writes.length, 2, 'normal stream should write to lane a');
    assert.strictEqual(b.writes.length, 2, 'normal stream should write to lane b');

    pool.setStreamMode(2, { singleFlow: true });
    pool.send(encodeFrame(2, FrameType.HEADERS, '{}'));
    pool.send(encodeFrame(2, FrameType.DATA, Buffer.from('single-flow-stream')));

    const singleFlowWrites = [a.writes.length - 2, b.writes.length - 2];
    assert.deepStrictEqual(singleFlowWrites.sort((x, y) => x - y), [0, 2], 'single-flow stream should use exactly one lane');
  });

  it('client virtual socket should broadcast normal streams and pin single-flow streams', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none',
      parallelSockets: 2
    });
    const a = { isConnected: () => true, socket: { writableNeedDrain: false }, writes: [], write(buf) { this.writes.push(buf); return true; } };
    const b = { isConnected: () => true, socket: { writableNeedDrain: false }, writes: [], write(buf) { this.writes.push(buf); return true; } };
    vs.realSockets.set('default#1', a);
    vs.realSockets.set('default#2', b);
    vs.serverSession = nonce(); vs._sessionActive = true;
    for (const rs of [a, b]) { rs.clientSession = vs.clientSession; rs.serverSession = vs.serverSession; }
    vs.transport.open(1); vs.transport.open(2);

    vs.write(encodeFrame(1, FrameType.HEADERS, '{}'));
    vs.write(encodeFrame(1, FrameType.DATA, Buffer.from('normal-stream')));

    assert.strictEqual(a.writes.length, 2, 'normal stream should write to first socket');
    assert.strictEqual(b.writes.length, 2, 'normal stream should write to second socket');

    vs.setStreamMode(2, { singleFlow: true });
    vs.write(encodeFrame(2, FrameType.HEADERS, '{}'));
    vs.write(encodeFrame(2, FrameType.DATA, Buffer.from('single-flow-stream')));

    const singleFlowWrites = [a.writes.length - 2, b.writes.length - 2];
    assert.deepStrictEqual(singleFlowWrites.sort((x, y) => x - y), [0, 2], 'single-flow stream should use exactly one socket');
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

// Bug-fix regression tests

// v2 ordering, cancellation and no-wrap regressions replace unsafe legacy
// FIN-without-OPEN and RESET-as-recovery assertions.
// See tests/unit/test-transport-v2.js (included by run-all).

describe('Bugfix: ready emitted once (Bug 4)', () => {
  it('should emit ready only once', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none'
    });

    let readyCount = 0;
    vs.on('ready', () => readyCount++);

    // Simulate multiple connections coming up
    vs._checkReady(); // no connected sockets yet → no emit
    assert.strictEqual(readyCount, 0);

    // Add a connected socket
    vs.serverSession = nonce(); vs._sessionActive = true;
    const fakeRS = { isConnected: () => true, clientSession: vs.clientSession, serverSession: vs.serverSession };
    vs.realSockets.set('en0', fakeRS);

    vs._checkReady();
    assert.strictEqual(readyCount, 1, 'first call with connection should emit');

    // Add another socket
    vs.realSockets.set('en8', fakeRS);
    vs._checkReady();
    assert.strictEqual(readyCount, 1, 'second call should not emit again');
  });
});

describe('Bugfix: multipath network-change handling', () => {
  it('should recreate a socket when an interface keeps the same name but changes IP', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none'
    });

    let createCount = 0;
    vs._createRealSocket = (name, ip) => {
      createCount++;
      const fakeRS = {
        config: { localAddress: ip },
        destroyed: false,
        isConnected: () => true,
        destroy() { this.destroyed = true; }
      };
      vs.realSockets.set(name, fakeRS);
    };

    vs._syncInterfaces([{ name: 'en0', ip: '192.168.1.10' }]);
    const oldSocket = vs.realSockets.get('en0');

    vs._syncInterfaces([{ name: 'en0', ip: '10.0.0.20' }]);
    const newSocket = vs.realSockets.get('en0');

    assert.strictEqual(createCount, 2, 'IP change should create a replacement socket');
    assert.ok(oldSocket.destroyed, 'old IP-bound socket should be destroyed');
    assert.notStrictEqual(newSocket, oldSocket, 'socket should be replaced');
    assert.strictEqual(newSocket.config.localAddress, '10.0.0.20');
  });

  it('should remove a disappeared interface immediately', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none'
    });

    vs._createRealSocket = (name, ip) => {
      const fakeRS = {
        config: { localAddress: ip },
        destroyed: false,
        isConnected: () => true,
        destroy() { this.destroyed = true; }
      };
      vs.realSockets.set(name, fakeRS);
    };

    vs._syncInterfaces([{ name: 'en0', ip: '192.168.1.10' }]);
    const oldSocket = vs.realSockets.get('en0');

    vs._syncInterfaces([]);

    assert.ok(oldSocket.destroyed, 'disappeared interface socket should be destroyed');
    assert.strictEqual(vs.realSockets.has('en0'), false, 'disappeared interface should be removed');
    assert.strictEqual(vs._failureCount.has('en0'), false, 'stale failure count should be cleared');
  });
});

describe('Bugfix: NetworkWatchDog in single-connection mode', () => {
  it('should start NetworkWatchDog when multipath is disabled', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none'
    });

    // Bypass start() — manually simulate what it does
    vs._createRealSocket = () => {}; // suppress actual socket creation

    vs.start();

    assert.ok(vs.networkWatchdog !== null, 'NetworkWatchDog should be created');
    assert.ok(vs.detector === null, 'InterfaceDetector should NOT be created');

    vs.destroy();
  });

  it('should start InterfaceDetector when multipath is enabled', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none'
    });

    vs._createRealSocket = () => {}; // suppress actual socket creation

    process.env.MULTIPATH_ENABLED = 'true';
    vs.start();

    // Stop detector immediately to prevent probe hangs
    if (vs.detector) vs.detector.stop();

    assert.ok(vs.detector !== null, 'InterfaceDetector should be created');
    assert.ok(vs.networkWatchdog === null, 'NetworkWatchDog should NOT be created');

    vs.destroy();
    delete process.env.MULTIPATH_ENABLED;
  });

  it('should destroy socket on network change', () => {
    const vs = new VirtualSocket({
      serverHost: 'localhost',
      serverPort: 9999,
      clientKey: 'none',
      clientCert: 'none',
      caCert: 'none'
    });

    vs._createRealSocket = () => {}; // suppress
    vs.start();

    const fakeSocket = { destroyed: false };
    fakeSocket.destroy = () => { fakeSocket.destroyed = true; };
    vs.realSockets.set('default', { socket: fakeSocket, destroy() {} });

    vs.networkWatchdog.onChange();

    assert.ok(fakeSocket.destroyed, 'Socket should be destroyed on network change');

    vs.destroy();
  });
});
