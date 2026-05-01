// VirtualSocket — Multipath virtual socket layer
// Duplicates traffic across all available network interfaces

const { encodeFrame, FrameType, CONTROL_FRAME_TYPES, DedupWindow } = require('../../../packages/frame-protocol');
const { RealSocket, SEQ_RESET_THRESHOLD } = require('./real-socket');
const { InterfaceDetector } = require('./interface-detector');
const { NetworkWatchDog } = require('./network-watchdog');
const { EventEmitter } = require('node:events');

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
    const activeNames = new Set(interfaces.map(i => i.name));

    // Remove sockets for interfaces that disappeared
    for (const [name, rs] of this.realSockets) {
      if (name === 'default') continue;
      if (!activeNames.has(name)) {
        const fails = (this._failureCount.get(name) || 0) + 1;
        this._failureCount.set(name, fails);
        if (fails >= 3) {
          console.log(`[${new Date().toISOString()}] [virtual-socket] Removing interface: ${name}`);
          rs.destroy();
          this.realSockets.delete(name);
          this._failureCount.delete(name);
        }
      } else {
        this._failureCount.delete(name);
      }
    }

    // Add sockets for new interfaces
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
      if (status === 'failed') {
        this.realSockets.delete(interfaceName);
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
      // Only clean seqCounters — keep dedupWindow to catch late duplicates.
      // It'll be cleaned up when stream ID is reused or session ends.
      this.seqCounters.delete(streamId);
      this.emit('frame', frame);
      return;
    }

    let window = this.dedupWindows.get(streamId);
    if (!window) {
      window = new DedupWindow(frame.seqNo);
      window.checkAndAdd(frame.seqNo); // Mark initial seqNo
      this.dedupWindows.set(streamId, window);
      this.emit('frame', frame);
      return;
    }

    const result = window.checkAndAdd(frame.seqNo);
    if (result === 'duplicate') return;

    this.emit('frame', frame);
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
    this.dedupWindows.clear();
    this.seqCounters.clear();
    this.removeAllListeners();
  }
}

module.exports = { VirtualSocket };
