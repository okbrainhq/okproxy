// TLS Connection - TLS connection with INIT handshake and reconnection

const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');

const INITIAL_RECONNECT_DELAY = 500; // 0.5 seconds
const MAX_RECONNECT_DELAY = 3000; // Max 3 seconds between retries
const WATCHDOG_TIMEOUT = 25000; // 25 seconds - should receive at least one PING in this time (server sends every 15s)

function createTLSConnection(config, onFrame, onConnect, onDisconnect) {
  let socket = null;
  let decoder = null;
  let initialized = false;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let reconnectTimer = null;
  let destroyed = false;
  let watchdogTimer = null;
  let lastActivity = 0;
  let reconnectAttempts = 0;
  let serverSettings = { maxConcurrentStreams: 100 }; // Default until negotiated

  function connectToServer() {
    if (destroyed) return;

    const tlsOptions = {
      host: config.serverHost,
      port: config.serverPort,
      key: readFileSync(config.clientKey),
      cert: readFileSync(config.clientCert),
      ca: readFileSync(config.caCert),
      rejectUnauthorized: true
    };

    // Connection timeout - don't let TCP hang for 75s on dead network
    const connectionTimeout = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] Connection timeout (25s), destroying socket`);
      if (socket) socket.destroy();
    }, 25000);

    socket = connect(tlsOptions, () => {
      clearTimeout(connectionTimeout);
      console.log('TLS connected to server');
      console.log('Server certificate valid:', socket.authorized);

      // Enable TCP keepalive to detect dead connections
      socket.setKeepAlive(true, 30000); // 30s initial delay, OS default interval

      // Send INIT handshake after TLS connection is established
      socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
        version: 1,
        maxFrameSize: 1048576
      })));
    });

    initialized = false;

    decoder = createFrameDecoder(
      (frame) => {
        recordActivity(); // Track that we received data

        if (!initialized) {
          if (frame.streamId === 0 && frame.type === FrameType.INIT) {
            initialized = true;
            // Defensively clear timeout in case of any race condition
            clearTimeout(connectionTimeout);
            reconnectDelay = INITIAL_RECONNECT_DELAY;
            if (reconnectAttempts > 0) {
              console.log(`[${new Date().toISOString()}] Reconnected successfully after ${reconnectAttempts} attempt(s)`);
            }
            reconnectAttempts = 0;
            // Parse server settings from INIT ACK
            try {
              const settings = JSON.parse(frame.payload.toString());
              if (settings.maxConcurrentStreams) {
                serverSettings.maxConcurrentStreams = settings.maxConcurrentStreams;
              }
            } catch {
              // Use default if parsing fails
            }
            startWatchdog(); // Start monitoring connection health
            if (onConnect) onConnect();
            return;
          }
          socket.destroy();
          return;
        }

        // Handle PING (respond with PONG)
        if (frame.streamId === 0 && frame.type === FrameType.PING) {
          socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
          return;
        }

        if (onFrame) onFrame(frame);
      },
      (err) => {
        console.error('Protocol error:', err.message);
        socket.destroy();
      }
    );

    socket.on('data', decoder);

    socket.on('error', (err) => {
      clearTimeout(connectionTimeout);
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
        console.error('TLS error:', err.message);
      }
    });

    socket.on('close', () => {
      clearTimeout(connectionTimeout);
      initialized = false;
      stopWatchdog();
      if (onDisconnect) onDisconnect();
      if (!destroyed) {
        console.log(`[${new Date().toISOString()}] Connection lost, will reconnect...`);
        scheduleReconnect();
      }
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts++;
    console.log(`[${new Date().toISOString()}] Reconnect attempt #${reconnectAttempts} in ${reconnectDelay}ms...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToServer();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function startWatchdog() {
    lastActivity = Date.now();
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      if (!initialized || !socket || socket.destroyed) return;
      const idleTime = Date.now() - lastActivity;
      if (idleTime > WATCHDOG_TIMEOUT) {
        console.log(`[${new Date().toISOString()}] Watchdog: no server activity for ${idleTime}ms, closing dead connection`);
        socket.destroy();
      }
    }, 5000); // Check every 5 seconds
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function recordActivity() {
    lastActivity = Date.now();
  }

  function write(data) {
    if (socket && !socket.destroyed && initialized) {
      return socket.write(data);
    }
    return false;
  }

  function destroy() {
    destroyed = true;
    stopWatchdog();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) socket.destroy();
  }

  function isConnected() {
    return socket && !socket.destroyed && initialized;
  }

  function isInitialized() {
    return initialized;
  }

  // Start initial connection
  connectToServer();

  return {
    write,
    destroy,
    isConnected,
    isInitialized,
    get socket() { return socket; },
    get maxConcurrentStreams() { return serverSettings.maxConcurrentStreams; }
  };
}

module.exports = { createTLSConnection };
