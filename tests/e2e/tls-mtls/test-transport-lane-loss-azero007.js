// E2E transport regression: lane loss, session reset and recovery
// (workspace okproxy-azero/007). Uniquely named to avoid collisions.
//
// Validates that:
//  - losing every lane advances the virtual session generation exactly once
//  - an in-flight public request does not hang forever when the lane dies
//  - after reconnect, new requests are served with intact stream state
//    (no cross-session stream-ID corruption)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createTestEnv, httpRequest } = require('./setup');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function killAllLanes(vs) {
  for (const rs of vs.realSockets.values()) {
    if (rs.socket && !rs.socket.destroyed) rs.socket.destroy();
  }
}

describe('Transport lane-loss recovery', () => {
  it('advances the session generation once and serves traffic after reconnect', async () => {
    const env = await createTestEnv();
    try {
      await env.startClient();
      const vs = env.virtualSocket();

      const first = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      assert.strictEqual(first.statusCode, 200);

      const generationBefore = vs.sessionGeneration;
      killAllLanes(vs);

      await waitFor(() => vs.sessionGeneration > generationBefore, 5000, 'session generation bump');
      assert.strictEqual(vs.sessionGeneration, generationBefore + 1, 'generation advances exactly once');

      await waitFor(() => vs.isConnected(), 8000, 'lane reconnect');

      const second = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      assert.strictEqual(second.statusCode, 200, 'traffic served after reconnect');
      assert.ok(JSON.parse(second.body.toString()).message, 'response body intact');
    } finally {
      await env.cleanup();
    }
  });

  it('does not hang an in-flight request when the lane dies mid-stream', async () => {
    const env = await createTestEnv({ mockTarget: { slowDelay: 120, slowChunks: 20 } });
    try {
      await env.startClient();
      const vs = env.virtualSocket();

      const inflight = httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/slow',
        method: 'GET'
      }).then(
        () => ({ settled: true, ok: true }),
        () => ({ settled: true, ok: false })
      );

      // Let the response start streaming, then kill the only lane.
      await delay(200);
      killAllLanes(vs);

      const settled = await Promise.race([
        inflight,
        delay(5000).then(() => ({ settled: false }))
      ]);
      assert.ok(settled.settled, 'in-flight request must settle (not hang) after lane loss');
      assert.strictEqual(settled.ok, false, 'partial 200 must be truncated, not end normally');

      await waitFor(() => vs.isConnected(), 10000, 'lane reconnect');

      const after = await httpRequest({
        hostname: 'localhost',
        port: env.ports.httpPort,
        path: '/json',
        method: 'GET'
      });
      assert.strictEqual(after.statusCode, 200, 'follow-up request succeeds');
    } finally {
      await env.cleanup();
    }
  });

  it('keeps large bodies intact across a lane loss', async () => {
    const env = await createTestEnv();
    try {
      await env.startClient();
      const vs = env.virtualSocket();

      killAllLanes(vs);
      await waitFor(() => vs.isConnected(), 10000, 'lane reconnect');

      const body = Buffer.from(JSON.stringify({ integrity: 'ok', data: 'x'.repeat(2 * 1024 * 1024) }));
      const post = await httpRequest({
        hostname: 'localhost', port: env.ports.httpPort, path: '/echo', method: 'POST', body
      });
      assert.strictEqual(post.statusCode, 200);
      assert.ok(Buffer.from(JSON.parse(post.body).body, 'base64').equals(body), 'all 2MiB+ body bytes must survive reconnect');
    } finally {
      await env.cleanup();
    }
  });
});
