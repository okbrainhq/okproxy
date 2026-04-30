// TLS Server - Handles tunnel client connections with mTLS

const { createServer } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { isRevoked } = require('./ca');

const KEEPALIVE_INTERVAL = 10000; // 10 seconds
const KEEPALIVE_TIMEOUT = 25000; // 25 seconds (tolerates 2 missed PONGs)
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

    // Guard against edge cases where certificate info is not available
    if (!serial) {
      console.error('Client certificate serial number unavailable, rejecting connection');
      socket.destroy();
      return;
    }

    if (isRevoked(serial, options.caDir || './data/ca')) {
      console.error('Client certificate revoked, serial:', serial);
      socket.destroy();
      return;
    }

    console.log(`[${new Date().toISOString()}] Client connected, serial: ${serial}, remote: ${socket.remoteAddress}:${socket.remotePort}`);

    socket.setKeepAlive(true, 30000);

    let initialized = false;
    let initTimer = null;
    let keepaliveTimer = null;
    let lastPongTime = 0;

    function startKeepalive() {
      lastPongTime = Date.now();
      keepaliveTimer = setInterval(() => {
        if (!initialized || socket.destroyed) return;
        if (Date.now() - lastPongTime > keepaliveTimeout) {
          console.log(`[${new Date().toISOString()}] Client keepalive timeout, serial: ${serial}`);
          socket.destroy();
          return;
        }
        console.log(`[${new Date().toISOString()}] sending PING, serial: ${serial}`);
        socket.write(encodeFrame(0, FrameType.PING, Buffer.alloc(0)));
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

            // Parse and validate client INIT payload
            let clientInit;
            try {
              clientInit = JSON.parse(frame.payload.toString());
            } catch (parseErr) {
              console.error(`[${new Date().toISOString()}] Invalid INIT payload from client ${serial}:`, parseErr.message);
              socket.destroy();
              return;
            }

            // Validate protocol version
            if (typeof clientInit.version !== 'number' || clientInit.version < 1) {
              console.error(`[${new Date().toISOString()}] Invalid protocol version from client ${serial}:`, clientInit.version);
              socket.destroy();
              return;
            }

            // Validate maxFrameSize if provided (must be reasonable)
            if (clientInit.maxFrameSize !== undefined) {
              if (typeof clientInit.maxFrameSize !== 'number' ||
                  clientInit.maxFrameSize < 1024 ||
                  clientInit.maxFrameSize > 10485760) { // Max 10MB
                console.error(`[${new Date().toISOString()}] Invalid maxFrameSize from client ${serial}:`, clientInit.maxFrameSize);
                socket.destroy();
                return;
              }
            }

            // Send INIT ACK with server's capabilities
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
            console.log(`[${new Date().toISOString()}] Client ready, serial: ${serial}, protocol version: ${clientInit.version}`);
            return;
          } catch (err) {
            socket.destroy();
            return;
          }
        }

        // Handle client PING (respond with PONG)
        if (frame.streamId === 0 && frame.type === FrameType.PING) {
          console.log(`[${new Date().toISOString()}] received client PING, sending PONG, serial: ${serial}`);
          socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
          return;
        }

        // Handle PONG
        if (frame.streamId === 0 && frame.type === FrameType.PONG) {
          lastPongTime = Date.now();
          console.log(`[${new Date().toISOString()}] received PONG, serial: ${serial}`);
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
        console.log(`[${new Date().toISOString()}] Client disconnected, serial: ${serial}`);
        clientManager.remove();
      } else if (initialized) {
        console.log(`[${new Date().toISOString()}] Client connection closed (replaced), serial: ${serial}`);
      } else {
        console.log(`[${new Date().toISOString()}] Client disconnected before init, serial: ${serial}`);
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
    const attempts = maxStreams;
    for (let i = 0; i < attempts; i++) {
      let id = nextStreamId++;
      if (nextStreamId > 2147483647) nextStreamId = 1;
      if (!activeStreams.has(id)) {
        activeStreams.add(id);
        return id;
      }
    }
    throw new Error('No available stream IDs');
  };

  // Method to release a stream ID when done
  server.releaseStreamId = (id) => {
    activeStreams.delete(id);
  };

  return server;
}

module.exports = { createTLSServer };
