const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TransportSession, onceAnyDrain, nonce, SEQ_RESET_THRESHOLD } = require('../../packages/frame-protocol/transport-session');
const { OrderedDedupWindow, FrameType: T, encodeFrame } = require('../../packages/frame-protocol');
const { ConnectionPool } = require('../../apps/server/lib/connection-pool');
const { VirtualSocket } = require('../../apps/client/lib/virtual-socket');
const { RealSocket } = require('../../apps/client/lib/real-socket');
const delay = ms => new Promise(r => setTimeout(r, ms));
const frame = (type, seqNo, payload = '', streamId = 1) => ({ type, seqNo, streamId, payload: Buffer.from(payload) });
function lane() {
  const socket = new EventEmitter();
  Object.assign(socket, { destroyed: false, writableLength: 0, writableNeedDrain: false, writes: [],
    pause() { throw new Error('TLS reads must not pause'); }, resume() {},
    write(buf) { this.writes.push(Buffer.from(buf)); return !this.writableNeedDrain; },
    destroy() { this.destroyed = true; }, _okproxyClientSession: 'a'.repeat(64) });
  return socket;
}
function pool(options = {}) { const p = new ConnectionPool(options); const s = lane(); p.add('serial', 'a', s); return { p, s }; }
function virtual(options = {}) {
  const vs = new VirtualSocket(options); vs.serverSession = nonce(); vs._sessionActive = true;
  const s = lane(); const rs = { socket: s, clientSession: vs.clientSession, serverSession: vs.serverSession,
    isConnected: () => !s.destroyed, write: buf => s.write(buf), destroy: () => s.destroy() };
  vs.realSockets.set('a', rs); return { vs, rs, s };
}
function core(options = {}) {
  const received = [], failures = [];
  const t = new TransportSession({ ...options, deliver: f => received.push(f), fatal: reason => { failures.push(reason); t.clear(); } });
  return { t, received, failures };
}

test('allocated response: DATA2 before HEADERS1 is buffered and complete bytes arrive in order', () => {
  const { p, s } = pool(); const delivered = [];
  p.registerStream(1, { frameHandler: f => delivered.push(f) });
  p.onFrame(frame(T.DATA, 2, 'PREFIX'), s);
  assert.equal(delivered.length, 0);
  p.onFrame(frame(T.DATA, 3, 'SUFFIX'), s);
  p.onFrame(frame(T.HEADERS, 1, '{}'), s);
  p.onFrame(frame(T.FIN, 4), s);
  assert.deepEqual(delivered.map(f => f.type), [T.HEADERS, T.DATA, T.DATA, T.FIN]);
  assert.equal(Buffer.concat(delivered.filter(f => f.type === T.DATA).map(f => f.payload)).toString(), 'PREFIXSUFFIX');
  p.evictAll();
});

test('unallocated client DATA2 before HEADERS1 cannot create a suffix-only request', () => {
  const { vs, rs } = virtual(); const delivered = []; let resets = 0;
  vs.on('frame', f => delivered.push(f)); vs.on('sessionReset', () => resets++);
  vs._onFrame(frame(T.DATA, 2, 'PREFIX'), rs);
  vs._onFrame(frame(T.HEADERS, 1, '{}'), rs);
  vs._onFrame(frame(T.DATA, 3, 'SUFFIX'), rs); vs._onFrame(frame(T.FIN, 4), rs);
  assert.equal(delivered.length, 0); assert.equal(resets, 1); assert.equal(vs.transport.streams.size, 0);
  vs.destroy();
});

test('duplicate opens never restart, duplicate FIN/error delivered once, late OPEN cannot resurrect', () => {
  const { t, received, failures } = core();
  for (const f of [frame(T.HEADERS, 1), frame(T.HEADERS, 1), frame(T.DATA, 2, 'x'), frame(T.DATA, 2, 'x'), frame(T.FIN, 3), frame(T.FIN, 3)]) t.receive(f);
  assert.deepEqual(received.map(f => f.seqNo), [1, 2, 3]);
  t.drop(1); t.receive(frame(T.HEADERS, 1)); assert.equal(t.streams.size, 0);
  t.receive(frame(T.HEADERS, 1, '', 2));
  t.receive(frame(T.ERROR, 0, 'cancel', 2)); t.receive(frame(T.ERROR, 0, 'cancel', 2));
  assert.equal(received.filter(f => f.type === T.ERROR).length, 1); assert.equal(failures.length, 0); t.clear();
});

