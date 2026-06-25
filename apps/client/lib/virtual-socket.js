// VirtualSocket — Multipath virtual socket layer
// Duplicates traffic across all available network interfaces

const { encodeFrame, FrameType, CONTROL_FRAME_TYPES, DedupWindow } = require('../../../packages/frame-protocol');
const { RealSocket, SEQ_RESET_THRESHOLD } = require('./real-socket');
const { InterfaceDetector } = require('./interface-detector');
const { NetworkWatchDog } = require('./network-watchdog');
const { EventEmitter } = require('node:events');

// Grace period before cleaning up completed-stream dedup/seq state.
// Must exceed the maximum keepalive timeout (45 s multipath / 10 s single)
// so late duplicate frames from a slow multipath path are still caught.
const STREAM_CLEANUP_GRACE_MS = 60000;

// Relaxed keepalive for multipath (redundant connections, less urgency)
const MP_KEEPALIVE = {
  pingInterval: 15000,
  pongTimeout: 45000,
  watchdogTimeout: 60000,
  backpressureTimeout: 20000
};

class VirtualSocket extends EventEmitter {
  /**
   * @param {Object} config - Tunnel config (serverHost, serverPort, clientKey, etc.)
   */
  constructor(config) {
    super();
    this.config = config;
    this.realSockets = new Map(); // interfaceName -> RealSocket
    this.seqCounters = new Map(); // streamId -> nextSeqNo
    this.dedupWindows = new Map(); // streamId -> DedupWindow
    this.cleanupTimers = new Map(); // streamId -> setTimeout handle (TTL cleanup)
    this.detector = null;
    this.networkWatchdog = null;
    this.destroyed = false;
    this._readyEmitted = false;
    this._failureCount = new Map(); // interfaceName -> consecutive failures
  }

  /**
   * Start the multipath system: detect interfaces and connect.
   */
  start() {
    if (process.env.MULTIPATH_ENABLED === 'true') {
      // Multipath: detector manages all connections — no default
      this.detector = new InterfaceDetector({
        serverHost: this.config.serverHost,
        serverPort: this.config.serverPort
      });
      this.detector.on('change', (interfaces) => {
        this._syncInterfaces(interfaces);
      });
      this.detector.start();
    } else {
      // Single-connection: default socket + network watchdog
      this._createRealSocket('default', null);
      this.networkWatchdog = new NetworkWatchDog(() => {
        console.log(`[${new Date().toISOString()}] [virtual-socket] network change detected, reconnecting`);
        for (const rs of this.realSockets.values()) {
          if (rs.socket) rs.socket.destroy();
        }
      }, { pollInterval: 200 });
      this.networkWatchdog.start();
    }
  }

  _syncInterfaces(interfaces) {
    const activeByName = new Map(interfaces.map(i => [i.name, i.ip]));

    // Remove sockets for interfaces that disappeared, or recreate sockets when
    // the same interface name gets a new IP (common when WiFi changes networks).
    for (const [name, rs] of [...this.realSockets]) {
      if (name === 'default') continue;

      if (!activeByName.has(name)) {
        console.log(`[${new Date().toISOString()}] [virtual-socket] Removing disappeared interface: ${name}`);
        this._removeRealSocket(name, rs);
        continue;
      }

      const nextIp = activeByName.get(name);
      const currentIp = this._getSocketLocalAddress(rs);
      if (currentIp !== nextIp) {
        console.log(`[${new Date().toISOString()}] [virtual-socket] Interface ${name} IP changed: ${currentIp || 'auto'} -> ${nextIp || 'auto'}, reconnecting`);
        this._removeRealSocket(name, rs);
        continue;
      }

      this._failureCount.delete(name);
    }

    // Add sockets for new interfaces or interfaces removed above for IP change.
    for (const iface of interfaces) {
      if (!this.realSockets.has(iface.name)) {
        this._createRealSocket(iface.name, iface.ip);
      }
    }

    // Emit ready when we have at least one connection
    if (this.realSockets.size > 0) {
      this._checkReady();
    }
  }

  _getSocketLocalAddress(rs) {
    return rs?.config?.localAddress ?? rs?.localAddress ?? null;
  }

