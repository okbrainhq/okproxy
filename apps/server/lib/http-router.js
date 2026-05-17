// HTTP Router - Routes public HTTP requests to the tunnel client(s)
// Works with ConnectionPool for multipath support

const { createServer } = require('node:http');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

const STREAM_TIMEOUT = 30000;
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;
const MAX_WS_BUFFER_SIZE = 16 * 1024 * 1024;

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

  const activeWebSockets = new Set();

  const server = createServer((req, res) => {
    if (connectionPool.count === 0) {
      console.error(`[502] No tunnel client connected for ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
      res.statusCode = 502;
      res.end('Tunnel client not connected');
      return;
    }

    if (connectionPool.activeStreams.size >= maxStreams) {
      console.error(`[503] Max concurrent streams exceeded (${connectionPool.activeStreams.size}/${maxStreams}) for ${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('Max concurrent streams exceeded');
      return;
    }

    const streamId = tcpServer.allocateStreamId();

    // Set max listeners on all pool connections
    for (const [name, sock] of connectionPool.connections) {
      sock.setMaxListeners(maxStreams + 10);
    }

    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    // Send HEADERS frame using ConnectionPool
    connectionPool.send(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
      method: req.method,
      path: req.url,
      headers: sanitizeRequestHeaders(req.headers),
      remoteAddress: clientIp
    })));

    let bodySize = 0;
    let cleanedUp = false;

    req.on('data', (chunk) => {
      if (cleanedUp) return;

      bodySize += chunk.length;
      if (bodySize > maxBodySize) {
        console.error(`[413] Request body too large: ${bodySize} bytes (max: ${maxBodySize}) for stream ${streamId}`);
        abortTunnelStream('Request body too large');
        if (!res.writableEnded) {
          res.statusCode = 413;
          res.end('Request body too large');
        }
        req.destroy();
        return;
      }

      let offset = 0;
      while (offset < chunk.length) {
        const end = Math.min(offset + MAX_FRAME_SIZE, chunk.length);
        const frameChunk = chunk.subarray(offset, end);
        connectionPool.send(encodeFrame(streamId, FrameType.DATA, frameChunk));
        offset = end;
      }
    });

    req.on('end', () => {
      if (!cleanedUp) {
        connectionPool.send(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
      }
    });

    req.on('error', (err) => {
      console.error('Request error:', err.message);
      cleanup();
    });

    let streamTimer = setTimeout(() => {
      console.error(`[504] Stream timeout for ${req.method} ${req.url} (stream ${streamId}, client ${clientIp})`);
      connectionPool.send(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Stream timeout')));
      cleanup();
      if (!res.writableEnded) {
        res.statusCode = 504;
        res.end('Gateway timeout');
      }
    }, streamTimeout);

    function resetStreamTimeout() {
      clearTimeout(streamTimer);
      streamTimer = setTimeout(() => {
        console.error(`[504] Stream timeout (reset) for ${req.method} ${req.url} (stream ${streamId}, client ${clientIp})`);
        connectionPool.send(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Stream timeout')));
        cleanup();
        if (!res.writableEnded) {
          res.statusCode = 504;
          res.end('Gateway timeout');
        }
      }, streamTimeout);
    }

    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(streamTimer);
      connectionPool.unregisterStream(streamId);
      tcpServer.releaseStreamId(streamId);
    }

    function abortTunnelStream(message) {
      if (!cleanedUp) {
        connectionPool.send(encodeFrame(streamId, FrameType.ERROR, Buffer.from(message)));
      }
      cleanup();
    }

    let headersSent = false;
    connectionPool.registerStream(streamId, {
      frameHandler: (frame) => {
        resetStreamTimeout();

        if (frame.type === FrameType.HEADERS) {
          try {
            const headers = JSON.parse(frame.payload.toString());
            res.statusCode = headers.status || 200;
            if (headers.headers) {
              const filteredHeaders = filterResponseHeaders(headers.headers);
              for (const [k, v] of Object.entries(filteredHeaders)) {
                try {
                  res.setHeader(k, v);
                } catch (headerErr) {
                  console.error(`Skipping malformed header '${k}':`, headerErr.message);
                }
              }
            }
            headersSent = true;
            resetStreamTimeout();
          } catch (err) {
            console.error('Invalid headers frame:', err.message);
            cleanup();
            res.statusCode = 502;
            res.end('Invalid response');
          }
        } else if (frame.type === FrameType.DATA) {
          if (!headersSent) {
            res.statusCode = 200;
            headersSent = true;
          }
          res.write(frame.payload);
          resetStreamTimeout();
        } else if (frame.type === FrameType.FIN) {
          resetStreamTimeout();
          cleanup();
          if (!res.writableEnded) {
            res.end();
          }
        } else if (frame.type === FrameType.ERROR) {
          const errorMsg = frame.payload?.toString() || 'Unknown error';
          console.error(`[502] Client sent ERROR frame for ${req.method} ${req.url} (stream ${streamId}): ${errorMsg}`);
          cleanup();
          if (!res.writableEnded) {
            res.statusCode = 502;
            res.end('Bad Gateway');
          }
        }
      },
      errorHandler: (err) => {
        console.error(`[502] Stream error for ${req.method} ${req.url} (stream ${streamId}):`, err.message);
        cleanup();
        if (!res.writableEnded) {
          res.statusCode = 502;
          res.end('Bad Gateway');
        }
      }
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        console.error(`[INFO] Client closed connection early for ${req.method} ${req.url} (stream ${streamId})`);
        abortTunnelStream('Public client closed connection');
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    if (connectionPool.count === 0) {
      socket.destroy();
      return;
    }

    let headBuffer = head && head.length > 0 ? head : Buffer.alloc(0);

    if (activeWebSockets.size >= maxWebSocketStreams) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isWebSocketUpgrade(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const streamId = tcpServer.allocateStreamId();
    activeWebSockets.add(streamId);

    for (const [name, sock] of connectionPool.connections) {
      sock.setMaxListeners(maxStreams + maxWebSocketStreams + 10);
    }

    const upgradePayload = JSON.stringify({
      protocol: 'websocket',
      method: req.method,
      path: req.url,
      headers: sanitizeRequestHeaders(req.headers)
    });

    connectionPool.send(encodeFrame(streamId, FrameType.UPGRADE, upgradePayload));

    let wsBuffer = Buffer.alloc(0);
    let targetToBrowserBuffer = Buffer.alloc(0);
    let upgradeResponseReceived = false;
    let cleanupCalled = false;
    let closeFramePending = false;
    const WS_IDLE_TIMEOUT = 300000;
    let idleTimer = null;

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!cleanupCalled) {
          if (upgradeResponseReceived) {
            const closeFrame = buildWebSocketFrame(0x08, Buffer.from([0x03, 0xe9]));
            socket.write(closeFrame, (err) => {
              cleanup();
            });
          } else {
            cleanup();
          }
        }
      }, WS_IDLE_TIMEOUT);
    }

    function cleanup() {
      if (cleanupCalled) return;
      cleanupCalled = true;
      if (idleTimer) clearTimeout(idleTimer);
      activeWebSockets.delete(streamId);
      connectionPool.unregisterStream(streamId);
      tcpServer.releaseStreamId(streamId);
      socket.destroy();
    }

    resetIdleTimer();

    connectionPool.registerStream(streamId, {
      frameHandler: (frame) => {
        if (frame.type === FrameType.UPGRADE) {
          resetIdleTimer();
          try {
            const response = JSON.parse(frame.payload.toString());
            
            if (response.status !== 101) {
              const errorStatus = response.status || 502;
              const errorHeaders = response.headers || {};
              const errorBody = errorHeaders['content-length'] ? '' : `WebSocket upgrade failed: ${errorStatus}\r\n`;
              const headerLines = [
                `HTTP/1.1 ${errorStatus} ${getStatusText(errorStatus)}`,
                'Connection: close',
                `Content-Length: ${Buffer.byteLength(errorBody)}`,
                '',
                ''
              ];
              socket.write(headerLines.join('\r\n') + errorBody, (err) => {
                cleanup();
              });
              return;
            }

            const headers = response.headers || {};
            const headerLines = [
              'HTTP/1.1 101 Switching Protocols',
              `Upgrade: ${headers.upgrade || 'websocket'}`,
              `Connection: ${headers.connection || 'Upgrade'}`,
              `Sec-WebSocket-Accept: ${headers['sec-websocket-accept'] || ''}`,
              '',
              ''
            ];

            upgradeResponseReceived = true;
            socket.write(headerLines.join('\r\n'), (err) => {
              if (err) cleanup();
            });
          } catch (err) {
            console.error('Invalid UPGRADE response:', err.message);
            cleanup();
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
            if (isCloseFrame) {
              closeFramePending = true;
            }

            socket.write(completeFrame, (err) => {
              if (err) {
                cleanup();
              } else if (isCloseFrame) {
                cleanup();
              }
            });

            if (isCloseFrame) break;
          }

          if (targetToBrowserBuffer.length > MAX_WS_BUFFER_SIZE) {
            console.error('WebSocket reassembly buffer overflow - closing connection');
            cleanup();
            return;
          }
        } else if (frame.type === FrameType.FIN) {
          if (!closeFramePending) {
            cleanup();
          }
        } else if (frame.type === FrameType.ERROR) {
          cleanup();
        }
      },
      errorHandler: (err) => {
        console.error('WebSocket stream error:', err.message);
        cleanup();
      }
    });

    let pendingLargeFrame = null;
    let pendingOffset = 0;

    function sendLargeFrameChunk() {
      while (pendingOffset < pendingLargeFrame.length) {
        const end = Math.min(pendingOffset + MAX_FRAME_SIZE, pendingLargeFrame.length);
        const chunk = pendingLargeFrame.subarray(pendingOffset, end);
        connectionPool.send(encodeFrame(streamId, FrameType.DATA, chunk));
        pendingOffset = end;
      }
      pendingLargeFrame = null;
      pendingOffset = 0;
      socket.resume();
    }

    function processBrowserData(chunk) {
      if (wsBuffer.length + chunk.length > MAX_WS_BUFFER_SIZE) {
        console.error('WebSocket buffer overflow - destroying connection');
        cleanup();
        return;
      }
      wsBuffer = Buffer.concat([wsBuffer, chunk]);

      while (wsBuffer.length >= 2) {
        if (pendingLargeFrame) break;

        const result = parseWebSocketFrame(wsBuffer, true);
        if (!result) break;

        const { frameSize, remaining, opcode } = result;

        const rawFrame = Buffer.from(wsBuffer.subarray(0, frameSize));
        wsBuffer = remaining;

        if (rawFrame.length <= MAX_FRAME_SIZE) {
          connectionPool.send(encodeFrame(streamId, FrameType.DATA, rawFrame));
        } else {
          pendingLargeFrame = rawFrame;
          pendingOffset = 0;
          socket.pause();
          sendLargeFrameChunk();
          if (pendingLargeFrame) break;
        }

        if (opcode === 0x08) return;
      }
    }

    socket.on('data', (chunk) => {
      resetIdleTimer();
      processBrowserData(chunk);
    });

    if (headBuffer.length > 0) {
      resetIdleTimer();
      processBrowserData(headBuffer);
      headBuffer = Buffer.alloc(0);
    }

    socket.on('end', () => {
      if (!cleanupCalled) {
        connectionPool.send(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
        cleanup();
      }
    });

    socket.on('close', () => {
      if (!cleanupCalled) {
        connectionPool.send(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
        cleanup();
      }
    });

    socket.on('error', (err) => {
      console.error('WebSocket socket error:', err.message);
      cleanup();
    });
  });

  return server;
}

module.exports = { createHTTPServer, isWebSocketUpgrade, buildWebSocketFrame, parseWebSocketFrame };