test('RESET during gap cancels all and cannot permit DATA0/FIN1 success or allocate epochs', () => {
  const { p, s } = pool(); const delivered = []; let errors = 0;
  p.registerStream(1, { frameHandler: f => delivered.push(f), errorHandler: () => errors++ });
  p.onFrame(frame(T.HEADERS, 1), s); p.onFrame(frame(T.DATA, 3, 'lost-prefix'), s);
  const win = p.transport.streams.get(1).window;
  p.handleResetSeq({ payload: Buffer.from(JSON.stringify({ streams: Array.from({ length: 6000 }, (_, i) => i + 1), epoch: 1 })) });
  p.onFrame(frame(T.DATA, 0, 'wrong'), s); p.onFrame(frame(T.FIN, 1), s);
  assert.equal(errors, 1); assert.equal(delivered.length, 1); assert.equal(win.buffer.size, 0);
  assert.equal(win.gapTimer, null); assert.equal(p.transport.bytes, 0); assert.equal(p.count, 0);
  assert.equal(p.resetSeq, undefined);
});

for (const side of ['server', 'client']) test(`${side}: sequence exhaustion while backpressured fails without RESET/zero replay`, () => {
  if (side === 'server') {
    const { p, s } = pool(); let errors = 0;
    p.send(encodeFrame(1, T.HEADERS, '{}')); p.registerStream(1, { errorHandler: () => errors++ });
    const state = p.transport.streams.get(1); state.seq = SEQ_RESET_THRESHOLD;
    s.writableNeedDrain = true;
    p.send(encodeFrame(1, T.DATA, 'first')); p.send(encodeFrame(1, T.DATA, 'second'));
    assert.equal(errors, 1); assert.equal(s.writes.length, 1); assert.equal(p.count, 0);
  } else {
    const { vs, rs, s } = virtual();
    vs._onFrame(frame(T.HEADERS, 1), rs); vs.write(encodeFrame(1, T.HEADERS, '{}'));
    vs.transport.streams.get(1).seq = SEQ_RESET_THRESHOLD; s.writableNeedDrain = true;
    vs.write(encodeFrame(1, T.DATA, 'first')); vs.write(encodeFrame(1, T.DATA, 'second'));
    assert.equal(s.writes.length, 1); assert.equal(vs.sessionGeneration, 1); vs.destroy();
  }
});

test('5000 unallocated IDs produce zero windows, lane maps, timers, tombstones', () => {
  const { p, s } = pool();
  for (let id = 1; id <= 5000; id++) assert.equal(p.onFrame(frame(T.DATA, 2, 'x', id), s), 'invalid');
  assert.equal(p.transport.streams.size, 0); assert.equal(p.transport.known.size, 0); assert.equal(p.transport.bytes, 0);
  assert.equal(p.streamInboundConnections, undefined); p.evictAll();
});

test('active allocation caps notify handlers; completed streams free slots immediately', () => {
  const { p, s } = pool({ maxTrackedStreams: 2 }); let failures = 0;
  for (let id = 1; id <= 4500; id++) {
    assert.equal(p.registerStream(id, { errorHandler: () => failures++ }), true);
    p.onFrame(frame(T.HEADERS, 1, '', id), s); p.unregisterStream(id);
  }
  assert.equal(p.transport.streams.size, 0); assert.equal(p.transport.known.size, 4500);
  for (let id = 4501; id <= 4503; id++) p.registerStream(id, { errorHandler: () => failures++ });
  assert.equal(failures, 3); assert.equal(p.activeStreams.size, 0); assert.equal(p.transport.bytes, 0);
});

test('payload-free tombstone cap causes explicit session cancellation, not ID reuse', () => {
  const { t, failures } = core({ maxSessionStreams: 2 });
  t.receive(frame(T.HEADERS, 1)); t.drop(1); t.receive(frame(T.HEADERS, 1, '', 2)); t.drop(2);
  t.receive(frame(T.HEADERS, 1, '', 3)); assert.deepEqual(failures, ['stream-allocation-limit']);
  assert.equal(t.known.size, 0);
});

test('combined paused/reorder buffers enforce aggregate bytes, then release all payload and timers', () => {
  const { t, failures } = core({ maxBufferedBytes: 100, maxStreamBufferBytes: 100 });
  for (const id of [1, 2]) t.receive(frame(T.HEADERS, 1, '', id));
  const states = [...t.streams.values()];
  t.pause(1); t.receive(frame(T.DATA, 2, 'x'.repeat(50), 1));
  t.receive(frame(T.DATA, 3, 'y'.repeat(50), 2));
  assert.equal(failures.length, 1); assert.equal(t.bytes, 0);
  for (const state of states) {
    assert.equal(state.queue.length, 0); assert.equal(state.window.bytes, 0); assert.equal(state.timer, null); assert.equal(state.window.gapTimer, null);
  }
});

