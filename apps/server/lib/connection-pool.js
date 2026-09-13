// Server transport integration. Every established lane belongs to one v2
// session; lane loss is session failure, never an implicit stream migration.
const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');
const { TransportSession, onceAnyDrain, nonce, MAX_LANE_BYTES, MAX_LANES, SEQ_RESET_THRESHOLD, positive } = require('../../../packages/frame-protocol/transport-session');
const { isRevoked } = require('./ca');

const DEFAULT_REVOCATION_WATCH_INTERVAL_MS = 5000;

/**
 * Safe serial normalization for CRL lookups: trim, drop empty/absent values.
 * ca.isRevoked() interprets TLS-reported serials as hex and reports malformed
 * input as "not revoked" (it neither throws nor evicts), so this only guards
 * against null/blank/whitespace serials.
 */
function normalizeSerial(value) {
  if (value === undefined || value === null) return null;
  const serial = String(value).trim();
  return serial ? serial : null;
}

class ConnectionPool {
  constructor(options = {}) {
    this.options = options;
    this.connections = new Map();
    this.activeStreams = new Map();
    this.clientSerial = options.clientSerial ? String(options.clientSerial) : null;
    this.clientSession = null;
    this.sessionId = nonce();
    this.streamOutboundConnections = new Map();
    this.streamOptions = new Map();
    this.roundRobinCursor = 0;
    this.maxLaneBufferBytes = positive(options.maxLaneBufferBytes, MAX_LANE_BYTES);
    this.caDir = options.caDir || './data/ca';
    this.revocationWatchTimer = null;
    this._closing = false;
    this.transport = this._newTransport();
    if (options.revocationWatch) this.startRevocationWatch(options.revocationWatchIntervalMs);
  }
  _newTransport() {
    return new TransportSession({ ...this.options, initiator: true,
      deliver: frame => this._routeToHandler(frame),
      fatal: reason => this.evictAll(reason),
      retire: id => this.clearStreamMode(id)
    });
  }
  add(clientSerial, interfaceName, socket) {
    const serial = String(clientSerial);
    if (this._closing || (this.clientSerial && this.clientSerial !== serial)) return false;
    const peer = socket._okproxyClientSession;
    if (this.clientSession && this.clientSession !== peer) return false;
    const key = `${serial}:${interfaceName}`;
    // Replacing a still-live lane may discard its unique bytes. Reject the new
    // lane rather than pretending another connection is a redundant copy.
    if (this.connections.has(key) || this.connections.size >= MAX_LANES) return false;
    if (this.transport.failed) this.transport = this._newTransport();
    this.clientSerial = serial;
    this.clientSession = peer;
    socket._okproxyTransportSession = this.sessionId;
    this.connections.set(key, socket);
    return true;
  }
  owns(socket) {
    return socket && !socket.destroyed && socket._okproxyTransportSession === this.sessionId &&
      [...this.connections.values()].includes(socket);
  }
  remove(socket) {
    if ([...this.connections.values()].includes(socket)) this._evictAll('transport-lane-lost');
  }
  get count() { return this.connections.size; }
  onFrame(frame, socket = null) {
    if (socket && !this.owns(socket)) return 'invalid';
    if (frame.type === FrameType.RESET_SEQ) { this.handleResetSeq(frame); return 'failed'; }
    // Allocation/handler membership is checked BEFORE windows or lane maps.
    if (!this.activeStreams.has(frame.streamId)) return this.transport.known.has(frame.streamId) ? 'duplicate' : 'invalid';
    return this.transport.receive(frame);
  }
  _routeToHandler(frame) {
    const handler = this.activeStreams.get(frame.streamId);
    if (!handler) return;
    if (frame.type === FrameType.ERROR) {
      this.unregisterStream(frame.streamId);
      try { handler.errorHandler?.(new Error(frame.payload.toString())); } catch {}
    } else handler.frameHandler?.(frame);
  }
  send(buf) {
    if (this._closing || this.transport.failed) return false;
    const id = buf.readUInt32BE(0), type = buf.readUInt8(4);
    if (type === FrameType.RESET_SEQ || id === 0) { this.transport.fail('unexpected-control-send'); return false; }
    const opening = type === FrameType.HEADERS || type === FrameType.UPGRADE;
    if (!this.transport.prepare(buf)) {
      // Router sends OPEN before registering its handler. Throw here so that
      // early failure is surfaced as 502, not mistaken for writable backpressure.
      if (opening) throw new Error('Transport cannot allocate/send stream');
      return false;
    }
    const targets = this._isSingleFlowStream(id) ? this._selectOutboundConnection(id) : this._allLiveConnections();
    const result = this._writeToConnections(buf, targets);
    if (type === FrameType.ERROR) this.transport.drop(id);
    if (opening && this.transport.failed) throw new Error('Transport failed sending opening frame');
    return result;
  }
  _allLiveConnections() { return [...this.connections.entries()].filter(([, socket]) => !socket.destroyed); }
  _writeToConnections(buf, entries) {
    if (!entries.length) { this.transport.fail('no-writable-lane'); return false; }
    let writable = false;
    for (const [, socket] of entries) {
      if (this.transport.failed) return false;
      try {
        if (socket.destroyed) throw new Error('lane closed');
        // false still means queued! Never retry or reset its sequence number.
        writable = socket.write(buf) || writable;
        if (socket.writableLength > this.maxLaneBufferBytes) throw new Error('lane-buffer-limit');
      } catch (err) { this.transport.fail(err.message); return false; }
    }
    return writable;
  }
  registerStream(id, handlers, options = {}) {
    if (!this.count || this._closing || this.transport.failed || this.activeStreams.has(id)) {
      try { handlers.errorHandler?.(new Error('Transport stream registration failed')); } catch {}
      return false;
    }
    let state = this.transport.streams.get(id);
    if (!state && !this.transport.failed) state = this.transport.open(id);
    if (!state || this.activeStreams.has(id) || !this.count) {
      try { handlers.errorHandler?.(new Error('Transport stream registration failed')); } catch {}
      return false;
    }
    this.activeStreams.set(id, handlers);
    if (Object.hasOwn(options, 'singleFlow')) this.setStreamMode(id, options);
    return true;
  }
  unregisterStream(id) { this.activeStreams.delete(id); this.transport.drop(id); this.clearStreamMode(id); }
  getStreamHandler(id) { return this.activeStreams.get(id) || null; }
  setStreamMode(id, options = {}) {
    if (options.singleFlow) this.streamOptions.set(id, { singleFlow: true });
    else this.clearStreamMode(id);
  }
  clearStreamMode(id) { this.streamOptions.delete(id); this.streamOutboundConnections.delete(id); }
  _isSingleFlowStream(id) { return this.streamOptions.get(id)?.singleFlow === true; }
  _selectOutboundConnection(streamId) {
    const existingKey = this.streamOutboundConnections.get(streamId);
    const existing = existingKey ? this.connections.get(existingKey) : null;
    if (existing && !existing.destroyed) return [[existingKey, existing]];

    const live = this._allLiveConnections();
    if (live.length === 0) return [];

    const loadByKey = new Map();
    for (const key of this.streamOutboundConnections.values()) {
      if (this.connections.has(key)) loadByKey.set(key, (loadByKey.get(key) || 0) + 1);
    }

    let best = null;
    let bestScore = Infinity;
    const start = live.length > 0 ? this.roundRobinCursor % live.length : 0;

    for (let i = 0; i < live.length; i++) {
      const index = (start + i) % live.length;
      const [key, sock] = live[index];
      const load = loadByKey.get(key) || 0;
      const score = load + (sock.writableNeedDrain ? 1000000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { key, sock, index };
      }
    }

    if (!best) return [];
    this.roundRobinCursor = (best.index + 1) % live.length;
    this.streamOutboundConnections.set(streamId, best.key);
    return [[best.key, best.sock]];
  }

