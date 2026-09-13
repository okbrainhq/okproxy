// HTTP Router - Routes public HTTP requests to the tunnel client(s)
// Works with ConnectionPool for multipath support

const { createServer } = require('node:http');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

const STREAM_TIMEOUT = 300000; // 5 minutes — allows large uploads/downloads without false 504s
const DEFAULT_MAX_BODY_SIZE = 220 * 1024 * 1024;
const MAX_WS_BUFFER_SIZE = 16 * 1024 * 1024;
const DEFAULT_HTTP_KEEPALIVE_TIMEOUT = 60 * 60 * 1000;
const HTTP_HEADERS_TIMEOUT_BUFFER = 5000;
const SINGLE_FLOW_MEDIA_EXTENSION_RE = /\.(?:aac|aif|aiff|flac|m4a|m4b|mp3|oga|ogg|opus|wav|weba|m4v|mkv|mov|mp4|webm)(?:$|[?#])/i;
const SINGLE_FLOW_REQUEST_CONTENT_TYPE_RE = /^(?:multipart\/form-data|audio\/|video\/|application\/octet-stream\b)/i;

const STATUS_TEXTS = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
};

function getStatusText(code) {
  return STATUS_TEXTS[code] || 'Error';
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function isWebSocketUpgrade(req) {
  const upgrade = req.headers.upgrade?.toLowerCase();
  const connection = req.headers.connection?.toLowerCase();
  return upgrade === 'websocket' && 
          (connection === 'upgrade' || connection?.includes('upgrade'));
}

function filterResponseHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function sanitizeRequestHeaders(headers) {
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.join(', ');
    }
  }
  return sanitized;
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function getRequestPathname(reqUrl) {
  try {
    return new URL(reqUrl || '/', 'http://okproxy.local').pathname || '/';
  } catch {
    return String(reqUrl || '/').split('?')[0] || '/';
  }
}

function shouldUseSingleFlow(reqUrl, headers = {}, method = 'GET') {
  const pathname = getRequestPathname(reqUrl);
  if (SINGLE_FLOW_MEDIA_EXTENSION_RE.test(pathname)) return true;

  const accept = String(headers.accept || '');
  if (/\b(?:audio|video)\//i.test(accept)) return true;

  const fetchDest = String(headers['sec-fetch-dest'] || '');
  if (/^(?:audio|video)$/i.test(fetchDest)) return true;

  // Browser media players commonly use Range requests. Treat them as heavy
  // single-flow candidates so they do not duplicate across every multipath lane.
  if (headers.range) return true;

  const requestMethod = String(method || 'GET').toUpperCase();
  const hasRequestBody = !['GET', 'HEAD', 'OPTIONS'].includes(requestMethod);
  if (hasRequestBody) {
    const contentType = String(headers['content-type'] || '');
    if (SINGLE_FLOW_REQUEST_CONTENT_TYPE_RE.test(contentType)) return true;

    // Resumable/chunked upload protocols advertise these headers even when
    // the request content type is generic.
    if (headers['content-range'] || headers['upload-length'] || headers['upload-offset'] || headers['tus-resumable']) {
      return true;
    }
  }

  return false;
}

// Headers involved in the WebSocket handshake negotiation. The browser's
// offers are forwarded upstream so the target can select a subprotocol or
// extension, but the target's selection must be relayed back to the browser —
// dropping it makes the two peers disagree about negotiated semantics (e.g.
// permessage-deflate frames the browser never agreed to).
const WS_OFFER_HEADERS = ['sec-websocket-protocol', 'sec-websocket-extensions'];

function splitHeaderTokens(value) {
  const source = Array.isArray(value) ? value.join(', ') : value;
  if (typeof source !== 'string' || source.trim() === '') return [];
  return source.split(',').map(token => token.trim()).filter(Boolean);
}

function getHeaderValue(headers, name) {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

function extensionTokenName(token) {
  const name = String(token).split(';')[0].trim().toLowerCase();
  return name || null;
}

function stripWebSocketOffers(headers) {
  const stripped = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (WS_OFFER_HEADERS.includes(key.toLowerCase())) continue;
    stripped[key] = value;
  }
  return stripped;
}

/**
 * Decide which negotiation headers from the upstream 101 response may be
 * relayed to the browser.
 *
 * Only values the browser actually offered are accepted. If the target
 * "accepts" a subprotocol/extension that was never offered, the handshake is
 * internally inconsistent — the tunnel cannot un-negotiate upstream, so the
 * router fails closed instead of silently forwarding a broken handshake.
 *
 * @returns {{lines: string[]} | {error: string}}
 */
function resolveWebSocketNegotiation(responseHeaders, offeredProtocols, offeredExtensions) {
  const lines = [];

  const rawProtocol = getHeaderValue(responseHeaders, 'sec-websocket-protocol');
  if (rawProtocol !== undefined && String(rawProtocol).trim() !== '') {
    const selected = String(rawProtocol).trim();
    if (!offeredProtocols.includes(selected)) {
      return { error: `subprotocol-not-offered:${selected}` };
    }
    lines.push(`Sec-WebSocket-Protocol: ${selected}`);
  }

  const rawExtensions = getHeaderValue(responseHeaders, 'sec-websocket-extensions');
  if (rawExtensions !== undefined && String(rawExtensions).trim() !== '') {
    const tokens = splitHeaderTokens(rawExtensions);
    for (const token of tokens) {
      const name = extensionTokenName(token);
      if (!name || !offeredExtensions.includes(name)) {
        return { error: `extension-not-offered:${token}` };
      }
    }
    if (tokens.length > 0) lines.push(`Sec-WebSocket-Extensions: ${tokens.join(', ')}`);
  }

  return { lines };
}

function waitForDrain(target, callback) {
  if (!target || target.destroyed || !target.writableNeedDrain) {
    process.nextTick(callback);
    return;
  }

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    target.removeListener('drain', done);
    target.removeListener('close', done);
    target.removeListener('error', done);
    callback();
  };

  target.once('drain', done);
  target.once('close', done);
  target.once('error', done);
}

function waitForPoolDrain(pool, callback, streamId = null) {
  if (streamId !== null && pool && typeof pool.onceDrainForStream === 'function') {
    pool.onceDrainForStream(streamId, callback);
  } else if (pool && typeof pool.onceDrain === 'function') {
    pool.onceDrain(callback);
  } else {
    process.nextTick(callback);
  }
}

function pausePool(pool, streamId = null) {
  if (streamId !== null && pool && typeof pool.pauseStream === 'function') pool.pauseStream(streamId);
  else if (pool && typeof pool.pause === 'function') pool.pause();
}

function resumePool(pool, streamId = null) {
  if (streamId !== null && pool && typeof pool.resumeStream === 'function') pool.resumeStream(streamId);
  else if (pool && typeof pool.resume === 'function') pool.resume();
}

function buildWebSocketFrame(opcode, payload) {
  const payloadLen = payload.length;
  let frame;
  
  if (payloadLen < 126) {
    frame = Buffer.allocUnsafe(2 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = payloadLen;
    payload.copy(frame, 2);
  } else if (payloadLen < 65536) {
    frame = Buffer.allocUnsafe(4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 126;
    frame.writeUInt16BE(payloadLen, 2);
    payload.copy(frame, 4);
  } else {
    frame = Buffer.allocUnsafe(10 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(payloadLen, 6);
    payload.copy(frame, 10);
  }
  
  return frame;
}

function parseWebSocketFrame(buffer, boundariesOnly = false) {
  if (buffer.length < 2) return null;
  
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  
  let offset = 2;
  
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const high = buffer.readUInt32BE(2);
    if (high !== 0) return null;
    payloadLen = buffer.readUInt32BE(6);
    offset = 10;
  }
  
  if (masked) {
    offset += 4;
  }
  
  const frameSize = offset + payloadLen;
  if (buffer.length < frameSize) return null;
  
  const remaining = buffer.subarray(frameSize);
  
  if (boundariesOnly) {
    return { frameSize, opcode, remaining };
  }
  
  let payload = buffer.subarray(offset, frameSize);
  
  if (masked) {
    const maskKey = buffer.subarray(offset - 4, offset);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }
  
  return { fin, opcode, payload, remaining };
}

function createHTTPServer(connectionPool, tcpServer, options = {}) {
  const streamTimeout = options.streamTimeout || STREAM_TIMEOUT;
  const maxStreams = options.maxConcurrentStreams || 100;
  const maxWebSocketStreams = options.maxWebSocketStreams || 50;
  const maxBodySize = options.maxBodySize || DEFAULT_MAX_BODY_SIZE;
  const certBoundDomains = Boolean(options.certBoundDomains);
  const httpKeepAliveTimeout = normalizeNonNegativeInteger(options.httpKeepAliveTimeout, DEFAULT_HTTP_KEEPALIVE_TIMEOUT);
  const httpHeadersTimeout = Math.max(
    normalizeNonNegativeInteger(options.httpHeadersTimeout, 0),
    httpKeepAliveTimeout + HTTP_HEADERS_TIMEOUT_BUFFER
  );
  const stripWebSocketNegotiation = Boolean(options.stripWebSocketNegotiation);

  function resolveRequestRoute(hostHeader) {
    if (!certBoundDomains) {
      if (connectionPool.count === 0) return { error: 502, message: 'Tunnel client not connected' };
      return { pool: connectionPool, domain: null, session: null };
    }

    const route = connectionPool.resolveByHost(hostHeader);
    if (route.status === 'invalid-host') return { error: 400, message: 'Bad Request' };
    if (route.status === 'unknown') return { error: 404, message: 'Unknown tunnel domain' };
    if (route.status === 'metadata-error') return { error: 503, message: 'Domain metadata unavailable' };
    if (route.status === 'disconnected') return { error: 502, message: `Tunnel client not connected for ${route.domain}` };
    if (!route.session || !route.session.hasConnections()) return { error: 502, message: `Tunnel client not connected for ${route.domain}` };
    return { pool: route.session.pool, domain: route.domain, session: route.session };
  }

  // Domain metadata (issued-domains.json) can be corrupt/unreadable. Routing
  // must never throw from inside a request handler: an uncaught exception
  // would take down the whole public listener. Fail closed with a controlled
  // 503 instead.
  function safeResolveRequestRoute(hostHeader) {
    try {
      return resolveRequestRoute(hostHeader);
    } catch (err) {
      console.error(`[503] Failed to resolve route for host "${hostHeader}":`, err && err.message ? err.message : err);
      return { error: 503, message: 'Service Unavailable' };
    }
  }

  function routeMaxStreams(route) {
    const sessionMax = route && route.session && Number.isFinite(route.session.maxStreams)
      ? route.session.maxStreams
      : maxStreams;
    return sessionMax > 0 ? sessionMax : maxStreams;
  }

  function streamLimitReached(route, pool) {
    if (!pool || !pool.activeStreams) return false;
    return pool.activeStreams.size >= routeMaxStreams(route);
  }

  function allocateStream(route) {
    return route.session ? route.session.allocateStreamId() : tcpServer.allocateStreamId();
  }

  function releaseStream(route, streamId) {
    if (route.session) route.session.releaseStreamId(streamId);
    else tcpServer.releaseStreamId(streamId);
  }

  const server = createServer((req, res) => {
    if (certBoundDomains && req.url.startsWith('/_okproxy/caddy-ask')) {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const domain = url.searchParams.get('domain');
        if (connectionPool.isAskAllowed(domain)) {
          res.statusCode = 200;
          res.end('OK');
        } else {
          res.statusCode = 404;
          res.end('Not Found');
        }
      } catch {
        res.statusCode = 400;
        res.end('Bad Request');
      }
      return;
    }

    const route = safeResolveRequestRoute(req.headers.host);
    if (route.error) {
      console.error(`[${route.error}] ${route.message} for ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
      res.statusCode = route.error;
      res.end(route.message);
      return;
    }

    const selectedPool = route.pool;
    const streamLimit = routeMaxStreams(route);
    if (streamLimitReached(route, selectedPool)) {
      console.error(`[503] Max concurrent streams exceeded (${selectedPool.activeStreams.size}/${streamLimit}) for ${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('Max concurrent streams exceeded');
      return;
    }

    let streamId;
    try {
      streamId = allocateStream(route);
    } catch {
      res.statusCode = 503;
      res.end('No available stream IDs');
      return;
    }

    for (const [name, sock] of selectedPool.connections) {
      sock.setMaxListeners(maxStreams + 10);
    }

    const clientIp = req.socket.remoteAddress || '127.0.0.1';
    const publicProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    const singleFlow = shouldUseSingleFlow(req.url, req.headers, req.method);
    let bodySize = 0;
    let cleanedUp = false;
    let terminalSent = false;
    let headersSent = false;
    let requestBackpressured = false;
    let responseBackpressured = false;
    // Declared before any early-return path so cleanup() is safe to call from
    // the request-forwarding failure path below.
    let streamTimer = null;

    if (typeof selectedPool.setStreamMode === 'function') {
      try {
        selectedPool.setStreamMode(streamId, { singleFlow });
      } catch (err) {
        console.error('Failed to set stream mode:', err && err.message ? err.message : err);
      }
    }

    // Terminal notification is once-only. Every abort path funnels through
    // cleanup(terminal) so the tunnel client is told exactly once that the
    // stream is over, and late callbacks cannot send a second notification.
    function sendTerminal(type, message) {
      if (terminalSent) return;
      terminalSent = true;
      selectedPool.send(encodeFrame(streamId, type,
        message === undefined || message === null ? Buffer.alloc(0) : Buffer.from(String(message))));
    }

    function failResponse(statusCode, message) {
      if (res.writableEnded || res.destroyed) return;
      if (headersSent || res.headersSent) {
        // Response headers already reached the public client. Appending an
        // error status/body here would graft text onto an in-flight response
        // (e.g. "Bad Gateway" inside a 200). Destroy to signal truncation.
        res.destroy();
        return;
      }
      res.statusCode = statusCode;
      res.end(message);
    }

    let sentHeaders = false;
    try {
      sentHeaders = selectedPool.send(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
        method: req.method,
        path: req.url,
        headers: sanitizeRequestHeaders(req.headers),
        clientSerial: route.session?.serial,
        publicHost: route.domain || req.headers.host,
        publicProto,
        remoteAddress: clientIp,
        tunnelMode: singleFlow ? 'single-flow' : 'multipath',
        tunnel: { singleFlow }
      })));
    } catch (err) {
      // Forwarding failed after the stream ID was allocated: release it
      // instead of leaking the stream slot.
      console.error('[502] Failed to forward request headers:', err && err.message ? err.message : err);
      cleanup({ type: FrameType.ERROR, message: 'Failed to forward request headers' });
      failResponse(502, 'Bad Gateway');
      return;
    }

    if (!sentHeaders) {
      requestBackpressured = true;
      req.pause();
      waitForPoolDrain(selectedPool, () => {
        requestBackpressured = false;
        if (!cleanedUp) req.resume();
      }, streamId);
    }

    function scheduleStreamTimeout(isReset) {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = setTimeout(() => {
        console.error(`[504] Stream timeout${isReset ? ' (reset)' : ''} for ${req.method} ${req.url} (stream ${streamId}, client ${clientIp})`);
        cleanup({ type: FrameType.ERROR, message: 'Stream timeout' });
        failResponse(504, 'Gateway timeout');
      }, streamTimeout);
    }

    function resetStreamTimeout() {
      scheduleStreamTimeout(true);
    }

    scheduleStreamTimeout(false);

    req.on('data', (chunk) => {
      if (cleanedUp) return;
      resetStreamTimeout();

      bodySize += chunk.length;
      if (bodySize > maxBodySize) {
        console.error(`[413] Request body too large: ${bodySize} bytes (max: ${maxBodySize}) for stream ${streamId}`);
        abortTunnelStream('Request body too large');
        failResponse(413, 'Request body too large');
        req.destroy();
        return;
      }

      let offset = 0;
      let canContinue = true;
      while (offset < chunk.length) {
        const end = Math.min(offset + MAX_FRAME_SIZE, chunk.length);
        if (!selectedPool.send(encodeFrame(streamId, FrameType.DATA, chunk.subarray(offset, end)))) {
          canContinue = false;
        }
        offset = end;
      }

      if (!canContinue && !requestBackpressured) {
        requestBackpressured = true;
        req.pause();
        waitForPoolDrain(selectedPool, () => {
          requestBackpressured = false;
          if (!cleanedUp) req.resume();
        }, streamId);
      }
    });

    req.on('end', () => {
      if (!cleanedUp) {
        resetStreamTimeout();
        selectedPool.send(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
      }
    });

    req.on('error', (err) => {
      if (cleanedUp) return;
      console.error('Request error:', err.message);
      // Aborted request bodies must still tell the tunnel client to stop the
      // local target request, otherwise it leaks until the target times out.
      cleanup({ type: FrameType.ERROR, message: 'Public request error' });
      // Never leave the public response hanging: send 502 or truncate an
      // in-flight response (failResponse destroys when headers were flushed).
      failResponse(502, 'Bad Gateway');
    });

    function cleanup(terminal = null) {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        if (terminal) sendTerminal(terminal.type, terminal.message);
      } catch (err) {
        console.error('Failed to send terminal frame:', err && err.message ? err.message : err);
      }
      if (requestBackpressured) req.resume();
      if (responseBackpressured) { responseBackpressured = false; resumePool(selectedPool, streamId); }
      clearTimeout(streamTimer);
      streamTimer = null;
      selectedPool.unregisterStream(streamId);
      releaseStream(route, streamId);
    }

    function abortTunnelStream(message) {
      cleanup({ type: FrameType.ERROR, message });
    }

    selectedPool.registerStream(streamId, {
      frameHandler: (frame) => {
        if (cleanedUp) return;
        resetStreamTimeout();

        if (frame.type === FrameType.HEADERS) {
          if (headersSent || res.destroyed) return;
          try {
            const headers = JSON.parse(frame.payload.toString());
            res.statusCode = headers.status || 200;
            if (headers.headers) {
              const filteredHeaders = filterResponseHeaders(headers.headers);
              for (const [k, v] of Object.entries(filteredHeaders)) {
                try { res.setHeader(k, v); } catch (headerErr) { console.error(`Skipping malformed header '${k}':`, headerErr.message); }
              }
            }
            headersSent = true;
            if (!res.headersSent && typeof res.flushHeaders === 'function') {
              res.flushHeaders();
            }
            resetStreamTimeout();
          } catch (err) {
            console.error('Invalid headers frame:', err.message);
            cleanup({ type: FrameType.ERROR, message: 'Invalid response headers' });
            failResponse(502, 'Invalid response');
          }
        } else if (frame.type === FrameType.DATA) {
          if (res.destroyed || res.writableEnded) return;
          if (!headersSent) {
            res.statusCode = 200;
            headersSent = true;
            if (!res.headersSent && typeof res.flushHeaders === 'function') {
              res.flushHeaders();
            }
          }
          if (!res.write(frame.payload) && !responseBackpressured) {
            responseBackpressured = true;
            pausePool(selectedPool, streamId);
            waitForDrain(res, () => {
              responseBackpressured = false;
              if (!cleanedUp) resumePool(selectedPool, streamId);
            });
          }
          resetStreamTimeout();
        } else if (frame.type === FrameType.FIN) {
          resetStreamTimeout();
          cleanup();
          if (!res.writableEnded && !res.destroyed) res.end();
        } else if (frame.type === FrameType.ERROR) {
          const errorMsg = frame.payload?.toString() || 'Unknown error';
          console.error(`[502] Client sent ERROR frame for ${req.method} ${req.url} (stream ${streamId}): ${errorMsg}`);
          // Inbound terminal frame: the client already ended the stream, so no
          // terminal notification is sent back. Any later frame is ignored at
          // the top of this handler.
          cleanup();
          failResponse(502, 'Bad Gateway');
        }
      },
      errorHandler: (err) => {
        if (cleanedUp) return;
        console.error(`[502] Stream error for ${req.method} ${req.url} (stream ${streamId}):`, err.message);
        cleanup();
        failResponse(502, 'Bad Gateway');
      }
    });


    res.on('close', () => {
      if (cleanedUp || res.writableEnded) return;
      console.error(`[INFO] Client closed connection early for ${req.method} ${req.url} (stream ${streamId})`);
      abortTunnelStream('Public client closed connection');
    });
  });

  // No client-supplied metadata or route lookup may throw out of the upgrade
  // listener; an uncaught exception here would crash the public listener.
  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch (err) {
      console.error('[502] Unhandled WebSocket upgrade error:', err && err.message ? err.message : err);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  });

  function handleUpgrade(req, socket, head) {
    const route = safeResolveRequestRoute(req.headers.host);
    if (route.error) {
      socket.write(`HTTP/1.1 ${route.error} ${getStatusText(route.error)}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    const selectedPool = route.pool;
    let headBuffer = head && head.length > 0 ? head : Buffer.alloc(0);
    const webSockets = route.session ? route.session.activeWebSockets : server._legacyActiveWebSockets || (server._legacyActiveWebSockets = new Set());

    if (webSockets.size >= maxWebSocketStreams) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Stream IDs are the hard cap; check it here as well as in the HTTP path so
    // a flood of upgrades cannot exhaust the stream table.
    if (streamLimitReached(route, selectedPool)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isWebSocketUpgrade(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let streamId;
    try {
      streamId = allocateStream(route);
    } catch {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.add(streamId);

    // Every path below must release the stream exactly once; the catch block
    // covers setup failures that would otherwise leak the allocated stream ID.
    let cleanupFn = null;
    try {
      // `cleanup` is hoisted within this block; keep a handle so the catch can
      // use the same once-only teardown (terminal frame + socket destroy).
      cleanupFn = cleanup;

      for (const [name, sock] of selectedPool.connections) {
        sock.setMaxListeners(maxStreams + maxWebSocketStreams + 10);
      }

      const singleFlow = shouldUseSingleFlow(req.url, req.headers, req.method);
      if (typeof selectedPool.setStreamMode === 'function') {
        selectedPool.setStreamMode(streamId, { singleFlow });
      }

      const requestHeaders = sanitizeRequestHeaders(req.headers);
      const offeredProtocols = stripWebSocketNegotiation ? [] : splitHeaderTokens(req.headers['sec-websocket-protocol']);
      const offeredExtensions = stripWebSocketNegotiation
        ? []
        : splitHeaderTokens(req.headers['sec-websocket-extensions']).map(extensionTokenName).filter(Boolean);

      const upgradePayload = JSON.stringify({
        protocol: 'websocket',
        method: req.method,
        path: req.url,
        headers: stripWebSocketNegotiation ? stripWebSocketOffers(requestHeaders) : requestHeaders,
        clientSerial: route.session?.serial,
        publicHost: route.domain || req.headers.host,
        publicProto: req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http'),
        remoteAddress: req.socket.remoteAddress || '127.0.0.1',
        tunnelMode: singleFlow ? 'single-flow' : 'multipath',
        tunnel: { singleFlow }
      });

      selectedPool.send(encodeFrame(streamId, FrameType.UPGRADE, upgradePayload));

      let wsBuffer = Buffer.alloc(0);
      let targetToBrowserBuffer = Buffer.alloc(0);
      let upgradeResponseReceived = false;
      let cleanupCalled = false;
      let terminalSent = false;
      let closeFramePending = false;
      let browserBackpressured = false;
      let browserInputPaused = false;
      let pumpScheduled = false;
      let pendingLargeFrame = null;
      let pendingOffset = 0;
      const WS_IDLE_TIMEOUT = 300000;
      let idleTimer = null;

      function sendTerminal(type, message) {
        if (terminalSent) return;
        terminalSent = true;
        selectedPool.send(encodeFrame(streamId, type,
          message === undefined || message === null ? Buffer.alloc(0) : Buffer.from(String(message))));
      }

      function cleanup(terminal = null) {
        if (cleanupCalled) return;
        cleanupCalled = true;
        try {
          if (terminal) sendTerminal(terminal.type, terminal.message);
        } catch (err) {
          console.error('Failed to send terminal frame:', err && err.message ? err.message : err);
        }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        pendingLargeFrame = null;
        pendingOffset = 0;
        if (browserBackpressured) { browserBackpressured = false; resumePool(selectedPool, streamId); }
        browserInputPaused = false;
        webSockets.delete(streamId);
        selectedPool.unregisterStream(streamId);
        releaseStream(route, streamId);
        socket.destroy();
      }

      function writeUpgradeFailure(status, message) {
        if (socket.destroyed) return;
        const detail = message === undefined || message === null ? '' : String(message);
        const body = detail ? `WebSocket upgrade failed: ${detail}\r\n` : '';
        const lines = [`HTTP/1.1 ${status} ${getStatusText(status)}`, 'Connection: close', `Content-Length: ${Buffer.byteLength(body)}`, '', ''];
        const terminalMessage = detail ? `WebSocket upgrade failed: ${detail}` : 'WebSocket upgrade failed';
        socket.write(lines.join('\r\n') + body, () => cleanup({ type: FrameType.ERROR, message: terminalMessage }));
      }

      function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (cleanupCalled) return;
          if (upgradeResponseReceived) {
            const closeFrame = buildWebSocketFrame(0x08, Buffer.from([0x03, 0xe9]));
            socket.write(closeFrame, () => cleanup({ type: FrameType.FIN }));
          } else {
            cleanup({ type: FrameType.ERROR, message: 'WebSocket upgrade timeout' });
          }
        }, WS_IDLE_TIMEOUT);
      }

      resetIdleTimer();

      selectedPool.registerStream(streamId, {
        frameHandler: (frame) => {
          if (cleanupCalled) return;

          if (frame.type === FrameType.UPGRADE) {
            if (upgradeResponseReceived) return;
            resetIdleTimer();
            try {
              const response = JSON.parse(frame.payload.toString());
              if (response.status !== 101) {
                const errorStatus = response.status || 502;
                const errorBody = `WebSocket upgrade failed: ${errorStatus}\r\n`;
                const headerLines = [`HTTP/1.1 ${errorStatus} ${getStatusText(errorStatus)}`, 'Connection: close', `Content-Length: ${Buffer.byteLength(errorBody)}`, '', ''];
                socket.write(headerLines.join('\r\n') + errorBody, () => cleanup({ type: FrameType.ERROR, message: 'WebSocket upgrade failed' }));
                return;
              }

              // Relay the target's selected subprotocol/extensions, but only
              // if the browser actually offered them. Anything else is an
              // inconsistent handshake we refuse to expose to the browser.
              const negotiation = resolveWebSocketNegotiation(response.headers || {}, offeredProtocols, offeredExtensions);
              if (negotiation.error) {
                console.error(`[502] Refusing WebSocket upgrade for ${req.url}: ${negotiation.error}`);
                writeUpgradeFailure(502, negotiation.error);
                return;
              }

              const headers = response.headers || {};
              const headerLines = [
                'HTTP/1.1 101 Switching Protocols',
                `Upgrade: ${headers.upgrade || 'websocket'}`,
                `Connection: ${headers.connection || 'Upgrade'}`,
                `Sec-WebSocket-Accept: ${getHeaderValue(headers, 'sec-websocket-accept') || ''}`,
                ...negotiation.lines,
                '',
                ''
              ];
              upgradeResponseReceived = true;
              socket.write(headerLines.join('\r\n'), (err) => {
                if (err) cleanup({ type: FrameType.ERROR, message: 'WebSocket write failed' });
              });
            } catch (err) {
              console.error('Invalid UPGRADE response:', err.message);
              cleanup({ type: FrameType.ERROR, message: 'Invalid upgrade response' });
            }
          } else if (frame.type === FrameType.DATA && upgradeResponseReceived) {
            resetIdleTimer();
            targetToBrowserBuffer = Buffer.concat([targetToBrowserBuffer, frame.payload]);
            while (targetToBrowserBuffer.length >= 2 && !closeFramePending) {
              const result = parseWebSocketFrame(targetToBrowserBuffer, true);
              if (!result) break;
              const { frameSize, opcode, remaining } = result;
              const completeFrame = targetToBrowserBuffer.subarray(0, frameSize);
              targetToBrowserBuffer = remaining;
              const isCloseFrame = opcode === 0x08;
              if (isCloseFrame) closeFramePending = true;
              const canWrite = socket.write(completeFrame, (err) => {
                if (err) cleanup({ type: FrameType.ERROR, message: 'WebSocket write failed' });
                else if (isCloseFrame) cleanup();
              });
              if (!canWrite && !browserBackpressured && !isCloseFrame) {
                browserBackpressured = true;
                pausePool(selectedPool, streamId);
                waitForDrain(socket, () => {
                  browserBackpressured = false;
                  if (!cleanupCalled) resumePool(selectedPool, streamId);
                });
              }
              if (isCloseFrame) break;
            }
            if (targetToBrowserBuffer.length > MAX_WS_BUFFER_SIZE) {
              console.error('WebSocket reassembly buffer overflow - closing connection');
              cleanup({ type: FrameType.ERROR, message: 'WebSocket buffer overflow' });
            }
          } else if (frame.type === FrameType.FIN) {
            if (!closeFramePending) cleanup();
          } else if (frame.type === FrameType.ERROR) {
            // Inbound terminal frame: the client already gave up, so no
            // terminal notification is sent back.
            cleanup();
          }
        },
        errorHandler: (err) => {
          if (cleanupCalled) return;
          console.error('WebSocket stream error:', err.message);
          cleanup({ type: FrameType.ERROR, message: 'WebSocket stream error' });
        }
      });

      function scheduleBrowserPump() {
        if (pumpScheduled || cleanupCalled) return;
        pumpScheduled = true;
        process.nextTick(() => {
          pumpScheduled = false;
          try {
            pumpBrowserFrames();
          } catch (err) {
            // A pump failure must never escape as an uncaught exception (that
            // would take down the public listener); fail the stream closed.
            console.error('[502] WebSocket output pump failed:', err && err.message ? err.message : err);
            cleanup({ type: FrameType.ERROR, message: 'WebSocket pump failure' });
          }
        });
      }

      function pauseBrowserInput() {
        if (browserInputPaused || cleanupCalled) return;
        browserInputPaused = true;
        socket.pause();
      }

      function resumeBrowserInput() {
        if (!browserInputPaused) return;
        browserInputPaused = false;
        if (!cleanupCalled && !socket.destroyed) socket.resume();
      }

      // Send one oversized frame's chunks. Returns false when the pump must
      // stop and wait for the pool drain; the retained pendingOffset/pending
      // frame make the remainder resumable.
      function flushPendingLargeFrame() {
        const frame = pendingLargeFrame;
        if (!frame) return true;
        while (pendingOffset < frame.length) {
          const end = Math.min(pendingOffset + MAX_FRAME_SIZE, frame.length);
          const canWrite = selectedPool.send(encodeFrame(streamId, FrameType.DATA, frame.subarray(pendingOffset, end)));
          pendingOffset = end;
          if (!canWrite) {
            pauseBrowserInput();
            waitForPoolDrain(selectedPool, () => {
              resumeBrowserInput();
              scheduleBrowserPump();
            }, streamId);
            return false;
          }
        }
        pendingLargeFrame = null;
        pendingOffset = 0;
        return true;
      }

      // Resumable browser->target pump. Frames are consumed from wsBuffer one
      // at a time and the pump re-schedules itself after every pool drain, so
      // frames already buffered in wsBuffer are never stranded waiting for a
      // new socket 'data' event.
      function pumpBrowserFrames() {
        if (cleanupCalled) return;

        if (pendingLargeFrame && !flushPendingLargeFrame()) return;

        while (wsBuffer.length >= 2) {
          const result = parseWebSocketFrame(wsBuffer, true);
          if (!result) break;
          const { frameSize, opcode, remaining } = result;
          const rawFrame = Buffer.from(wsBuffer.subarray(0, frameSize));
          wsBuffer = remaining;

          if (rawFrame.length <= MAX_FRAME_SIZE) {
            if (!selectedPool.send(encodeFrame(streamId, FrameType.DATA, rawFrame))) {
              pauseBrowserInput();
              waitForPoolDrain(selectedPool, () => {
                resumeBrowserInput();
                scheduleBrowserPump();
              }, streamId);
              return;
            }
          } else {
            pendingLargeFrame = rawFrame;
            pendingOffset = 0;
            pauseBrowserInput();
            if (!flushPendingLargeFrame()) return;
          }

          if (opcode === 0x08) return;
        }

        if (!pendingLargeFrame) resumeBrowserInput();
      }

      function appendBrowserData(chunk) {
        const bufferedBytes = wsBuffer.length + (pendingLargeFrame ? pendingLargeFrame.length - pendingOffset : 0);
        if (bufferedBytes + chunk.length > MAX_WS_BUFFER_SIZE) {
          console.error('WebSocket buffer overflow - destroying connection');
          cleanup({ type: FrameType.ERROR, message: 'WebSocket buffer overflow' });
          return;
        }
        wsBuffer = wsBuffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([wsBuffer, chunk]);
        scheduleBrowserPump();
      }

      socket.on('data', (chunk) => {
        if (cleanupCalled) return;
        resetIdleTimer();
        appendBrowserData(chunk);
      });

      if (headBuffer.length > 0) {
        resetIdleTimer();
        appendBrowserData(headBuffer);
        headBuffer = Buffer.alloc(0);
      }

      socket.on('end', () => {
        if (cleanupCalled) return;
        cleanup({ type: FrameType.FIN });
      });

      socket.on('close', () => {
        if (cleanupCalled) return;
        cleanup({ type: FrameType.FIN });
      });

      socket.on('error', (err) => {
        if (cleanupCalled) return;
        console.error('WebSocket socket error:', err.message);
        cleanup({ type: FrameType.ERROR, message: 'WebSocket socket error' });
      });
    } catch (err) {
      console.error('[502] WebSocket upgrade setup failed:', err && err.message ? err.message : err);
      if (cleanupFn) {
        try {
          cleanupFn({ type: FrameType.ERROR, message: 'WebSocket upgrade failed' });
        } catch { /* ignore */ }
      } else {
        try {
          selectedPool.send(encodeFrame(streamId, FrameType.ERROR, Buffer.from('WebSocket upgrade failed')));
          webSockets.delete(streamId);
          selectedPool.unregisterStream(streamId);
          releaseStream(route, streamId);
        } catch { /* ignore */ }
        socket.destroy();
      }
    }
  }

  server.keepAliveTimeout = httpKeepAliveTimeout;
  server.headersTimeout = httpHeadersTimeout;

  return server;
}

module.exports = {
  createHTTPServer,
  isWebSocketUpgrade,
  buildWebSocketFrame,
  parseWebSocketFrame,
  shouldUseSingleFlow,
  resolveWebSocketNegotiation
};