test('gap timeout releases retained data; failed windows cannot restart', async () => {
  const w = new OrderedDedupWindow(0, { gapTimeoutMs: 10 });
  w.accept(3, frame(T.DATA, 3, 'secret')); await delay(30);
  assert.equal(w.failed, true); assert.equal(w.bytes, 0); assert.equal(w.buffer.size, 0); assert.equal(w.gapTimer, null);
  assert.equal(w.accept(1, frame(T.HEADERS, 1)), 'failed');
});

test('paused stream stays bounded while sibling/late-lane traffic remains readable', () => {
  const { p, s } = pool(); const data = [];
  for (const id of [1, 2]) p.registerStream(id, { frameHandler: f => data.push([f.streamId, f.type]) });
  p.onFrame(frame(T.HEADERS, 1), s); p.pauseStream(1);
  const late = lane(); p.add('serial', 'late', late);
  p.onFrame(frame(T.DATA, 2, 'a'), late); p.onFrame(frame(T.FIN, 3), late);
  p.onFrame(frame(T.HEADERS, 1, '', 2), late);
  assert.deepEqual(data, [[1, T.HEADERS], [2, T.HEADERS]]);
  assert.equal(p.isPaused(s), false); p.resumeStream(1);
  assert.deepEqual(data.slice(-2), [[1, T.DATA], [1, T.FIN]]); p.evictAll();
});

test('drain wakes on any eligible lane and removes every sibling listener', async () => {
  const a = lane(), b = lane(); a.writableNeedDrain = b.writableNeedDrain = true;
  let wakes = 0; onceAnyDrain([a, b], () => wakes++);
  a.emit('drain'); assert.equal(wakes, 1);
  for (const s of [a, b]) for (const event of ['drain', 'close', 'error']) assert.equal(s.listenerCount(event), 0);
  b.emit('drain'); assert.equal(wakes, 1);
  a.writableNeedDrain = false; onceAnyDrain([a, b], () => wakes++); await delay(0); assert.equal(wakes, 2);
});

test('stream revocation cancels pending drain callbacks and clears every resource once', () => {
  const { p, s } = pool(); let errors = 0, wakes = 0;
  p.send(encodeFrame(1, T.HEADERS, '{}')); p.registerStream(1, { errorHandler() { errors++; p.evictAll(); throw new Error('handler'); } });
  s.writableNeedDrain = true; p.onceDrainForStream(1, () => wakes++);
  p.onFrame(frame(T.DATA, 3, 'secret'), s); p.pauseStream(1);
  const state = p.transport.streams.get(1); p.evictBySerial('serial'); s.emit('drain'); p.remove(s);
  assert.equal(errors, 1); assert.equal(wakes, 0); assert.equal(state.window.bytes, 0); assert.equal(state.timer, null);
  assert.equal(p.transport.bytes, 0); assert.equal(p.activeStreams.size, 0); assert.equal(s.listenerCount('drain'), 0);
});

for (const side of ['server', 'client']) test(`${side}: lagging single-flow lane is not treated as redundant because a sibling exists`, () => {
  if (side === 'server') {
    const { p, s } = pool(); const sibling = lane(); p.add('serial', 'b', sibling); let errors = 0;
    p.setStreamMode(1, { singleFlow: true }); p.send(encodeFrame(1, T.HEADERS, '{}')); p.registerStream(1, { errorHandler: () => errors++ });
    s.writableNeedDrain = true; s.writableLength = 5 * 1024 * 1024;
    p.send(encodeFrame(1, T.DATA, 'unique'));
    assert.equal(sibling.writes.length, 0); assert.equal(errors, 1); assert.equal(p.count, 0);
  } else {
    const { vs, rs, s } = virtual(); const b = lane(); const sibling = { ...rs, socket: b, isConnected: () => !b.destroyed, write: buf => b.write(buf), destroy: () => b.destroy() };
    vs.realSockets.set('b', sibling); vs._onFrame(frame(T.HEADERS, 1), rs);
    vs.setStreamMode(1, { singleFlow: true }); vs.write(encodeFrame(1, T.HEADERS, '{}'));
    s.writableNeedDrain = true; s.writableLength = 5 * 1024 * 1024;
    vs.write(encodeFrame(1, T.DATA, 'unique'));
    assert.equal(b.writes.length, 0); assert.equal(vs.sessionGeneration, 1); vs.destroy();
  }
});

