// TLS Server - Handles tunnel client connections with mTLS
// Supports multiple connections from the same client via ConnectionPool

const { createServer } = require('node:tls');
const { readFileSync } = require('node:fs');
const { encodeFrame, createFrameDecoder, FrameType } = require('../../../packages/frame-protocol');
const { isRevoked, onCertificateRevoked } = require('./ca');
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { VERSION, CAPABILITY, compatible, MAX_LANE_BYTES } = require('../../../packages/frame-protocol/transport-session');

const KEEPALIVE_INTERVAL = 10000;
const KEEPALIVE_TIMEOUT = 25000;
const INIT_TIMEOUT = 10000;
const MAX_CONCURRENT_STREAMS = 100;

// Bounds on client-supplied identifiers, enforced before any allocation.
const MAX_INTERFACE_NAME_LENGTH = 64;
const INTERFACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#-]*$/;
const MAX_LANES_PER_SERIAL = 64;
const MAX_REQUESTED_DOMAINS = 32;
const MAX_DOMAIN_LENGTH = 253;
const MAX_UNSOLICITED_FRAME_IDS = 256;
const MAX_STREAM_ID = 0x7FFFFFFF;

function isValidInterfaceName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_INTERFACE_NAME_LENGTH
    && INTERFACE_NAME_PATTERN.test(name);
}

function isValidRequestedDomains(domains) {
  if (domains === undefined) return true;
  if (!Array.isArray(domains)) return false;
  if (domains.length > MAX_REQUESTED_DOMAINS) return false;
  return domains.every(d => typeof d === 'string' && d.length > 0 && d.length <= MAX_DOMAIN_LENGTH);
}

