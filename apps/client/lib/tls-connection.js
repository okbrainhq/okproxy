// TLS Connection - TLS connection with INIT handshake and reconnection

const { connect } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

function createTLSConnection(config, onFrame, onConnect, onDisconnect) {
  let socket = null;
  let decoder = null;
  let initialized = false;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let reconnectTimer = null;
  let destroyed = false;

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

    socket = connect(tlsOptions, () => {
      console.log('TLS connected to server');
      console.log('Server certificate valid:', socket.authorized);

      // Send INIT handshake after TLS connection is established
      socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
        version: 1,
        maxFrameSize: 1048576
      })));
    });

    initialized = false;

    decoder = createFrameDecoder(
      (frame) => {
        if (!initialized) {
          if (frame.streamId === 0 && frame.type === FrameType.INIT) {
            initialized = true;
            reconnectDelay = INITIAL_RECONNECT_DELAY;
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
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNRESET') {
        console.error('TLS error:', err.message);
      }
    });

    socket.on('close', () => {
      initialized = false;
      if (onDisconnect) onDisconnect();
      if (!destroyed) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToServer();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  function write(data) {
    if (socket && !socket.destroyed && initialized) {
      return socket.write(data);
    }
    return false;
  }

  function destroy() {
    destroyed = true;
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
    get socket() { return socket; }
  };
}

module.exports = { createTLSConnection };