  _removeRealSocket(interfaceName, rs) {
    if (this.realSockets.get(interfaceName) === rs) {
      this.realSockets.delete(interfaceName);
    }
    this._failureCount.delete(interfaceName);
    if (rs && typeof rs.destroy === 'function') {
      rs.destroy();
    }
  }

  _createRealSocket(interfaceName, localAddress) {
    const rsConfig = {
      ...this.config,
      interfaceName,
      localAddress
    };

    // Use relaxed keepalive in multipath mode
    if (process.env.MULTIPATH_ENABLED === 'true') {
      Object.assign(rsConfig, MP_KEEPALIVE);
    }

    const rs = new RealSocket(rsConfig);

    rs.on('status', (status) => {
      if (this.realSockets.get(interfaceName) !== rs) return;

      if (status === 'disconnected') {
        this._resetSessionStateIfFullyDisconnected();
        return;
      }

      if (status === 'failed') {
        this.realSockets.delete(interfaceName);
        this._resetSessionStateIfFullyDisconnected();
        this._checkAllFailed();
      }
    });

    rs.on('connected', () => {
      this.emit('socketConnected', interfaceName);
      this._checkReady();
    });

    rs.on('frame', (frame) => {
      this._onFrame(frame);
    });

    rs.on('resetSeq', (frame) => {
      this._handleResetSeq(frame);
    });

    rs.start();
    this.realSockets.set(interfaceName, rs);
  }

  _checkReady() {
    if (this._readyEmitted) return;
    const connected = [...this.realSockets.values()].filter(rs => rs.isConnected());
    if (connected.length > 0) {
      this._readyEmitted = true;
      this.emit('ready');
    }
  }

  _resetSessionStateIfFullyDisconnected() {
    const connected = [...this.realSockets.values()].filter(rs => rs.isConnected());
    if (connected.length > 0) return;

    // Once every physical tunnel socket is gone, no late duplicate frames from
    // the previous virtual session can arrive. Clear dedup/sequence state so a
    // reconnect to a fresh server-side session can safely reuse stream IDs.
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.seqCounters.clear();
    this.dedupWindows.clear();
  }

  _checkAllFailed() {
    const connected = [...this.realSockets.values()].filter(rs => rs.isConnected());
    if (connected.length === 0) {
      this.emit('error', new Error('All connections failed'));
    }
  }

  /**
   * Write a frame (encoded buffer — 13-byte header).
   * Patches the seqNo field for data frames, then duplicates to all connections.
   */
  write(buf) {
    if (this.destroyed) return false;

    const type = buf.readUInt8(4);
    let seqNo = 0;
    let writeOk = false;

    if (!CONTROL_FRAME_TYPES.has(type)) {
      const streamId = buf.readUInt32BE(0);
      seqNo = (this.seqCounters.get(streamId) || 0) + 1;

      if (seqNo > SEQ_RESET_THRESHOLD) {
        this._sendResetSeq(streamId);
        seqNo = 0;
      }

      this.seqCounters.set(streamId, seqNo);
      buf.writeUInt32BE(seqNo, 5);

      // When the client sends outbound FIN/ERROR the response is complete
      // and the stream is fully done in both directions. Schedule TTL
      // cleanup. (Inbound FIN only ended the request body — the response
      // may still be streaming, so cleanup is deferred to here.)
      if (type === FrameType.FIN || type === FrameType.ERROR) {
        this._scheduleStreamCleanup(streamId);
      }
    }

    for (const rs of this.realSockets.values()) {
      if (rs.isConnected()) {
        if (rs.write(buf)) writeOk = true;
      }
    }

    if (!writeOk) {
      this.emit('error', new Error('All socket writes failed'));
    }

    return writeOk;
  }

  /**
   * Send a RESET_SEQ for one or more streams
   */
  _sendResetSeq(streamId) {
    const frame = encodeFrame(0, FrameType.RESET_SEQ, JSON.stringify({
      streams: [streamId]
    }), 0);

    let sent = false;
    for (const rs of this.realSockets.values()) {
      if (rs.isConnected()) {
        if (rs.write(frame)) sent = true;
      }
    }

    if (sent) {
      this.seqCounters.set(streamId, 0);
    }
  }

