// Virtual transport: multipath/parallel lanes share one explicit v2 session.
// Fail closed on ANY lane loss; there is no claim of transparent replay.
const { EventEmitter } = require('node:events');
const { FrameType } = require('../../../packages/frame-protocol');
const { TransportSession, onceAnyDrain, nonce, MAX_LANE_BYTES, MAX_LANES, positive } = require('../../../packages/frame-protocol/transport-session');
const { RealSocket } = require('./real-socket');
const { InterfaceDetector } = require('./interface-detector');
const { NetworkWatchDog } = require('./network-watchdog');
function normalizeParallelSockets(value) {
  const n = Number(value); return Number.isFinite(n) && n >= 1 ? Math.min(32, Math.floor(n)) : 1;
}
class VirtualSocket extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.realSockets = new Map();
    this.detector = null; this.networkWatchdog = null; this.destroyed = false;
    this._readyEmitted = false; this._failureCount = new Map(); this._retiredSockets = new WeakSet();
    this.parallelSockets = normalizeParallelSockets(config.parallelSockets ?? process.env.OKPROXY_PARALLEL_SOCKETS);
    this.streamOutboundSockets = new Map(); this.streamOptions = new Map(); this.roundRobinCursor = 0;
    this.sessionGeneration = 0; this.clientSession = nonce(); this.serverSession = null;
    this._sessionActive = false; this._resetting = false;
    this.maxLaneBufferBytes = positive(config.maxLaneBufferBytes, MAX_LANE_BYTES);
    this.transport = this._newTransport();
  }
  _newTransport() {
    return new TransportSession({ ...this.config, initiator: false,
      deliver: frame => this.emit('frame', frame),
      fatal: reason => this._failSession(reason),
      retire: id => { this.streamOutboundSockets.delete(id); this.streamOptions.delete(id); }
    });
  }
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
      // Single-connection: one or more parallel sockets + network watchdog
      this._ensureInterfaceSockets('default', null);
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
      const baseName = this._baseInterfaceName(name);
      if (baseName === 'default') continue;

      if (!activeByName.has(baseName)) {
        console.log(`[${new Date().toISOString()}] [virtual-socket] Removing disappeared interface: ${name}`);
        this._removeRealSocket(name, rs);
        continue;
      }

      const nextIp = activeByName.get(baseName);
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
      this._ensureInterfaceSockets(iface.name, iface.ip);
    }

    // Emit ready when we have at least one connection
    if (this.realSockets.size > 0) {
      this._checkReady();
    }
  }

  _socketName(interfaceName, laneIndex) {
    if (this.parallelSockets <= 1) return interfaceName;
    return `${interfaceName}#${laneIndex + 1}`;
  }

  _baseInterfaceName(socketName) {
    const match = /^(.*)#([0-9]+)$/.exec(socketName);
    return match ? match[1] : socketName;
  }

  _ensureInterfaceSockets(interfaceName, localAddress) {
    for (let lane = 0; lane < this.parallelSockets; lane++) {
      const socketName = this._socketName(interfaceName, lane);
      if (!this.realSockets.has(socketName)) {
        this._createRealSocket(socketName, localAddress);
      }
    }
  }

  _getSocketLocalAddress(rs) {
    return rs?.config?.localAddress ?? rs?.localAddress ?? null;
  }

  _removeRealSocket(interfaceName, rs) {
    this._retireRealSocket(interfaceName, rs);
    if (rs && typeof rs.destroy === 'function') {
      rs.destroy();
    }
  }


  _retireRealSocket(name, rs) {
    if (!rs || this._retiredSockets.has(rs)) return;
    this._retiredSockets.add(rs);
    if (rs.clientSession === this.clientSession && rs.serverSession) this._failSession('interface-retired');
    if (this.realSockets.get(name) === rs) this.realSockets.delete(name);
    this._failureCount.delete(name);
  }
  _createRealSocket(interfaceName, localAddress) {
    if (this.realSockets.size >= MAX_LANES) return;
    const rs = new RealSocket({ ...this.config, interfaceName, localAddress,
      getSession: () => ({ clientSession: this.clientSession }),
      acceptSession: (settings, lane, hello) => this._acceptSession(settings, lane, hello)
    });
    this.realSockets.set(interfaceName, rs);
    rs.on('status', (status, established) => {
      if (status === 'disconnected' && established && rs.clientSession === this.clientSession) this._failSession('transport-lane-lost');
      if (status === 'failed') this._retireRealSocket(interfaceName, rs);
    });
    rs.on('connected', () => { this.emit('socketConnected', interfaceName); this._checkReady(); });
    rs.on('frame', frame => this._onFrame(frame, rs));
    rs.on('protocolFailure', reason => {
      if (rs.clientSession === this.clientSession && rs.serverSession) this._failSession(reason);
    });
    rs.start();
  }
  _acceptSession(settings, rs, hello) {
    if (this.destroyed || hello.clientSession !== this.clientSession || ![...this.realSockets.values()].includes(rs)) return false;
    if (this.serverSession && settings.serverSession !== this.serverSession) {
      // A fresh server session may reuse ID 1 while an old lane's close is
      // unobserved. Abort old target work BEFORE any new lane is writable.
      this._failSession('peer-session-changed'); return false;
    }
    this.serverSession = settings.serverSession; this._sessionActive = true;
    this.transport.maxStreams = Math.min(positive(this.config.maxTrackedStreams, settings.maxConcurrentStreams), settings.maxConcurrentStreams);
    return true;
  }
  _failSession(reason) {
    if (this._resetting || this.destroyed) return;
    this._resetting = true;
    const wasActive = this._sessionActive || this.transport.streams.size > 0;
    this._sessionActive = false;
    this.serverSession = null; this.clientSession = nonce();
    this.transport.failed = true; this.transport.clear();
    this.streamOptions.clear(); this.streamOutboundSockets.clear();
    if (wasActive) {
      this.sessionGeneration++;
      this.emit('sessionReset', { generation: this.sessionGeneration, reason });
    }
    for (const rs of this.realSockets.values()) rs.socket?.destroy();
    this.transport = this._newTransport();
    this._resetting = false;
  }
  _resetSessionStateIfFullyDisconnected() {
    if (!this.isConnected() && this._sessionActive) { this._failSession('disconnected'); return true; }
    return false;
  }
  _checkReady() {
    if (!this._readyEmitted && this.isConnected()) { this._readyEmitted = true; this.emit('ready'); }
  }
  _onFrame(frame, source) {
    if (!source || !this._allConnectedRealSockets().some(([, rs]) => rs === source)) return;
    this.transport.receive(frame);
  }
  write(buf) {
    if (this.destroyed || this._resetting || !this._sessionActive) return false;
    const id = buf.readUInt32BE(0), type = buf.readUInt8(4);
    if (id === 0 || type === FrameType.RESET_SEQ) { this._failSession('unexpected-control-send'); return false; }
    if (!this.transport.prepare(buf)) return false;
    const targets = this._isSingleFlowStream(id) ? this._selectOutboundRealSocket(id) : this._allConnectedRealSockets();
    const result = this._writeToRealSockets(buf, targets);
    if (type === FrameType.FIN || type === FrameType.ERROR) this.transport.drop(id);
    return result;
  }
  _allConnectedRealSockets() {
    return [...this.realSockets.entries()].filter(([, rs]) => rs.isConnected() &&
      rs.clientSession === this.clientSession && rs.serverSession === this.serverSession);
  }
  _writeToRealSockets(buf, entries) {
    if (!entries.length) { this._failSession('no-writable-lane'); return false; }
    let writable = false;
    const session = this.clientSession;
    for (const [, rs] of entries) {
      if (session !== this.clientSession) return false;
      try {
        if (!rs.isConnected()) throw new Error('lane closed');
        writable = rs.write(buf) || writable;
        if (rs.socket.writableLength > this.maxLaneBufferBytes) throw new Error('lane-buffer-limit');
      } catch (err) { this._failSession(err.message); return false; }
    }
    return session === this.clientSession && writable;
  }
  setStreamMode(id, options = {}) {
    if (!this.transport.streams.has(id)) return;
    if (options.singleFlow) this.streamOptions.set(id, { singleFlow: true });
    else { this.streamOptions.delete(id); this.streamOutboundSockets.delete(id); }
  }
  clearStreamMode(id) { this.transport.drop(id); this.streamOptions.delete(id); this.streamOutboundSockets.delete(id); }
  _isSingleFlowStream(id) { return this.streamOptions.get(id)?.singleFlow === true; }
  _selectOutboundRealSocket(streamId) {
    const existingName = this.streamOutboundSockets.get(streamId);
    const existing = existingName ? this.realSockets.get(existingName) : null;
    if (existing && existing.isConnected()) return [[existingName, existing]];

    const connected = this._allConnectedRealSockets();
    if (connected.length === 0) return [];

    const loadByName = new Map();
    for (const name of this.streamOutboundSockets.values()) {
      if (this.realSockets.has(name)) loadByName.set(name, (loadByName.get(name) || 0) + 1);
    }

    let best = null;
    let bestScore = Infinity;
    const start = connected.length > 0 ? this.roundRobinCursor % connected.length : 0;

    for (let i = 0; i < connected.length; i++) {
      const index = (start + i) % connected.length;
      const [name, rs] = connected[index];
      const load = loadByName.get(name) || 0;
      const score = load + (rs.socket?.writableNeedDrain ? 1000000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { name, rs, index };
      }
    }

    if (!best) return [];
    this.roundRobinCursor = (best.index + 1) % connected.length;
    this.streamOutboundSockets.set(streamId, best.name);
    return [[best.name, best.rs]];
  }

  _getOutboundSocketsForStream(streamId) {
    const name = this.streamOutboundSockets.get(streamId);
    const rs = name ? this.realSockets.get(name) : null;
    return rs && rs.isConnected() && rs.socket ? [rs.socket] : [];
  }


  onceDrain(callback) { return onceAnyDrain(this._allConnectedRealSockets().map(([, rs]) => rs.socket), callback); }
  onceDrainForStream(id, callback) {
    const state = this.transport.streams.get(id);
    if (!state) return () => {};
    const sockets = this._isSingleFlowStream(id) ? this._getOutboundSocketsForStream(id) : this._allConnectedRealSockets().map(([, rs]) => rs.socket);
    return onceAnyDrain(sockets, callback, state);
  }
  pauseStream(id) { this.transport.pause(id); }
  resumeStream(id) { this.transport.resume(id); }
  pause() { this.transport.pauseAll(); }
  resume() { this.transport.resumeAll(); }
  _handleResetSeq() { this._failSession('RESET_SEQ-forbidden-in-v2'); }
  _sendResetSeq() { this._failSession('sequence-exhausted'); }
  _failStream(id, reason) { this._failSession(reason); }
  get maxConcurrentStreams() { return this.transport.maxStreams; }
  isConnected() { return this._allConnectedRealSockets().length > 0; }
  destroy() {
    if (this.destroyed) return;
    this._failSession('destroyed'); this.destroyed = true;
    this.detector?.stop(); this.networkWatchdog?.stop();
    for (const rs of [...this.realSockets.values()]) rs.destroy();
    this.realSockets.clear(); this.transport.clear(); this.removeAllListeners();
  }
}
module.exports = { VirtualSocket };
