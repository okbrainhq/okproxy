// Regression tests: browser -> target WebSocket frames buffered in the router
// must resume after tunnel backpressure drains.
//
// Verified defect (http-router.js processBrowserData/sendLargeFrameChunk): when
// pool.write() returned false, the router paused the browser socket and waited
// for 'drain', but never resumed processing the frames it had already buffered.
// Any frame that arrived in the same TCP chunk (or any frame after an oversized
// frame) stayed stranded until new socket data happened to arrive.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startRouterHarness, connectBrowser, buildClientFrame } = require('./http-router-harness-008');
const { FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

const ACCEPT = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': 'test-accept' };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openUpgradedSocket(harness) {
  const browser = await connectBrowser({ port: harness.port });
  const streamId = await harness.waitForStream();
  harness.upgradeResponse(streamId, 101, ACCEPT);
  await browser.waitFor((b) => b.statusLine().startsWith('HTTP/1.1 101'), 2000, '101 response');
  return { browser, streamId };
}

test.describe('http-router WS output pump', () => {
  test('resumes buffered frames after the tunnel drain event', async () => {
    let dataSent = 0;
    const harness = await startRouterHarness({
      maxConcurrentStreams: 10,
      poolOptions: {
        sendVerdict: (frame) => {
          if (frame.type === FrameType.DATA) {
            dataSent++;
            if (dataSent === 2) return false; // simulate write() backpressure
          }
          return true;
        }
      }
    });

    try {
      const { browser, streamId } = await openUpgradedSocket(harness);
      const frames = [
        buildClientFrame(0x01, Buffer.from('one')),
        buildClientFrame(0x01, Buffer.from('two')),
        buildClientFrame(0x01, Buffer.from('three'))
      ];
      const combined = Buffer.concat(frames);

      // All three frames arrive in a single TCP chunk.
      browser.socket.write(combined);

      await waitFor(() => harness.pool.frames(FrameType.DATA, streamId).length === 2, 2000, '2 frames before drain');
      await delay(120);
      assert.equal(
        harness.pool.frames(FrameType.DATA, streamId).length,
        2,
        'pump must hold the third buffered frame while backpressured'
      );

      harness.pool.flushDrains();
      await waitFor(() => harness.pool.frames(FrameType.DATA, streamId).length === 3, 2000, '3 frames after drain');

      const forwarded = Buffer.concat(harness.pool.frames(FrameType.DATA, streamId).map((frame) => frame.payload));
      assert.deepEqual(forwarded, combined, 'all buffered frames must be forwarded intact and in order');
      browser.destroy();
    } finally {
      await harness.close();
    }
  });

  test('resumes an oversized frame and the following buffered frame after drain', async () => {
    let dataSent = 0;
    const harness = await startRouterHarness({
      maxConcurrentStreams: 10,
      poolOptions: {
        sendVerdict: (frame) => {
          if (frame.type === FrameType.DATA) {
            dataSent++;
            if (dataSent === 2) return false; // backpressure mid oversized frame
          }
          return true;
        }
      }
    });

    try {
      const { browser, streamId } = await openUpgradedSocket(harness);

      const largePayload = Buffer.alloc(MAX_FRAME_SIZE + 5000, 0x41);
      const largeFrame = buildClientFrame(0x02, largePayload);
      const smallFrame = buildClientFrame(0x01, Buffer.from('tail'));
      assert.ok(largeFrame.length > MAX_FRAME_SIZE, 'fixture must exceed the frame chunk size');

      browser.socket.write(Buffer.concat([largeFrame, smallFrame]));

      await waitFor(() => harness.pool.frames(FrameType.DATA, streamId).length === 2, 2000, 'large frame chunks before drain');
      await delay(120);
      assert.equal(harness.pool.frames(FrameType.DATA, streamId).length, 2, 'tail frame must not jump the backpressure');

      harness.pool.flushDrains();
      await waitFor(() => harness.pool.frames(FrameType.DATA, streamId).length === 3, 2000, 'tail frame after drain');

      const chunks = harness.pool.frames(FrameType.DATA, streamId).map((frame) => frame.payload);
      assert.deepEqual(Buffer.concat(chunks.slice(0, 2)), largeFrame, 'oversized frame must be reassembled exactly');
      assert.deepEqual(chunks[2], smallFrame, 'following buffered frame must be delivered after the drain');
      browser.destroy();
    } finally {
      await harness.close();
    }
  });
});
