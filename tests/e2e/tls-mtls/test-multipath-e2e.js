// Test: Multipath end-to-end with multiple connections
// Creates multiple connections to verify dedup and failover

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');
const { encodeFrame, FrameType, createFrameDecoder } = require('../../../packages/frame-protocol');
const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');

describe('Multipath E2E - Dedup', () => {
  it('should deduplicate frames from multiple connections', async () => {
    const env = await createTestEnv({ keepaliveInterval: 60000 });
    try {
      await env.startClient();
      const vs = env.virtualSocket();

      // Manually create a second RealSocket within the VirtualSocket
      vs._createRealSocket('virtual-en1', null);

      await new Promise(r => setTimeout(r, 500));

      assert.ok(env.connectionPool.count >= 2, 'Pool should have both connections');

      // The server duplicates frames to both connections.
      // VirtualSocket dedups — application sees each frame once.
      const res = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body.toString());
      assert.ok(data.message, 'Should get response via multipath');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Multipath E2E - Connection Failover', () => {
  it('should continue working when one connection drops', async () => {
    const env = await createTestEnv({ keepaliveInterval: 60000 });
    try {
      await env.startClient();
      const vs = env.virtualSocket();

      // Add a second connection
      vs._createRealSocket('backup-en1', null);
      await new Promise(r => setTimeout(r, 300));

      // Verify both are connected
      assert.ok(vs.isConnected());
      assert.ok(env.connectionPool.count >= 2);

      // Kill one connection
      const sockets = [...vs.realSockets.values()];
      let killed = false;
      for (const rs of sockets) {
        if (rs.socket && !rs.socket.destroyed) {
          rs.socket.destroy();
          killed = true;
          break;
        }
      }
      assert.ok(killed, 'Should have killed a connection');

      await new Promise(r => setTimeout(r, 300));

      // Request should still work through the surviving connection
      const res = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });

      assert.strictEqual(res.statusCode, 200);
      const data = JSON.parse(res.body.toString());
      assert.ok(data.message, 'Request should succeed through surviving connection');
    } finally {
      await env.cleanup();
    }
  });
});

describe('Multipath E2E - RESET_SEQ', () => {
  it('should handle RESET_SEQ frame', async () => {
    const env = await createTestEnv();
    try {
      await env.startClient();

      const socket = connect({
        port: env.ports.tlsPort,
        key: readFileSync(env.certs.clientKey),
        cert: readFileSync(env.certs.clientCert),
        ca: readFileSync(env.certs.clientCa),
        rejectUnauthorized: true
      });

      let initDone = false;
      await new Promise((resolve) => {
        socket.on('connect', () => {
          socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
            interface: 'reset-test',
            maxFrameSize: 1048576
          })));
        });
        const decoder = createFrameDecoder((frame) => {
          if (frame.streamId === 0 && frame.type === FrameType.INIT) initDone = true;
          if (frame.streamId === 0 && frame.type === FrameType.PING) {
            socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
          }
        });
        socket.on('data', decoder);
        const check = setInterval(() => {
          if (initDone) { clearInterval(check); resolve(); }
        }, 50);
      });

      assert.ok(initDone);

      // Send RESET_SEQ for a non-existent stream
      socket.write(encodeFrame(0, FrameType.RESET_SEQ, JSON.stringify({
        streams: [99999]
      })));

      await new Promise(r => setTimeout(r, 200));
      assert.ok(!socket.destroyed, 'Connection should stay alive after RESET_SEQ');

      socket.destroy();
    } finally {
      await env.cleanup();
    }
  });
});