  _getOutboundSocketsForStream(streamId) {
    const key = this.streamOutboundConnections.get(streamId);
    const sock = key ? this.connections.get(key) : null;
    return sock && !sock.destroyed ? [sock] : [];
  }


  onceDrain(callback) { return onceAnyDrain(this._allLiveConnections().map(([, s]) => s), callback); }
  onceDrainForStream(id, callback) {
    const state = this.transport.streams.get(id);
    if (!state) return () => {};
    const sockets = this._isSingleFlowStream(id) ? this._getOutboundSocketsForStream(id) : this._allLiveConnections().map(([, s]) => s);
    return onceAnyDrain(sockets, callback, state);
  }
  pauseStream(id) { this.transport.pause(id); }
  resumeStream(id) { this.transport.resume(id); }
  pause() { this.transport.pauseAll(); }
  resume() { this.transport.resumeAll(); }
  isPaused() { return false; } // TLS reads NEVER pause for a data consumer
  handleResetSeq() { this.transport.fail('RESET_SEQ-forbidden-in-v2'); }
  _sendResetSeq() { this.transport.fail('sequence-exhausted'); }
  _failStream(id, reason) { this.transport.fail(reason); }
  _cleanupAllStreams(reason = 'Client disconnected') {
    const handlers = [...this.activeStreams.values()];
    this.activeStreams.clear();
    this.transport.clear();
    this.streamOptions.clear(); this.streamOutboundConnections.clear();
    for (const handler of handlers) {
      try { handler.errorHandler?.(new Error(reason)); } catch (err) {
        console.error('[connection-pool] cleanup handler:', err.message);
      }
    }
  }
  evictBySerial(serial, reason = 'revoked') {
    return this.clientSerial === String(serial) ? this.evictAll(reason) : 0;
  }
  evictAll(reason = 'evicted') { return this._evictAll(reason); }
  _evictAll(reason) {
    if (this._closing) return 0;
    this._closing = true;
    const sockets = [...this.connections.values()];
    this.connections.clear(); // fences late decoder and close callbacks FIRST
    this.transport.failed = true;
    this.sessionId = nonce();
    this.clientSession = null;
    this.clientSerial = null;
    this._cleanupAllStreams(reason);
    for (const socket of sockets) { try { socket.destroy(); } catch {} }
    this._closing = false;
    return sockets.length;
  }

