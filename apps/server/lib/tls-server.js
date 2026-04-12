// TLS Server - Handles tunnel client connections with mTLS

const { createServer } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { isRevoked } = require('./ca');

const KEEPALIVE_INTERVAL = 30000; // 30 seconds
const KEEPALIVE_TIMEOUT = 10000; // 10 seconds
const INIT_TIMEOUT = 10000; // 10 seconds for INIT handshake
const MAX_CONCURRENT_STREAMS = 100;

function createTLSServer(clientManager, options = {}) {
  const maxStreams = options.maxConcurrentStreams || MAX_CONCURRENT_STREAMS;
  const keepaliveInterval = options.keepaliveInterval || KEEPALIVE_INTERVAL;
  const keepaliveTimeout = options.keepaliveTimeout || KEEPALIVE_TIMEOUT;
  const initTimeout = options.initTimeout || INIT_TIMEOUT;

  const tlsOptions = {
    key: readFileSync(options.serverKey),
    cert: readFileSync(options.serverCert),
    ca: readFileSync(options.caCert),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'  // Explicitly set minimum TLS version for defense in depth
  };

  let nextStreamId = 1;

  const server = createServer(tlsOptions, (socket) => {
    // TLS authentication check
    if (!socket.authorized) {
      console.error('TLS auth failed:', socket.authorizationError);
      socket.destroy();
      return;
    }

    // Check certificate revocation
    const cert = socket.getPeerCertificate();
    const serial = cert.serialNumber;

    if (isRevoked(serial, options.caDir || './data/ca')) {
      console.error('Client certificate revoked, serial:', serial);
      socket.destroy();
      return;
    }

    console.log('TLS client connected, serial:', serial);

    let initialized = false;
    let initTimer = null;
    let keepaliveTimer = null;
    let keepaliveDeadline = null;

    function sendPing() {
      if (!initialized || socket.destroyed) return;
      socket.write(encodeFrame(0, FrameType.PING, Buffer.alloc(0)));
      keepaliveDeadline = Date.now() + keepaliveTimeout;
    }

    function startKeepalive() {
      keepaliveTimer = setInterval(() => {
        if (keepaliveDeadline && Date.now() > keepaliveDeadline) {
          socket.destroy();
          return;
        }
        if (!keepaliveDeadline) sendPing();
      }, keepaliveInterval);
    }

    function stopKeepalive() {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    const decoder = createFrameDecoder(
      (frame) => {
        if (!initialized) {
          // Must receive INIT first
          if (frame.streamId !== 0 || frame.type !== FrameType.INIT) {
            socket.destroy();
            return;
          }

          try {
            if (initTimer) {
              clearTimeout(initTimer);
              initTimer = null;
            }

            // Send INIT ACK
            socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
              version: 1,
              maxFrameSize: 1048576,
              maxConcurrentStreams: maxStreams
            })));

            // Register client (single client model, same as tcp-server)
            clientManager.add({
              socket,
              write: (data) => socket.write(data),
              activeStreams: new Map()
            });

            initialized = true;
            startKeepalive();
            return;
          } catch (err) {
            socket.destroy();
            return;
          }
        }

        // Handle PONG
        if (frame.streamId === 0 && frame.type === FrameType.PONG) {
          keepaliveDeadline = null;
          return;
        }

        // Handle client responses (HEADERS, DATA, FIN, ERROR from client)
        if (frame.streamId > 0) {
          const handler = clientManager.getStreamHandler(frame.streamId);
          if (handler) {
            if (frame.type === FrameType.ERROR && handler.errorHandler) {
              handler.errorHandler(new Error(frame.payload.toString()));
            } else if (handler.frameHandler) {
              handler.frameHandler(frame);
            }
          }
        }
      },
      (err) => {
        console.error('Protocol error:', err.message);
        socket.destroy();
      }
    );

    socket.on('data', decoder);

    socket.on('close', () => {
      stopKeepalive();
      if (initTimer) clearTimeout(initTimer);
      // Remove the client if this socket is the current one
      if (clientManager.get() && clientManager.get().socket === socket) {
        clientManager.remove();
      }
    });

    socket.on('error', (err) => {
      const ignoreCodes = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT'];
      if (!ignoreCodes.includes(err.code)) {
        console.error('Socket error:', err.message || err.code);
      }
      socket.destroy();
    });

    // Timeout if INIT not received
    initTimer = setTimeout(() => {
      if (!initialized) socket.destroy();
    }, initTimeout);
  });

  // Track active streams to prevent ID collision on wraparound
  const activeStreams = new Set();

  // Method to allocate a new stream ID
  server.allocateStreamId = () => {
    let id = nextStreamId++;
    // Check for collision with active stream
    while (activeStreams.has(id)) {
      id = nextStreamId++;
    }
    if (nextStreamId > 2147483647) nextStreamId = 1;
    activeStreams.add(id);
    return id;
  };

  // Method to release a stream ID when done
  server.releaseStreamId = (id) => {
    activeStreams.delete(id);
  };

  return server;
}

module.exports = { createTLSServer };