  _handleResetSeq(frame) {
    try {
      const data = JSON.parse(frame.payload.toString());
      for (const streamId of data.streams) {
        this.dedupWindows.delete(streamId);
        this._cancelStreamCleanup(streamId); // Protect seqCounters from stale TTL timer
        // Do NOT reset seqCounters — that's the outbound counter.
        // RESET_SEQ from remote means "remote reset its outbound",
        // so we only clear our incoming dedup window.
      }
    } catch { /* ignore malformed */ }
  }

  _onFrame(frame) {
    // Control frames are connection-local, emit directly
    if (frame.streamId === 0 && frame.type !== FrameType.HEADERS && frame.type !== FrameType.DATA && frame.type !== FrameType.FIN && frame.type !== FrameType.ERROR && frame.type !== FrameType.UPGRADE) {
      return; // PING/PONG/INIT/RESET_SEQ handled by RealSocket
    }

    // Data frame — dedup check
    const streamId = frame.streamId;

    if (frame.type === FrameType.FIN || frame.type === FrameType.ERROR) {
      // Run through dedup — only deliver the first copy
      let window = this.dedupWindows.get(streamId);
      if (!window) {
        window = new DedupWindow(frame.seqNo);
        window.checkAndAdd(frame.seqNo);
        this.dedupWindows.set(streamId, window);
      } else {
        const result = window.checkAndAdd(frame.seqNo);
        if (result === 'duplicate') return;
      }
      // Keep dedupWindow to catch late multipath duplicates.
      // Do NOT delete seqCounters: the outbound seqNo must keep growing
      // across stream-ID reuses so the server's dedup window sees a
      // higher seqNo instead of treating the new stream as a duplicate.
      //
      // Only schedule TTL cleanup on inbound ERROR (server abort — both
      // directions are done). For inbound FIN (end-of-request-body), the
      // response may still be streaming (e.g. SSE); cleanup is scheduled
      // when the client sends its outbound FIN/ERROR in write().
      if (frame.type === FrameType.ERROR) {
        this._scheduleStreamCleanup(streamId);
      }
      this.emit('frame', frame);
      return;
    }

    let window = this.dedupWindows.get(streamId);
    if (!window) {
      window = new DedupWindow(frame.seqNo);
      window.checkAndAdd(frame.seqNo); // Mark initial seqNo
      this.dedupWindows.set(streamId, window);
      this._cancelStreamCleanup(streamId); // New stream — cancel any pending cleanup
      this.emit('frame', frame);
      return;
    }

    const result = window.checkAndAdd(frame.seqNo);
    if (result === 'duplicate') return;

    // Non-duplicate HEADERS/UPGRADE for an existing window means stream-ID reuse.
    // Cancel any pending TTL cleanup so the active stream's state isn't deleted.
    if (frame.type === FrameType.HEADERS || frame.type === FrameType.UPGRADE) {
      this._cancelStreamCleanup(streamId);
    }

    this.emit('frame', frame);
  }

  /**
   * Schedule TTL cleanup of dedup/seq state for a completed stream.
   * The grace period catches late multipath duplicates while bounding memory.
   */
  _scheduleStreamCleanup(streamId) {
    this._cancelStreamCleanup(streamId);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(streamId);
      this.dedupWindows.delete(streamId);
      this.seqCounters.delete(streamId);
    }, STREAM_CLEANUP_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.cleanupTimers.set(streamId, timer);
  }

  _cancelStreamCleanup(streamId) {
    const timer = this.cleanupTimers.get(streamId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(streamId);
    }
  }

  get maxConcurrentStreams() {
    // Return the max from the first connected socket, or default
    for (const rs of this.realSockets.values()) {
      if (rs.isConnected()) return rs.serverSettings.maxConcurrentStreams;
    }
    return 100;
  }

  isConnected() {
    for (const rs of this.realSockets.values()) {
      if (rs.isConnected()) return true;
    }
    return false;
  }

  destroy() {
    this.destroyed = true;
    if (this.detector) {
      this.detector.stop();
      this.detector = null;
    }
    if (this.networkWatchdog) {
      this.networkWatchdog.stop();
      this.networkWatchdog = null;
    }
    for (const rs of this.realSockets.values()) {
      rs.destroy();
    }
    this.realSockets.clear();
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    this.dedupWindows.clear();
    this.seqCounters.clear();
    this.removeAllListeners();
  }
}

module.exports = { VirtualSocket };
