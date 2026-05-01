// TLS Server - Handles tunnel client connections with mTLS
// Supports multiple connections from the same client via ConnectionPool

const { createServer } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { isRevoked } = require('./ca');

const KEEPALIVE_INTERVAL = 10000;
const KEEPALIVE_TIMEOUT = 25000;
const INIT_TIMEOUT = 10000;
const MAX_CONCURRENT_STREAMS = 100;

function createTLSServer(connectionPool, options = {}) {
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
    minVersion: 'TLSv1.2'
  };

  let nextStreamId = 1;

  const server = createServer(tlsOptions, (socket) => {
    if (!socket.authorized) {
      console.error('TLS auth failed:', socket.authorizationError);
      socket.destroy();
      return;
    }

    const cert = socket.getPeerCertificate();
    const serial = cert.serialNumber;

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
    let interfaceName = `conn-${serial}-${Date.now()}`; // fallback

    function startKeepalive() {
      lastPongTime = Date.now();
      keepaliveTimer = setInterval(() => {
        if (!initialized || socket.destroyed) return;
        if (Date.now() - lastPongTime > keepaliveTimeout) {
          console.log(`[${new Date().toISOString()}] Client keepalive timeout, serial: ${serial}`);
          socket.destroy();
          return;
        }
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
          if (frame.streamId !== 0 || frame.type !== FrameType.INIT) {
            socket.destroy();
            return;
          }

          try {
            if (initTimer) {
              clearTimeout(initTimer);
              initTimer = null;
            }

            let clientInit;
            try {
              clientInit = JSON.parse(frame.payload.toString());
            } catch (parseErr) {
              console.error(`[${new Date().toISOString()}] Invalid INIT payload from client ${serial}:`, parseErr.message);
              socket.destroy();
              return;
            }

            if (clientInit.maxFrameSize !== undefined) {
              if (typeof clientInit.maxFrameSize !== 'number' ||
                  clientInit.maxFrameSize < 1024 ||
                  clientInit.maxFrameSize > 10485760) {
                console.error(`[${new Date().toISOString()}] Invalid maxFrameSize from client ${serial}:`, clientInit.maxFrameSize);
                socket.destroy();
                return;
              }
            }

            // Use interface name from client, or fallback
            if (clientInit.interface) {
              interfaceName = clientInit.interface;
            }

            // Send INIT ACK
            socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
              maxFrameSize: 1048576,
              maxConcurrentStreams: maxStreams
            })));

            // Register this connection in the pool
            connectionPool.add(interfaceName, socket);

            initialized = true;
            startKeepalive();
            console.log(`[${new Date().toISOString()}] Client ready, serial: ${serial}, interface: ${interfaceName}`);
            return;
          } catch (err) {
            socket.destroy();
            return;
          }
        }

        // Handle client PING
        if (frame.streamId === 0 && frame.type === FrameType.PING) {
          socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
          return;
        }

        // Handle PONG
        if (frame.streamId === 0 && frame.type === FrameType.PONG) {
          lastPongTime = Date.now();
          return;
        }

        // Handle RESET_SEQ
        if (frame.streamId === 0 && frame.type === FrameType.RESET_SEQ) {
          connectionPool.handleResetSeq(frame);
          return;
        }

        // All other frames: dedup and route
        connectionPool.onFrame(frame);
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
      console.log(`[${new Date().toISOString()}] Client disconnected, serial: ${serial}, interface: ${interfaceName}`);
      connectionPool.remove(socket);
    });

    socket.on('error', (err) => {
      const ignoreCodes = ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT'];
      if (!ignoreCodes.includes(err.code)) {
        console.error('Socket error:', err.message || err.code);
      }
      socket.destroy();
    });

    initTimer = setTimeout(() => {
      if (!initialized) socket.destroy();
    }, initTimeout);
  });

  // Track active streams to prevent ID collision
  const activeStreams = new Set();

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

  server.releaseStreamId = (id) => {
    activeStreams.delete(id);
  };

  return server;
}

module.exports = { createTLSServer };
