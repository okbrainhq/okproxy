// RealSocket — Single TLS connection bound to a specific network interface
// Refactored from tls-connection.js with localAddress binding and interface ID in INIT

const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { EventEmitter } = require('node:events');

const INITIAL_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 3000;

// Default keepalive for single-connection (aggressive)
const DEFAULT_WATCHDOG_TIMEOUT = 35000;
const DEFAULT_PING_INTERVAL = 3000;
const DEFAULT_PONG_TIMEOUT = 10000;
const DEFAULT_BACKPRESSURE_TIMEOUT = 8000;

const CONNECTION_TIMEOUT = 25000;
const INIT_RESPONSE_TIMEOUT = 10000; // 10s for server INIT ACK
const SEQ_RESET_THRESHOLD = 0xFFFFFF0F; // 2^32 - 1,000,000 ~ roughly

class RealSocket extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.serverHost
   * @param {number} config.serverPort
   * @param {string} config.clientKey
   * @param {string} config.clientCert
   * @param {string} config.caCert
   * @param {string} config.interfaceName - e.g. 'en0'
   * @param {string} config.localAddress - IP to bind to
   */
  constructor(config) {
    super();
    this.config = config;
    this.socket = null;
    this.decoder = null;
    this.initialized = false;
    this.destroyed = false;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.watchdogTimer = null;
    this.lastActivity = 0;
    this.keepaliveTimer = null;
    this.lastPongTime = 0;
    this.lastWriteOk = 0;
    this._initResponseTimer = null;
    this.serverSettings = { maxConcurrentStreams: 100 };
    // Keepalive timing — allows multipath to relax
    this._pingInterval = config.pingInterval || DEFAULT_PING_INTERVAL;
    this._pongTimeout = config.pongTimeout || DEFAULT_PONG_TIMEOUT;
    this._watchdogTimeout = config.watchdogTimeout || DEFAULT_WATCHDOG_TIMEOUT;
    this._backpressureTimeout = config.backpressureTimeout || DEFAULT_BACKPRESSURE_TIMEOUT;
  }

  start() {
    this.destroyed = false;
    this._connect();
  }

  _connect() {
    if (this.destroyed) return;

    const tlsOptions = {
      host: this.config.serverHost,
      port: this.config.serverPort,
      key: readFileSync(this.config.clientKey),
      cert: readFileSync(this.config.clientCert),
      ca: readFileSync(this.config.caCert),
      rejectUnauthorized: true
    };

    if (this.config.localAddress) {
      tlsOptions.localAddress = this.config.localAddress;
    }

    const connectionTimeout = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] Connection timeout (${CONNECTION_TIMEOUT/1000}s), destroying socket`);
      if (this.socket) this.socket.destroy();
    }, CONNECTION_TIMEOUT);

    this.emit('status', 'connecting');

    this.socket = connect(tlsOptions, () => {
      clearTimeout(connectionTimeout);
      this.socket.setKeepAlive(true, 30000);

      // Intercept write for backpressure detection
      this.lastWriteOk = Date.now();
      const originalWrite = this.socket.write.bind(this.socket);
      this.socket.write = (data, encoding, cb) => {
        const result = originalWrite(data, encoding, cb);
        if (result) this.lastWriteOk = Date.now();
        return result;
      };
      this.socket.on('drain', () => {
        this.lastWriteOk = Date.now();
      });

      // Send INIT with interface name
      this.socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
        interface: this.config.interfaceName,
        maxFrameSize: 1048576
      })));

      // Set a timeout for INIT response
      const initResponseTimer = setTimeout(() => {
        if (!this.initialized && this.socket && !this.socket.destroyed) {
          console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] INIT response timeout (${INIT_RESPONSE_TIMEOUT/1000}s)`);
          this.socket.destroy();
        }
      }, INIT_RESPONSE_TIMEOUT);

      // Store for cleanup
      this._initResponseTimer = initResponseTimer;
    });

    this.initialized = false;

    this.decoder = createFrameDecoder(
      (frame) => {
        this._recordActivity();

        if (!this.initialized) {
          if (frame.streamId === 0 && frame.type === FrameType.INIT) {
            this.initialized = true;
            clearTimeout(connectionTimeout);
            if (this._initResponseTimer) {
              clearTimeout(this._initResponseTimer);
              this._initResponseTimer = null;
            }
            this.reconnectDelay = INITIAL_RECONNECT_DELAY;
            if (this.reconnectAttempts > 0) {
              console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] Reconnected after ${this.reconnectAttempts} attempt(s)`);
            }
            this.reconnectAttempts = 0;
            try {
              const settings = JSON.parse(frame.payload.toString());
              if (settings.maxConcurrentStreams) {
                this.serverSettings.maxConcurrentStreams = settings.maxConcurrentStreams;
              }
            } catch { /* use defaults */ }
            this._startWatchdog();
            this._startKeepalive();
            this.emit('status', 'connected');
            this.emit('connected');
            return;
          }
          this.socket.destroy();
          return;
        }

        // Handle control frames
        if (frame.streamId === 0) {
          if (frame.type === FrameType.PING) {
            console.log(`[${this.config.interfaceName}] ${new Date().toISOString()} received PING, sending PONG`);
            this.socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
            return;
          }
          if (frame.type === FrameType.PONG) {
            console.log(`[${this.config.interfaceName}] ${new Date().toISOString()} received PONG`);
            this.lastPongTime = Date.now();
            return;
          }
          if (frame.type === FrameType.RESET_SEQ) {
            this.emit('resetSeq', frame);
            return;
          }
        }

        // Data frames
        this.emit('frame', frame);
      },
      (err) => {
        console.error(`[${this.config.interfaceName}] Protocol error:`, err.message);
        this.socket.destroy();
      }
    );

    this.socket.on('data', this.decoder);

    this.socket.on('error', (err) => {
      clearTimeout(connectionTimeout);
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
        console.error(`[${this.config.interfaceName}] TLS error:`, err.message);
      }
    });

    this.socket.on('close', () => {
      clearTimeout(connectionTimeout);
      if (this._initResponseTimer) {
        clearTimeout(this._initResponseTimer);
        this._initResponseTimer = null;
      }
      this.initialized = false;
      this._stopWatchdog();
      this._stopKeepalive();
      this.emit('status', 'disconnected');
      if (!this.destroyed) {
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] Reconnect attempt #${this.reconnectAttempts} in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  _startWatchdog() {
    this.lastActivity = Date.now();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (!this.initialized || !this.socket || this.socket.destroyed) return;
      const idleTime = Date.now() - this.lastActivity;
      if (idleTime > this._watchdogTimeout) {
        console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] watchdog: no activity for ${Math.round(idleTime/1000)}s, closing`);
        this.socket.destroy();
      }
    }, 5000);
  }

  _stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  _startKeepalive() {
    this.lastPongTime = Date.now();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (!this.initialized || !this.socket || this.socket.destroyed) return;

      if (Date.now() - this.lastWriteOk > this._backpressureTimeout) {
        console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] backpressure: socket not drained, reconnecting`);
        this.socket.destroy();
        return;
      }

      if (Date.now() - this.lastPongTime > this._pongTimeout) {
        console.log(`[${new Date().toISOString()}] [${this.config.interfaceName}] keepalive: no PONG for ${Math.round((Date.now() - this.lastPongTime) / 1000)}s, reconnecting`);
        this.socket.destroy();
        return;
      }

      console.log(`[${this.config.interfaceName}] ${new Date().toISOString()} sending PING`);
      this.socket.write(encodeFrame(0, FrameType.PING, Buffer.alloc(0)));
    }, this._pingInterval);
  }

  _stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  _recordActivity() {
    this.lastActivity = Date.now();
  }

  write(data) {
    if (this.socket && !this.socket.destroyed && this.initialized) {
      return this.socket.write(data);
    }
    return false;
  }

  isConnected() {
    return this.socket && !this.socket.destroyed && this.initialized;
  }

  destroy() {
    this.destroyed = true;
    this._stopWatchdog();
    this._stopKeepalive();
    if (this._initResponseTimer) {
      clearTimeout(this._initResponseTimer);
      this._initResponseTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.emit('status', 'failed');
    this.removeAllListeners();
  }
}

module.exports = { RealSocket, SEQ_RESET_THRESHOLD, DEFAULT_PING_INTERVAL, DEFAULT_PONG_TIMEOUT };