test('peer nonce change with unobserved old close fences every old lane before accepting stream IDs', () => {
  const { vs, rs } = virtual(); const delivered = [];
  vs.on('frame', f => delivered.push(f)); vs._onFrame(frame(T.HEADERS, 1), rs);
  const oldClient = vs.clientSession;
  const fresh = { ...rs, socket: lane() }; vs.realSockets.set('new', fresh);
  assert.equal(vs._acceptSession({ serverSession: nonce(), maxConcurrentStreams: 100 }, fresh, { clientSession: oldClient }), false);
  vs._onFrame(frame(T.DATA, 2, 'OLD-SESSION-SECRET'), rs);
  assert.equal(delivered.length, 1); assert.equal(vs.sessionGeneration, 1);
  assert.notEqual(vs.clientSession, oldClient); assert.equal(vs.transport.streams.size, 0); vs.destroy();
});

test('raw lane pause fails instead of exempting PONG timeout', () => {
  const rs = new RealSocket({}); rs.socket = lane(); rs.initialized = true;
  rs.pause(); assert.equal(rs.socket.destroyed, true); rs.destroy();
});

test('client cannot send successful FIN while request has unresolved loss', () => {
  const { t, failures } = core(); t.receive(frame(T.HEADERS, 1)); t.receive(frame(T.DATA, 3, 'suffix'));
  assert.equal(t.prepare(encodeFrame(1, T.HEADERS, '{}')), true);
  assert.equal(t.prepare(encodeFrame(1, T.FIN, '')), false);
  assert.deepEqual(failures, ['response-before-request-complete']); assert.equal(t.bytes, 0);
});

test('fake-clock 12s: a 300s stream pause cannot block the client PING/PONG reader', ctx => {
  ctx.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { p, s } = pool({ pauseTimeout: 300000 });
  p.registerStream(1, { frameHandler() {} }); p.pauseStream(1);
  const rs = new RealSocket({ pingInterval: 3000, pongTimeout: 10000 });
  let now = 0, pongs = 0; rs._now = () => now; rs.socket = lane(); rs.initialized = true;
  rs.socket.write = () => { assert.equal(p.isPaused(s), false); rs.lastPongTime = now; pongs++; return true; };
  rs._startKeepalive();
  for (let i = 0; i < 4; i++) { now += 3000; ctx.mock.timers.tick(3000); }
  assert.equal(pongs, 4); assert.equal(rs.socket.destroyed, false); assert.equal(p.count, 1);
  rs.destroy(); p.evictAll(); ctx.mock.timers.reset();
});

test('global and per-stream pause owners cannot accidentally resume each other', () => {
  const { t, received } = core(); t.receive(frame(T.HEADERS, 1));
  t.pause(1); t.pauseAll(); t.receive(frame(T.DATA, 2, 'held'));
  t.resumeAll(); assert.equal(received.length, 1); t.resume(1); assert.equal(received.length, 2);
  t.pauseAll(); t.pause(1); t.resume(1); t.receive(frame(T.FIN, 3));
  assert.equal(received.length, 2); t.resumeAll(); assert.equal(received.length, 3); t.clear();
});

test('failed registration while disconnected cannot retain a window', () => {
  const p = new ConnectionPool(); let errors = 0;
  assert.equal(p.registerStream(1, { errorHandler: () => errors++ }), false);
  assert.equal(errors, 1); assert.equal(p.transport.streams.size, 0); assert.equal(p.transport.known.size, 0);
});

test('consumer exception fails transport instead of escaping a TLS decoder callback', () => {
  let failure;
  const t = new TransportSession({ deliver() { throw new Error('consumer'); }, fatal(reason) { failure = reason; t.clear(); } });
  assert.doesNotThrow(() => t.receive(frame(T.HEADERS, 1)));
  assert.equal(failure, 'consumer-handler-error'); assert.equal(t.streams.size, 0);
});

test('decoder teardown discards partial frames and ignores all later input', () => {
  const { createFrameDecoder } = require('../../packages/frame-protocol'); let delivered = 0;
  const decode = createFrameDecoder(() => delivered++, () => {});
  const encoded = encodeFrame(1, T.DATA, 'secret', 2);
  decode(encoded.subarray(0, 14)); decode.destroy(); decode(encoded.subarray(14)); decode(encoded);
  assert.equal(delivered, 0);
});