function createTLSServer(connectionPool, options = {}) {
  const certBoundDomains = Boolean(options.certBoundDomains);
  const maxStreams = Math.min(4096, Math.max(1, Math.floor(options.maxConcurrentStreams || MAX_CONCURRENT_STREAMS)));
  if (!certBoundDomains && connectionPool.transport) {
    connectionPool.options.maxTrackedStreams = maxStreams;
    connectionPool.transport.maxStreams = maxStreams;
  }
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

  // Active sockets per authenticated serial. Used by the revocation-driven
  // eviction API (`server.evictSerial`) so a revoked certificate's live tunnels
  // are dropped promptly. The CA/metadata worker owns revocation detection and
  // calls this via the documented subscription below.
  const socketsBySerial = new Map();

  function trackSocket(serial, socket) {
    let set = socketsBySerial.get(serial);
    if (!set) {
      set = new Set();
      socketsBySerial.set(serial, set);
    }
    set.add(socket);
  }

  function untrackSocket(serial, socket) {
    const set = socketsBySerial.get(serial);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) socketsBySerial.delete(serial);
  }

  /**
   * Evict all live connections for an authenticated client serial.
   * @param {string|number} serial
   * @param {string} [reason]
   * @returns {number} sockets destroyed
   */
  function evictSerial(serial, reason = 'revoked') {
    const key = String(serial);
    const set = socketsBySerial.get(key);
    if (!set || set.size === 0) return 0;
    const sockets = [...set];
    socketsBySerial.delete(key);
    const pools = new Set(sockets.map(socket => certBoundDomains ? socket._okproxySession?.pool : connectionPool));
    for (const pool of pools) pool?.evictBySerial?.(key, reason);
    for (const socket of sockets) {
      console.log(`[${new Date().toISOString()}] Evicting client serial ${key} (${reason})`);
      try {
        socket._okproxyEvicted = true;
        socket.destroy();
      } catch { /* ignore */ }
    }
    return sockets.length;
  }

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

    if ((socketsBySerial.get(serial)?.size || 0) >= MAX_LANES_PER_SERIAL) { socket.destroy(); return; }
    trackSocket(serial, socket);
    const rawWrite = socket.write.bind(socket);
    socket.write = (...args) => {
      if (socket.destroyed) return false;
      const writable = rawWrite(...args);
      if (socket.writableLength > MAX_LANE_BYTES) {
        const pool = resolvePool();
        if (pool?.owns(socket)) pool.evictAll('lane-buffer-limit');
        else socket.destroy();
        return false;
      }
      return writable;
    };
    socket.setKeepAlive(true, 30000);

    // Per-connection counters for unsolicited/invalid frame IDs.
    let invalidFrames = 0;

    let initialized = false;
    let initTimer = null;
    let keepaliveTimer = null;
    let lastPongTime = 0;
    let interfaceName = `conn-${serial}-${Date.now()}`; // fallback

    function resolvePool() {
      return certBoundDomains ? socket._okproxySession?.pool : connectionPool;
    }

    function startKeepalive() {
      lastPongTime = performance.now();
      keepaliveTimer = setInterval(() => {
        if (!initialized || socket.destroyed) return;
        if (performance.now() - lastPongTime > keepaliveTimeout) {
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
        if (socket.destroyed || socket._okproxyEvicted) return;
        if (initialized && !resolvePool()?.owns(socket)) { socket.destroy(); return; }
        if (!initialized) {
          if (frame.streamId !== 0 || frame.type !== FrameType.INIT || frame.seqNo !== 0) {
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

            if (!compatible(clientInit)) {
              console.error('Incompatible tunnel protocol; coordinated v2 upgrade required');
              socket.destroy(); return;
            }
            socket._okproxyClientSession = clientInit.clientSession;

            if (clientInit.maxFrameSize !== undefined) {
              if (typeof clientInit.maxFrameSize !== 'number' ||
                  clientInit.maxFrameSize < 1024 ||
                  clientInit.maxFrameSize > 10485760) {
                console.error(`[${new Date().toISOString()}] Invalid maxFrameSize from client ${serial}:`, clientInit.maxFrameSize);
                socket.destroy();
                return;
              }
            }

            if (!isValidRequestedDomains(clientInit.domains)) {
              console.error(`[${new Date().toISOString()}] Invalid domains from client ${serial}`);
              socket.destroy();
              return;
            }

            // Use a validated interface name from the client, or fallback. The
            // name is part of the pool key, so unsolicited/huge/odd names are
            // rejected before allocation.
            if (clientInit.interface !== undefined) {
              if (!isValidInterfaceName(clientInit.interface)) {
                console.error(`[${new Date().toISOString()}] Invalid interface name from client ${serial}`);
                socket.destroy();
                return;
              }
              interfaceName = clientInit.interface;
            }

            const serialSockets = socketsBySerial.get(serial);
            if (serialSockets && serialSockets.size > MAX_LANES_PER_SERIAL) {
              console.error(`[${new Date().toISOString()}] Lane limit (${MAX_LANES_PER_SERIAL}) exceeded for client ${serial}`);
              socket.destroy();
              return;
            }

            let registeredSession = null;
            let authorizedDomains = [];
            if (certBoundDomains) {
              const result = connectionPool.addTunnelConnection({
                serial,
                cert,
                interfaceName,
                socket,
                requestedDomains: Array.isArray(clientInit.domains) ? clientInit.domains : []
              });
              if (!result.ok) {
                console.error(`[${new Date().toISOString()}] Rejecting client ${serial} on ${interfaceName}: ${result.reason}`);
                socket.destroy();
                return;
              }
              registeredSession = result.session;
              authorizedDomains = result.domains || [];
              socket._okproxySession = registeredSession;
            } else {
              // Register this connection in the legacy single-client pool
              if (!connectionPool.add(serial, interfaceName, socket)) {
                console.error(`[${new Date().toISOString()}] Rejecting client ${serial} on ${interfaceName}: different client already connected`);
                socket.destroy();
                return;
              }
            }

            // Send INIT ACK
            socket.write(encodeFrame(0, FrameType.INIT, JSON.stringify({
              version: VERSION,
              capability: CAPABILITY,
              clientSession: clientInit.clientSession,
              serverSession: resolvePool().sessionId,
              maxFrameSize: 1048576,
              maxConcurrentStreams: maxStreams,
              domains: authorizedDomains
            })));

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
        if (frame.streamId === 0 && frame.type === FrameType.PING && frame.seqNo === 0 && frame.payload.length === 0) {
          socket.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
          return;
        }

        // Handle PONG
        if (frame.streamId === 0 && frame.type === FrameType.PONG && frame.seqNo === 0 && frame.payload.length === 0) {
          lastPongTime = performance.now();
          return;
        }

        // v2 has no reset epochs or legacy fallback. Never erase a gap.
        if (frame.streamId === 0 || frame.type === FrameType.RESET_SEQ) {
          resolvePool()?.evictAll('unexpected-control-or-RESET_SEQ');
          return;
        }

        // Validate the stream id before handing the frame to the pool.
        // Unsolicited/out-of-range ids are dropped (bounded per connection)
        // rather than allocating per-stream state.
        if (!Number.isInteger(frame.streamId) || frame.streamId <= 0 || frame.streamId > MAX_STREAM_ID) {
          invalidFrames++;
          if (invalidFrames > MAX_UNSOLICITED_FRAME_IDS) {
            console.error(`[${new Date().toISOString()}] Too many invalid stream ids from serial ${serial}, closing connection`);
            socket.destroy();
          }
          return;
        }

        // All other frames: dedup and route
        const targetPool = certBoundDomains ? socket._okproxySession?.pool : connectionPool;
        if (targetPool && targetPool.onFrame(frame, socket) === 'invalid') {
          if (++invalidFrames > MAX_UNSOLICITED_FRAME_IDS) targetPool.evictAll('unsolicited-stream-ids');
        }
      },
      (err) => {
        console.error('Protocol error:', err.message);
        socket.destroy();
      }
    );

    socket.on('data', decoder);

    socket.on('close', () => {
      decoder.destroy();
      stopKeepalive();
      if (initTimer) clearTimeout(initTimer);
      untrackSocket(serial, socket);
      console.log(`[${new Date().toISOString()}] Client disconnected, serial: ${serial}, interface: ${interfaceName}`);
      if (certBoundDomains) connectionPool.removeTunnelConnection(socket);
      else connectionPool.remove(socket);
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
    if (activeStreams.size >= maxStreams || nextStreamId > MAX_STREAM_ID) {
      throw new Error('Stream allocation limit (IDs never wrap)');
    }
    const id = nextStreamId++;
    activeStreams.add(id);
    return id;
  };

  server.releaseStreamId = (id) => {
    activeStreams.delete(id);
  };

  // --- Revocation eviction integration point -------------------------------
  // The CA/metadata worker owns revocation detection. It can drop a revoked
  // client's live tunnels by either:
  //   1. calling `server.evictSerial(serial, reason)` directly, or
  //   2. passing an EventEmitter as `options.revocationSource` and emitting
  //      'revoked' with { serial } (or 'evict' with { serial }).
  // No CA code is modified here; wiring happens after merges.
  server.evictSerial = evictSerial;
  server.activeSerials = () => [...socketsBySerial.keys()];

  function handleRevocationEvent(payload) {
    const serial = payload && (payload.serial ?? payload.serialNumber);
    if (serial === undefined || serial === null) return;
    evictSerial(serial, 'revoked');
  }

  const unsubscribeCA = onCertificateRevoked(event => {
    if (!event?.caDir || resolve(event.caDir) !== resolve(options.caDir || './data/ca')) return;
    for (const serial of socketsBySerial.keys()) {
      if (isRevoked(serial, options.caDir || './data/ca')) evictSerial(serial, 'certificate revoked');
    }
  });
  server.once('close', unsubscribeCA);

  // Pool-owned CRL polling (default mode) must not outlive the listener.
  // shutdown() already disposes the pool; this covers callers that only close
  // the TLS server (tests, embedded use) so no interval is left behind.
  if (typeof connectionPool.stopRevocationWatch === 'function') {
    server.once('close', () => {
      try { connectionPool.stopRevocationWatch(); } catch { /* best-effort */ }
    });
  }

  const source = options.revocationSource;
  const revoke = payload => {
    handleRevocationEvent(payload);
    const serial = payload && (payload.serial ?? payload.serialNumber);
    if (serial !== undefined && serial !== null) connectionPool.evictBySerial?.(serial, 'revoked');
  };
  if (source?.on) {
    source.on('revoked', revoke); source.on('evict', revoke);
    server.once('close', () => { source.removeListener('revoked', revoke); source.removeListener('evict', revoke); });
  }

  return server;
}

module.exports = {
  createTLSServer,
  isValidInterfaceName,
  isValidRequestedDomains,
  MAX_LANES_PER_SERIAL,
  MAX_INTERFACE_NAME_LENGTH,
  MAX_UNSOLICITED_FRAME_IDS
};