  /**
   * Bounded CRL polling for the default (non-cert-bound) pool.
   *
   * The in-process `certificate-revoked` event only fires when revocation
   * happens in this process. The `ca` CLI revokes from a separate process, so a
   * live tunnel would keep serving until its next handshake unless the CRL is
   * polled. Cert-bound mode is already covered by
   * MultiClientManager#startRevocationWatch; inner session pools never receive
   * `revocationWatch`, so exactly one watcher exists per server.
   *
   * @param {number} [intervalMs] poll interval (default 5000)
   * @returns {() => void} stop function
   */
  startRevocationWatch(intervalMs = DEFAULT_REVOCATION_WATCH_INTERVAL_MS) {
    this.stopRevocationWatch();
    const interval = Number.isFinite(intervalMs) && intervalMs > 0
      ? Math.floor(intervalMs)
      : DEFAULT_REVOCATION_WATCH_INTERVAL_MS;
    this.revocationWatchTimer = setInterval(() => {
      try {
        this.evictRevokedSessions();
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Revocation watch failed:`, err && err.message);
      }
    }, interval);
    if (typeof this.revocationWatchTimer.unref === 'function') this.revocationWatchTimer.unref();
    return () => this.stopRevocationWatch();
  }

  stopRevocationWatch() {
    if (this.revocationWatchTimer) {
      clearInterval(this.revocationWatchTimer);
      this.revocationWatchTimer = null;
    }
  }

  /**
   * Evict this pool's tunnel when its authenticated serial appears in the CRL.
   * Eviction requires a *loadable* CRL that lists the serial: a missing or
   * unreadable CRL, an unknown serial or malformed input evicts nothing and
   * never throws — the existing authorization simply stands and keeps serving.
   * That is the inherited `isRevoked()` storage-failure limitation; this watcher
   * is NOT a fail-closed guarantee for CRL read failures.
   * @returns {number} connections evicted
   */
  evictRevokedSessions() {
    const serial = normalizeSerial(this.clientSerial);
    if (!serial || this._closing) return 0;
    let revoked = false;
    try {
      revoked = isRevoked(serial, this.caDir);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Revocation check failed for serial ${serial}:`, err && err.message);
      return 0;
    }
    if (!revoked) return 0;
    const evicted = this.evictBySerial(serial, 'certificate revoked');
    if (evicted > 0) {
      console.log(`[${new Date().toISOString()}] Evicted revoked tunnel (serial: ${serial})`);
    }
    return evicted;
  }

  /** Release the CRL watcher. Call on shutdown or in tests. */
  dispose() {
    this.stopRevocationWatch();
  }
}
module.exports = { ConnectionPool, SEQ_RESET_THRESHOLD };
