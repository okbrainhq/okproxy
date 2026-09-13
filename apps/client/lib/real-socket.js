// One authenticated TLS lane. Reconnect callbacks are fenced by socket identity;
// the virtual owner validates both session nonces BEFORE enabling data traffic.
const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { VERSION, CAPABILITY, compatible, validNonce, nonce, SEQ_RESET_THRESHOLD, MAX_LANE_BYTES } = require('../../../packages/frame-protocol/transport-session');
const DEFAULT_PING_INTERVAL = 3000;
const DEFAULT_PONG_TIMEOUT = 10000;
class RealSocket extends EventEmitter {
  constructor(config) {
    super(); this.config = config;
    this.socket = null; this.initialized = false; this.destroyed = false;
    this.reconnectDelay = 500; this.reconnectAttempts = 0; this.reconnectTimer = null;
    this.keepaliveTimer = null; this.watchdogTimer = null; this._initResponseTimer = null;
    this.blockedSince = null; this.lastActivity = 0; this.lastPongTime = 0;
    this.serverSettings = { maxConcurrentStreams: 100 };
    this.clientSession = config.clientSession || nonce();
    this.serverSession = null;
    this._pingInterval = config.pingInterval || DEFAULT_PING_INTERVAL;
    this._pongTimeout = config.pongTimeout || DEFAULT_PONG_TIMEOUT;
    this._watchdogTimeout = config.watchdogTimeout || 35000;
    this._backpressureTimeout = config.backpressureTimeout || 8000;
  }
  start() { this.destroyed = false; this._connect(); }
  _connect() {
    if (this.destroyed) return;
    const hello = this.config.getSession?.() || { clientSession: this.clientSession };
    const sock = connect({ host: this.config.serverHost, port: this.config.serverPort,
      key: readFileSync(this.config.clientKey), cert: readFileSync(this.config.clientCert),
      ca: readFileSync(this.config.caCert), rejectUnauthorized: true,
      ...(this.config.localAddress ? { localAddress: this.config.localAddress } : {}) });
    this.socket = sock; this.initialized = false; this.serverSession = null;
    this.blockedSince = null;
    this.emit('status', 'connecting');
    const timeout = setTimeout(() => sock.destroy(), 25000);
    const current = () => !this.destroyed && this.socket === sock && !sock.destroyed;
    sock.on('secureConnect', () => {
      if (!current()) return;
      clearTimeout(timeout); sock.setKeepAlive(true, 30000);
      this._writeRaw(sock, encodeFrame(0, FrameType.INIT, JSON.stringify({
        version: VERSION, capability: CAPABILITY, clientSession: hello.clientSession,
        interface: this.config.interfaceName, maxFrameSize: 1048576, domains: this.config.domains || []
      })));
      this._initResponseTimer = setTimeout(() => sock.destroy(), 10000);
    });
    const decoder = createFrameDecoder(frame => {
      if (!current()) return;
      this.lastActivity = this._now();
      if (!this.initialized) {
        if (frame.streamId !== 0 || frame.type !== FrameType.INIT || frame.seqNo !== 0) { sock.destroy(); return; }
        let settings;
        try { settings = JSON.parse(frame.payload.toString()); } catch { sock.destroy(); return; }
        if (!compatible(settings) || settings.clientSession !== hello.clientSession || !validNonce(settings.serverSession) ||
            !Number.isInteger(settings.maxConcurrentStreams) || settings.maxConcurrentStreams < 1 || settings.maxConcurrentStreams > 4096) {
          sock.destroy(); return;
        }
        // A callback may synchronously cancel this lane and every old lane.
        if (this.config.acceptSession && !this.config.acceptSession(settings, this, hello)) { sock.destroy(); return; }
        if (!current()) return;
        this.serverSession = settings.serverSession;
        this.clientSession = hello.clientSession;
        this.serverSettings = settings;
        this.initialized = true;
        clearTimeout(this._initResponseTimer); this._initResponseTimer = null;
        this.reconnectDelay = 500; this.reconnectAttempts = 0;
        this._startKeepalive(); this._startWatchdog();
        this.emit('status', 'connected'); this.emit('connected'); return;
      }
      if (frame.streamId === 0) {
        if (frame.seqNo === 0 && frame.payload.length === 0 && frame.type === FrameType.PING) {
          this._writeRaw(sock, encodeFrame(0, FrameType.PONG, Buffer.alloc(0))); return;
        }
        if (frame.seqNo === 0 && frame.payload.length === 0 && frame.type === FrameType.PONG) { this.lastPongTime = this._now(); return; }
        this.emit('protocolFailure', 'unexpected-control-or-RESET_SEQ'); sock.destroy(); return;
      }
      this.emit('frame', frame);
    }, () => sock.destroy());
    this.decoder = decoder;
    sock.on('data', decoder);
    sock.on('drain', () => { if (this.socket === sock) this.blockedSince = null; });
    sock.on('error', () => sock.destroy());
    sock.on('close', () => {
      decoder.destroy();
      clearTimeout(timeout);
      if (this.socket !== sock) return;
      const established = this.initialized;
      this.initialized = false;
      clearTimeout(this._initResponseTimer); this._initResponseTimer = null;
      this._stopKeepalive(); this._stopWatchdog();
      this.emit('status', 'disconnected', established);
      if (!this.destroyed) this._scheduleReconnect();
    });
  }
  _writeRaw(sock, data) {
    if (!sock || sock.destroyed) return false;
    try {
      const result = sock.write(data);
      if (!result && this.blockedSince === null) this.blockedSince = this._now();
      if (sock.writableLength > (this.config.maxLaneBufferBytes || MAX_LANE_BYTES)) {
        this.emit('protocolFailure', 'lane-buffer-limit'); sock.destroy(); return false;
      }
      return result;
    } catch { sock.destroy(); return false; }
  }
  _scheduleReconnect() {
    if (this.reconnectTimer || this.destroyed) return;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 3000);
  }
  _now() { return performance.now(); }
  _recordActivity() { this.lastActivity = this._now(); }
  _startKeepalive() {
    this._stopKeepalive(); this.lastPongTime = this._now();
    this.keepaliveTimer = setInterval(() => {
      if (!this.isConnected()) return;
      if (this.socket.writableNeedDrain && this.blockedSince === null) this.blockedSince = this._now();
      if ((this.blockedSince !== null && this._now() - this.blockedSince > this._backpressureTimeout) ||
          this._now() - this.lastPongTime > this._pongTimeout) { this.socket.destroy(); return; }
      this._writeRaw(this.socket, encodeFrame(0, FrameType.PING, Buffer.alloc(0)));
    }, this._pingInterval);
  }
  _startWatchdog() {
    this._stopWatchdog(); this.lastActivity = this._now();
    this.watchdogTimer = setInterval(() => {
      if (this.isConnected() && this._now() - this.lastActivity > this._watchdogTimeout) this.socket.destroy();
    }, 5000);
  }
  _stopKeepalive() { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  _stopWatchdog() { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  write(data) { return this.isConnected() ? this._writeRaw(this.socket, data) : false; }
  isConnected() { return Boolean(this.socket && !this.socket.destroyed && this.initialized); }
  // Raw lane pauses cannot keep control readable. Reject instead of hiding a
  // timeout; production flow control lives in TransportSession's bounded queues.
  pause() { this.emit('protocolFailure', 'raw-lane-pause-forbidden'); this.socket?.destroy(); }
  resume() {}
  destroy() {
    this.destroyed = true; this.initialized = false;
    this._stopKeepalive(); this._stopWatchdog();
    clearTimeout(this._initResponseTimer); this._initResponseTimer = null;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    this.socket?.destroy();
    this.emit('status', 'failed'); this.removeAllListeners();
  }
}
module.exports = { RealSocket, SEQ_RESET_THRESHOLD, DEFAULT_PING_INTERVAL, DEFAULT_PONG_TIMEOUT };
