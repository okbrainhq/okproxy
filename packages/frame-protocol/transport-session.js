// Protocol v2: no sequence/ID reuse, bounded receive state, fail-closed sessions.
// A TLS lane is bound by the INIT handshake to BOTH endpoint nonces. There is
// intentionally no ACK/replay: losing any established lane cancels the session.
const { randomBytes } = require('node:crypto');
const { OrderedDedupWindow, ORDER_STATUS } = require('./ordered-window');
const VERSION = 2;
const CAPABILITY = 'session-bound-no-wrap-v2';
const MAX_STREAM_ID = 0x7fffffff;
const SEQ_RESET_THRESHOLD = 0xffffff0f;
const MAX_LANE_BYTES = 4 * 1024 * 1024;
const MAX_LANES = 64;
const TYPES = { HEADERS: 1, DATA: 2, FIN: 3, ERROR: 4, UPGRADE: 8 };
const isStart = type => type === TYPES.HEADERS || type === TYPES.UPGRADE;
const nonce = () => randomBytes(32).toString('hex');
const validNonce = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const compatible = value => value && value.version === VERSION && value.capability === CAPABILITY && validNonce(value.clientSession);
function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

class TransportSession {
  constructor(options = {}) {
    this.options = options;
    this.initiator = Boolean(options.initiator);
    this.streams = new Map();
    // Payload-free tombstones; never expire within a session. Prevent late OPEN
    // replay after completion without filling the active/reorder window limit.
    this.known = new Set();
    this.bytes = 0;
    this.maxStreams = positive(options.maxTrackedStreams, 100);
    this.maxIds = positive(options.maxSessionStreams, 65536);
    this.maxBytes = positive(options.maxBufferedBytes, 16 * 1024 * 1024);
    this.maxStreamBytes = positive(options.maxStreamBufferBytes, 4 * 1024 * 1024);
    this.maxFrames = positive(options.maxOrderedFrames, 512);
    this.pauseTimeout = positive(options.pauseTimeout, 10000);
    this.failed = false;
    this.globalPaused = false;
  }

  open(id) {
    if (this.failed) return null;
    if (!Number.isInteger(id) || id <= 0 || id > MAX_STREAM_ID || this.known.has(id)) {
      this.fail('stream-id-reuse-or-invalid');
      return null;
    }
    if (this.streams.size >= this.maxStreams || this.known.size >= this.maxIds) {
      this.fail('stream-allocation-limit');
      return null;
    }
    const state = { id, bytes: 0, queue: [], paused: false, owners: new Set(), timer: null,
      started: false, ended: false, outStarted: false, outEnded: false, seq: 0, drains: new Set() };
    state.window = new OrderedDedupWindow(0, {
      maxBuffer: this.maxFrames,
      maxGap: positive(this.options.maxOrderedGap, 4096),
      maxBytes: this.maxStreamBytes,
      gapTimeoutMs: positive(this.options.orderGapTimeoutMs, 1000),
      reserve: size => this.reserve(state, size),
      release: size => this.release(state, size),
      onGapTimeout: () => this.fail('ordering-gap-timeout')
    });
    this.known.add(id);
    this.streams.set(id, state);
    if (this.globalPaused) this.pause(id, 'global');
    return state;
  }

  reserve(state, size) {
    if (state.bytes + size > this.maxStreamBytes || this.bytes + size > this.maxBytes) return false;
    state.bytes += size;
    this.bytes += size;
    return true;
  }
  release(state, size) { state.bytes -= size; this.bytes -= size; }

  receive(frame) {
    if (this.failed) return 'failed';
    const id = frame.streamId;
    if (!Number.isInteger(id) || id <= 0 || id > MAX_STREAM_ID) return 'invalid';
    let state = this.streams.get(id);
    if (!state) {
      if (this.known.has(id)) return 'duplicate';
      // Only the server allocates streams. The server receiver never creates
      // state for peer-supplied IDs. Client DATA-before-OPEN fails, not salvages.
      if (this.initiator) return 'invalid';
      if (!isStart(frame.type) || frame.seqNo !== 1) {
        this.fail('unallocated-frame-before-headers');
        return 'failed';
      }
      state = this.open(id);
      if (!state) return 'failed';
    }
    // ERROR is an out-of-band cancellation in v2, not a successful end. It can
    // abort a paused stream or an unresolved gap without erasing loss evidence.
    if (frame.type === TYPES.ERROR) {
      if (frame.seqNo !== 0) { this.fail('invalid-cancellation'); return 'failed'; }
      this.drop(id);
      this.dispatch(frame);
      return 'new';
    }
    if (![TYPES.HEADERS, TYPES.UPGRADE, TYPES.DATA, TYPES.FIN].includes(frame.type)) {
      this.fail('invalid-frame-type'); return 'failed';
    }
    const result = state.window.accept(frame.seqNo, frame);
    if (result === ORDER_STATUS.FAILED) { this.fail('ordering-' + state.window.failReason); return 'failed'; }
    if (result === ORDER_STATUS.DUPLICATE) return 'duplicate';
    if (result === ORDER_STATUS.DELIVER) {
      this.deliverOrQueue(state, frame);
      let next;
      while (this.streams.get(id) === state && (next = state.window.takeNext())) this.deliverOrQueue(state, next);
    }
    return 'new';
  }

