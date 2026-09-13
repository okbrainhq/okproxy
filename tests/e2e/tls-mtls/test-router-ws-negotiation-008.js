// Regression tests: WebSocket handshake negotiation must survive the tunnel.
//
// Verified defect (http-router.js upgrade response path): the router forwarded
// the browser's Sec-WebSocket-Protocol / Sec-WebSocket-Extensions offers to the
// target but dropped the target's selection when writing the 101 response back
// to the browser, so the two peers disagreed about negotiated semantics.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startRouterHarness, connectBrowser } = require('./http-router-harness-008');
const { FrameType } = require('../../../packages/frame-protocol');
const { resolveWebSocketNegotiation } = require('../../../apps/server/lib/http-router');

const ACCEPT = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': 'test-accept' };

async function waitForTerminal(harness, streamId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const frames = harness.terminalFrames(streamId);
    if (frames.length > 0) return frames;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for terminal frame');
}

test.describe('http-router WS negotiation hardening', () => {
  test('relays offered subprotocol + extension selection back to the browser', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10 });
    try {
      const browser = await connectBrowser({
        port: harness.port,
        offers: {
          'Sec-WebSocket-Protocol': 'chat, superchat',
          'Sec-WebSocket-Extensions': 'permessage-deflate'
        }
      });

      const streamId = await harness.waitForStream();
      const upgrade = harness.pool.frames(FrameType.UPGRADE, streamId)[0];
      assert.ok(upgrade, 'router must send an UPGRADE frame');
      const forwardedHeaders = JSON.parse(upgrade.payload.toString()).headers;
      assert.equal(forwardedHeaders['sec-websocket-protocol'], 'chat, superchat', 'offers are forwarded upstream');
      assert.equal(forwardedHeaders['sec-websocket-extensions'], 'permessage-deflate');

      harness.upgradeResponse(streamId, 101, {
        ...ACCEPT,
        'sec-websocket-protocol': 'chat',
        'sec-websocket-extensions': 'permessage-deflate'
      });

      await browser.waitFor((b) => b.statusLine().startsWith('HTTP/1.1 101'), 2000, '101 response');
      const text = browser.headerText();
      assert.match(text, /Sec-WebSocket-Protocol: chat/i, 'selected subprotocol must reach the browser');
      assert.match(text, /Sec-WebSocket-Extensions: permessage-deflate/i, 'selected extension must reach the browser');
      browser.destroy();
    } finally {
      await harness.close();
    }
  });

  test('fails closed when the target selects a subprotocol the browser never offered', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10 });
    try {
      const browser = await connectBrowser({
        port: harness.port,
        offers: { 'Sec-WebSocket-Protocol': 'chat' }
      });
      const streamId = await harness.waitForStream();

      harness.upgradeResponse(streamId, 101, { ...ACCEPT, 'sec-websocket-protocol': 'other' });

      await browser.waitFor((b) => b.statusLine().startsWith('HTTP/1.1 502'), 2000, '502 response');
      const terminal = await waitForTerminal(harness, streamId);
      assert.equal(terminal.length, 1, 'exactly one terminal frame on refusal');
      assert.equal(terminal[0].type, FrameType.ERROR);
      assert.match(terminal[0].payload.toString(), /subprotocol-not-offered/);
      assert.equal(harness.pool.activeStreams.size, 0, 'stream must be released');
      browser.destroy();
    } finally {
      await harness.close();
    }
  });

  test('fails closed when the target accepts an extension the browser never offered', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10 });
    try {
      const browser = await connectBrowser({ port: harness.port, offers: {} });
      const streamId = await harness.waitForStream();

      harness.upgradeResponse(streamId, 101, { ...ACCEPT, 'sec-websocket-extensions': 'x-unknown-ext' });

      await browser.waitFor((b) => b.statusLine().startsWith('HTTP/1.1 502'), 2000, '502 response');
      const terminal = await waitForTerminal(harness, streamId);
      assert.equal(terminal.length, 1);
      assert.match(terminal[0].payload.toString(), /extension-not-offered/);
      browser.destroy();
    } finally {
      await harness.close();
    }
  });

  test('stripWebSocketNegotiation removes offers upstream instead of half-negotiating', async () => {
    const harness = await startRouterHarness({ maxConcurrentStreams: 10, stripWebSocketNegotiation: true });
    try {
      const browser = await connectBrowser({
        port: harness.port,
        offers: { 'Sec-WebSocket-Protocol': 'chat', 'Sec-WebSocket-Extensions': 'permessage-deflate' }
      });
      const streamId = await harness.waitForStream();

      const upgrade = harness.pool.frames(FrameType.UPGRADE, streamId)[0];
      const forwardedHeaders = JSON.parse(upgrade.payload.toString()).headers;
      assert.equal(forwardedHeaders['sec-websocket-protocol'], undefined, 'offers are stripped upstream');
      assert.equal(forwardedHeaders['sec-websocket-extensions'], undefined);

      // Target still tries to select something: the router must refuse rather
      // than hand the browser a handshake it did not request.
      harness.upgradeResponse(streamId, 101, { ...ACCEPT, 'sec-websocket-extensions': 'permessage-deflate' });
      await browser.waitFor((b) => b.statusLine().startsWith('HTTP/1.1 502'), 2000, '502 response');
      browser.destroy();
    } finally {
      await harness.close();
    }
  });

  test('resolveWebSocketNegotiation unit behavior', () => {
    assert.deepEqual(resolveWebSocketNegotiation({}, ['chat'], ['permessage-deflate']), { lines: [] });
    assert.deepEqual(
      resolveWebSocketNegotiation({ 'sec-websocket-protocol': 'chat' }, ['chat'], []),
      { lines: ['Sec-WebSocket-Protocol: chat'] }
    );
    assert.deepEqual(
      resolveWebSocketNegotiation({ 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' }, [], ['permessage-deflate']),
      { lines: ['Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits'] }
    );
    assert.deepEqual(
      resolveWebSocketNegotiation({ 'sec-websocket-protocol': 'nope' }, ['chat'], []),
      { error: 'subprotocol-not-offered:nope' }
    );
    assert.deepEqual(
      resolveWebSocketNegotiation({ 'sec-websocket-extensions': 'nope-ext' }, [], []),
      { error: 'extension-not-offered:nope-ext' }
    );
  });
});
