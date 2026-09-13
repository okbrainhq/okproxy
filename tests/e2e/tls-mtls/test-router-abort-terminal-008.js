// Regression tests: HTTP stream cancellation, terminal notification and
// truncated-response handling.
//
// Verified defects (http-router.js request handler):
//   1. `req.on('error')` cleaned up the stream without notifying the tunnel
//      client, leaking the target-side request.
//   2. Abort paths could notify twice (timeout + socket close) or not know they
//      had already notified.
//   3. When response headers had already been flushed, error paths did
//      `res.statusCode = 502/504; res.end('Bad Gateway')`, which silently
//      grafted the error text onto the body of the in-flight 200 response.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { once } = require('node:events');
const { request } = require('node:http');
const { startRouterHarness, httpRequest, connectBrowser } = require('./http-router-harness-008');
const { FrameType } = require('../../../packages/frame-protocol');

const HOST = 'test.local';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function rawGet({ port, path = '/', method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/** Collect a response until it ends or is torn down mid-stream. */
function collectResponse(res) {
  const state = { chunks: [], aborted: false, ended: false, error: null };
  const done = new Promise((resolve) => {
    res.on('data', (chunk) => state.chunks.push(chunk));
    res.on('aborted', () => { state.aborted = true; resolve(); });
    res.on('error', (err) => { state.error = err; state.aborted = true; resolve(); });
    res.on('end', () => { state.ended = true; resolve(); });
  });
  return {
    state,
    done,
    body: () => Buffer.concat(state.chunks).toString()
  };
}

test.describe('http-router HTTP cancellation + truncation', () => {
  test('public abort notifies the tunnel client exactly once and ignores late callbacks', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10 });
    try {
      const socket = net.connect(harness.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(`POST /abort HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 100\r\n\r\npartial-body`);

      const streamId = await harness.waitForStream();
      const handler = harness.pool.getStreamHandler(streamId);
      assert.ok(handler, 'stream handler must be registered');

      socket.destroy();
      await waitFor(() => harness.errorFrames(streamId).length === 1, 2000, 'abort notification');

      assert.equal(harness.errorFrames(streamId).length, 1, 'abort must produce exactly one ERROR frame');
      assert.match(harness.errorFrames(streamId)[0].payload.toString(), /Public (client closed connection|request error)/);
      await waitFor(() => harness.pool.activeStreams.size === 0, 2000, 'stream cleanup');

      // Late pool callbacks (delivered after cancellation) must be no-ops.
      const sentBefore = harness.pool.sent.length;
      handler.frameHandler({ streamId, type: FrameType.DATA, payload: Buffer.from('late') });
      handler.frameHandler({ streamId, type: FrameType.FIN, payload: Buffer.alloc(0) });
      handler.errorHandler(new Error('late stream error'));
      await delay(50);
      assert.equal(harness.pool.sent.length, sentBefore, 'late callbacks must not emit frames');
      assert.equal(harness.errorFrames(streamId).length, 1, 'no duplicate terminal notification');
    } finally {
      await harness.close();
    }
  });

  test('stream timeout truncates an in-flight 200 response instead of grafting the 504 body', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10, streamTimeout: 120 });
    try {
      const resPromise = rawGet({ port: harness.port, path: '/slow', headers: { host: HOST } });
      const streamId = await harness.waitForStream();
      const handler = harness.pool.getStreamHandler(streamId);

      harness.response(streamId, 200, { 'content-type': 'text/plain' });
      harness.data(streamId, Buffer.from('partial'));

      const res = await resPromise;
      const collected = collectResponse(res);
      await delay(400); // let the 120ms stream timeout fire
      await collected.done;

      assert.equal(collected.body(), 'partial', 'no error text may be appended after headers were sent');
      assert.ok(!collected.body().includes('Gateway timeout'));
      assert.ok(collected.state.aborted || !collected.state.ended, 'truncated response must be torn down');

      const errors = harness.errorFrames(streamId);
      assert.equal(errors.length, 1, 'timeout must notify exactly once');
      assert.equal(errors[0].payload.toString(), 'Stream timeout');
      await waitFor(() => harness.pool.activeStreams.size === 0, 2000, 'stream cleanup');

      const sentBefore = harness.pool.sent.length;
      handler.frameHandler({ streamId, type: FrameType.DATA, payload: Buffer.from('late') });
      await delay(30);
      assert.equal(harness.pool.sent.length, sentBefore, 'late data after cleanup must be ignored');
    } finally {
      await harness.close();
    }
  });

  test('client ERROR frame after a partial 200 truncates the response without a Bad Gateway graft', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10, streamTimeout: 30000 });
    try {
      const resPromise = rawGet({ port: harness.port, path: '/partial', headers: { host: HOST } });
      const streamId = await harness.waitForStream();

      harness.response(streamId, 200, { 'content-type': 'text/plain' });
      harness.data(streamId, Buffer.from('partial'));

      const res = await resPromise;
      const collected = collectResponse(res);
      await delay(100);
      harness.tunnelError(streamId, 'target exploded');
      await collected.done;

      assert.equal(collected.body(), 'partial');
      assert.ok(!collected.body().includes('Bad Gateway'), 'error text must not be grafted onto the 200 body');
      assert.equal(harness.errorFrames(streamId).length, 0, 'inbound terminal frame must not be answered');
      await waitFor(() => harness.pool.activeStreams.size === 0, 2000, 'stream cleanup');
    } finally {
      await harness.close();
    }
  });

  test('stream error after a partial 200 truncates the response without a Bad Gateway graft', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10, streamTimeout: 30000 });
    try {
      const resPromise = rawGet({ port: harness.port, path: '/partial-error', headers: { host: HOST } });
      const streamId = await harness.waitForStream();

      harness.response(streamId, 200, { 'content-type': 'text/plain' });
      harness.data(streamId, Buffer.from('partial'));

      const res = await resPromise;
      const collected = collectResponse(res);
      await delay(100);
      harness.streamError(streamId, new Error('client connection lost'));
      await collected.done;

      assert.equal(collected.body(), 'partial');
      assert.ok(!collected.body().includes('Bad Gateway'));
      assert.equal(harness.errorFrames(streamId).length, 0);
      await waitFor(() => harness.pool.activeStreams.size === 0, 2000, 'stream cleanup');
    } finally {
      await harness.close();
    }
  });

  test('oversized request body aborts the tunnel stream once with a clear reason', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10, maxBodySize: 8 });
    try {
      const socket = net.connect(harness.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.write(`POST /big HTTP/1.1\r\nHost: ${HOST}\r\nContent-Length: 64\r\n\r\n`);
      socket.write(Buffer.alloc(64, 0x7a));

      const streamId = await harness.waitForStream();
      await waitFor(() => harness.errorFrames(streamId).length === 1, 2000, '413 abort');

      const errors = harness.errorFrames(streamId);
      assert.equal(errors.length, 1, '413 path must notify exactly once');
      assert.equal(errors[0].payload.toString(), 'Request body too large');
      await waitFor(() => harness.pool.activeStreams.size === 0, 2000, 'stream cleanup');
      socket.destroy();
    } finally {
      await harness.close();
    }
  });

  test('router releases the allocated stream when forwarding request headers throws', async () => {
    const harness = await startRouterHarness({
      maxConcurrentStreams: 10,
      poolOptions: (() => {
        let attempts = 0;
        return { throwOn: () => { attempts++; return attempts === 1; } };
      })()
    });
    try {
      const res = await httpRequest({ port: harness.port, path: '/boom', headers: { host: HOST } });
      assert.equal(res.statusCode, 502, 'forwarding failure must answer 502');

      const allocatedId = harness.tlsServer.allocated[0];
      assert.ok(allocatedId !== undefined, 'a stream id must have been allocated');
      assert.deepEqual(harness.tlsServer.released, [allocatedId], 'stream id must be released, not leaked');
      assert.equal(harness.pool.activeStreams.size, 0);
      assert.equal(harness.pool.frames(FrameType.ERROR).length, 1, 'one terminal notification');
    } finally {
      await harness.close();
    }
  });

  test('stream table limit rejects both HTTP requests and WebSocket upgrades with 503', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 1 });
    try {
      harness.pool.activeStreams.set(9999, { frameHandler() {}, errorHandler() {} });

      const httpRes = await httpRequest({ port: harness.port, path: '/', headers: { host: HOST } });
      assert.equal(httpRes.statusCode, 503);
      assert.equal(httpRes.body, 'Max concurrent streams exceeded');

      const browser = await connectBrowser({ port: harness.port });
      await browser.waitFor((b) => b.statusLine().startsWith('HTTP/1.1 503'), 2000, 'WS 503');
      browser.destroy();

      harness.pool.activeStreams.delete(9999);
    } finally {
      await harness.close();
    }
  });
});