  deliverOrQueue(state, frame) {
    if (this.failed || this.streams.get(state.id) !== state) return;
    if (state.paused) {
      if (state.queue.length >= this.maxFrames || !this.reserve(state, frame.payload.length + 13)) {
        this.fail('flow-buffer-limit'); return;
      }
      state.queue.push(frame);
      return;
    }
    if (state.ended || (!state.started && (!isStart(frame.type) || frame.seqNo !== 1)) || (state.started && isStart(frame.type))) {
      this.fail('invalid-stream-order'); return;
    }
    if (!state.started) state.openType = frame.type;
    state.started = true;
    if (frame.type === TYPES.FIN) state.ended = true;
    this.dispatch(frame);
  }

  dispatch(frame) {
    try { this.options.deliver(frame); }
    catch { this.fail('consumer-handler-error'); }
  }

  prepare(buf) {
    if (this.failed) return false;
    const id = buf.readUInt32BE(0), type = buf.readUInt8(4);
    let state = this.streams.get(id);
    if (!state && this.initiator && isStart(type)) state = this.open(id);
    if (!state) return false; // late callbacks cannot resurrect completed work
    if (type === TYPES.ERROR) { buf.writeUInt32BE(0, 5); return true; }
    if (state.outEnded || (!state.outStarted && !isStart(type)) || (state.outStarted && isStart(type))) {
      this.fail('invalid-outbound-order'); return false;
    }
    if (!this.initiator && type === TYPES.HEADERS) {
      try { const status = JSON.parse(buf.subarray(13).toString()).status;
        state.outErrorStatus = Number.isInteger(status) && status >= 400 && status <= 599;
      } catch { state.outErrorStatus = false; }
    }
    if (!this.initiator && type === TYPES.FIN && state.openType === TYPES.HEADERS && !state.ended && !state.outErrorStatus) {
      this.fail('response-before-request-complete'); return false;
    }
    if (state.seq >= SEQ_RESET_THRESHOLD) { this.fail('sequence-exhausted'); return false; }
    state.outStarted = true;
    if (type === TYPES.FIN) state.outEnded = true;
    buf.writeUInt32BE(++state.seq, 5);
    return true;
  }

  pause(id, owner = 'stream') {
    const state = this.streams.get(id);
    if (!state) return;
    state.owners.add(owner);
    if (state.paused) return;
    state.paused = true;
    state.timer = setTimeout(() => this.fail('flow-control-timeout'), this.pauseTimeout);
    state.timer.unref?.();
  }
  resume(id, owner = 'stream') {
    const state = this.streams.get(id);
    if (!state) return;
    state.owners.delete(owner);
    if (state.owners.size) return;
    state.paused = false;
    clearTimeout(state.timer); state.timer = null;
    while (!state.paused && state.queue.length && this.streams.get(id) === state) {
      const frame = state.queue.shift();
      this.release(state, frame.payload.length + 13);
      this.deliverOrQueue(state, frame);
    }
  }
  pauseAll() { this.globalPaused = true; for (const id of this.streams.keys()) this.pause(id, 'global'); }
  resumeAll() { this.globalPaused = false; for (const id of this.streams.keys()) this.resume(id, 'global'); }

  drop(id) {
    const state = this.streams.get(id);
    if (!state) return;
    this.streams.delete(id); // fence reentrant callbacks first
    clearTimeout(state.timer); state.timer = null;
    for (const cancel of state.drains) cancel();
    state.drains.clear();
    state.window.dispose();
    for (const frame of state.queue) this.release(state, frame.payload.length + 13);
    state.queue.length = 0;
    this.options.retire?.(id);
  }
  clear() {
    for (const id of this.streams.keys()) this.drop(id);
    this.known.clear();
    this.globalPaused = false;
  }
  fail(reason) {
    if (this.failed) return;
    this.failed = true;
    this.options.fatal(reason);
  }
}

// A broadcast producer can resume when ANY selected lane drains. No wait for
// unrelated lanes; all subscriptions are cancelled on stream/session teardown.
function onceAnyDrain(sockets, callback, state) {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    for (const socket of sockets) {
      socket.removeListener('drain', wake);
      socket.removeListener('close', wake);
      socket.removeListener('error', wake);
    }
    state?.drains.delete(cleanup);
  };
  const wake = () => { if (done) return; cleanup(); callback(); };
  state?.drains.add(cleanup);
  if (!sockets.length || sockets.some(s => s.destroyed || !s.writableNeedDrain)) process.nextTick(wake);
  else for (const socket of sockets) {
    socket.once('drain', wake); socket.once('close', wake); socket.once('error', wake);
  }
  return cleanup;
}
module.exports = { TransportSession, onceAnyDrain, VERSION, CAPABILITY, nonce, validNonce, compatible,
  MAX_STREAM_ID, MAX_LANE_BYTES, MAX_LANES, SEQ_RESET_THRESHOLD, positive };
