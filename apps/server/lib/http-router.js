// HTTP Router - Routes public HTTP requests to the single tunnel client

const { createServer } = require('node:http');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

const STREAM_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB default

// Hop-by-hop headers that should not be forwarded (RFC 2616)
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

/**
 * Detect WebSocket upgrade request
 * @param {Object} req - HTTP request object
 * @returns {boolean} True if this is a WebSocket upgrade request
 */
function isWebSocketUpgrade(req) {
  const upgrade = req.headers.upgrade?.toLowerCase();
  const connection = req.headers.connection?.toLowerCase();
  return upgrade === 'websocket' && 
         (connection === 'upgrade' || connection?.includes('upgrade'));
}

/**
 * Filter hop-by-hop headers from response headers
 * @param {Object} headers - Raw headers from target
 * @returns {Object} Filtered headers safe to send to client
 */
function filterResponseHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Sanitize request headers for JSON serialization
 * Ensures all values are strings and removes any problematic entries
 * @param {Object} headers - Raw headers from HTTP request
 * @returns {Object} Sanitized headers safe to serialize
 */
function sanitizeRequestHeaders(headers) {
  const sanitized = {};
  for (const [key, value] of Object.entries(headers)) {
    // Node.js http parser ensures keys are strings, but values could be arrays or other types
    if (typeof value === 'string') {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      // Join multiple headers with same name (RFC 2616 allows this)
      sanitized[key] = value.join(', ');
    }
    // Skip non-string, non-array values (shouldn't happen with Node.js HTTP parser)
  }
  return sanitized;
}

/**
 * Build WebSocket frame for sending to browser
 * @param {number} opcode - WebSocket opcode (1=text, 2=binary, 8=close, 9=ping, 10=pong)
 * @param {Buffer} payload - Frame payload
 * @returns {Buffer} WebSocket frame
 */
function buildWebSocketFrame(opcode, payload) {
  const payloadLen = payload.length;
  let frame;
  
  if (payloadLen < 126) {
    // Small payload: 2 byte header + payload
    frame = Buffer.allocUnsafe(2 + payloadLen);
    frame[0] = 0x80 | opcode; // FIN=1, opcode
    frame[1] = payloadLen;
    payload.copy(frame, 2);
  } else if (payloadLen < 65536) {
    // Medium payload: 4 byte header + payload
    frame = Buffer.allocUnsafe(4 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 126;
    frame.writeUInt16BE(payloadLen, 2);
    payload.copy(frame, 4);
  } else {
    // Large payload: 10 byte header + payload (up to 4GB)
    frame = Buffer.allocUnsafe(10 + payloadLen);
    frame[0] = 0x80 | opcode;
    frame[1] = 127;
    frame.writeUInt32BE(0, 2); // High 32 bits = 0
    frame.writeUInt32BE(payloadLen, 6); // Low 32 bits
    payload.copy(frame, 10);
  }
  
  return frame;
}

/**
 * Parse WebSocket frame from browser
 * @param {Buffer} buffer - Raw data from socket
 * @returns {Object|null} Parsed frame {fin, opcode, payload, remaining} or null if incomplete
 */
function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) return null; // Need at least 2 bytes
  
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7f;
  
  let offset = 2;
  
  // Extended payload length
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    // Read 64-bit length (but we only support 32-bit for now)
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    if (high !== 0) throw new Error('Payload too large (>4GB)');
    payloadLen = low;
    offset = 10;
  }
  
  // Mask key (client frames are always masked)
  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  
  // Check if we have full payload
  if (buffer.length < offset + payloadLen) return null;
  
  const payload = buffer.subarray(offset, offset + payloadLen);
  
  // Unmask if needed
  if (masked && maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }
  
  const remaining = buffer.subarray(offset + payloadLen);
  
  return {
    fin,
    opcode,  // 1=text, 2=binary, 8=close, 9=ping, 10=pong
    payload,
    remaining  // Unparsed data for next frame
  };
}

function createHTTPServer(clientManager, tcpServer, options = {}) {
  const streamTimeout = options.streamTimeout || STREAM_TIMEOUT;
  const maxStreams = options.maxConcurrentStreams || 100;
  const maxBodySize = options.maxBodySize || DEFAULT_MAX_BODY_SIZE;

  const server = createServer((req, res) => {
    const client = clientManager.get();
    if (!client) {
      res.statusCode = 502;
      res.end('Tunnel client not connected');
      return;
    }

    // Check max concurrent streams atomically during registration
    if (client.activeStreams && client.activeStreams.size >= maxStreams) {
      res.statusCode = 503;
      res.end('Max concurrent streams exceeded');
      return;
    }

    const streamId = tcpServer.allocateStreamId();

    // Increase max listeners to handle concurrent streams without warnings
    // Each active stream adds a drain listener on the shared socket
    client.socket.setMaxListeners(maxStreams + 10);

    // Capture the socket reference to ensure we remove from the correct socket
    // (client.socket may change if a new client reconnects)
    const clientSocket = client.socket;

    // Set up backpressure handling
    let paused = false;
    function onDrain() {
      paused = false;
      req.resume();
    }
    clientSocket.on('drain', onDrain);

    // Get real client IP (handle both IPv4 and IPv6)
    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    // Send HEADERS frame (use full URL as path to target)
    // Include real client IP so proxy can set authoritative X-Forwarded-For
    const canWriteHeaders = client.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
      method: req.method,
      path: req.url,
      headers: sanitizeRequestHeaders(req.headers),
      remoteAddress: clientIp
    })));
    if (!canWriteHeaders) {
      paused = true;
      req.pause();
    }

    // Stream request body with size limit
    let bodySize = 0;
    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > maxBodySize) {
        // Body size exceeded - abort request
        cleanup();
        if (!res.writableEnded) {
          res.statusCode = 413; // Payload Too Large
          res.end('Request body too large');
        }
        // Stop reading from the request to prevent continued streaming
        req.destroy();
        return;
      }

      // Split large chunks into multiple frames (max 1MB each)
      let offset = 0;
      while (offset < chunk.length) {
        const end = Math.min(offset + MAX_FRAME_SIZE, chunk.length);
        const frameChunk = chunk.subarray(offset, end);
        const canWrite = client.write(encodeFrame(streamId, FrameType.DATA, frameChunk));
        if (!canWrite && !paused) {
          paused = true;
          req.pause();
        }
        offset = end;
      }
    });

    req.on('end', () => {
      client.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
    });

    req.on('error', (err) => {
      console.error('Request error:', err.message);
      cleanup();
    });

    // Set up stream timeout
    let streamTimer = setTimeout(() => {
      client.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Stream timeout')));
      cleanup();
      if (!res.writableEnded) {
        res.statusCode = 504;
        res.end('Gateway timeout');
      }
    }, streamTimeout);

    function resetStreamTimeout() {
      clearTimeout(streamTimer);
      streamTimer = setTimeout(() => {
        client.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Stream timeout')));
        cleanup();
        if (!res.writableEnded) {
          res.statusCode = 504;
          res.end('Gateway timeout');
        }
      }, streamTimeout);
    }

    function cleanup() {
      clearTimeout(streamTimer);
      // Use captured socket reference to avoid removing from wrong client
      clientSocket.removeListener('drain', onDrain);
      clientManager.unregisterStream(streamId);
      tcpServer.releaseStreamId(streamId);
    }

    // Register stream handler
    let headersSent = false;
    clientManager.registerStream(streamId, {
      frameHandler: (frame) => {
        resetStreamTimeout();

        if (frame.type === FrameType.HEADERS) {
          try {
            const headers = JSON.parse(frame.payload.toString());
            res.statusCode = headers.status || 200;
            // Add target service headers (filter hop-by-hop headers)
            if (headers.headers) {
              const filteredHeaders = filterResponseHeaders(headers.headers);
              for (const [k, v] of Object.entries(filteredHeaders)) {
                try {
                  res.setHeader(k, v);
                } catch (headerErr) {
                  // Skip malformed headers - log but don't fail the whole request
                  console.error(`Skipping malformed header '${k}':`, headerErr.message);
                }
              }
            }
            headersSent = true;
            // Reset timeout on outgoing headers - critical for slow-starting responses
            // that take nearly 30s to send headers before streaming data
            resetStreamTimeout();
          } catch (err) {
            console.error('Invalid headers frame:', err.message);
            cleanup();
            res.statusCode = 502;
            res.end('Invalid response');
          }
        } else if (frame.type === FrameType.DATA) {
          if (!headersSent) {
            // Auto-send 200 if headers not sent yet
            res.statusCode = 200;
            headersSent = true;
          }
          res.write(frame.payload);
          // Reset timeout on outgoing data - critical for SSE where client sends nothing after initial request.
          // Without this, unidirectional server→client streams timeout after 30s because the timeout
          // was only being reset when receiving frames FROM the client. See: .design/06-sse-stream-timeout-fix.md
          resetStreamTimeout();
        } else if (frame.type === FrameType.FIN) {
          // Reset timeout before cleanup to prevent race with timer callback
          resetStreamTimeout();
          cleanup();
          if (!res.writableEnded) {
            res.end();
          }
        } else if (frame.type === FrameType.ERROR) {
          cleanup();
          if (!res.writableEnded) {
            res.statusCode = 502;
            // Use generic error message to avoid leaking internal details
            res.end('Bad Gateway');
          }
        }
      },
      errorHandler: (err) => {
        // Log error internally but don't leak details to client
        console.error('Stream error:', err.message);
        cleanup();
        if (!res.writableEnded) {
          res.statusCode = 502;
          // Use generic error message to avoid leaking internal details
          res.end('Bad Gateway');
        }
      }
    });

    // Handle response closure
    res.on('close', () => {
      if (!res.writableEnded) {
        // Client closed connection early
        cleanup();
      }
    });
  });

  // Handle WebSocket upgrade events
  server.on('upgrade', (req, socket, head) => {
    const client = clientManager.get();
    if (!client) {
      socket.destroy();
      return;
    }

    // Check max concurrent streams
    if (client.activeStreams && client.activeStreams.size >= maxStreams) {
      socket.destroy();
      return;
    }

    // Verify this is actually a WebSocket upgrade
    if (!isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }

    const streamId = tcpServer.allocateStreamId();

    // Increase max listeners
    client.socket.setMaxListeners(maxStreams + 10);
    const clientSocket = client.socket;

    // Send UPGRADE frame to client with original request info
    const upgradePayload = JSON.stringify({
      protocol: 'websocket',
      method: req.method,
      path: req.url,
      headers: sanitizeRequestHeaders(req.headers)
    });

    const canWrite = client.write(encodeFrame(streamId, FrameType.UPGRADE, upgradePayload));
    if (!canWrite) {
      // If we can't write, clean up and destroy socket
      tcpServer.releaseStreamId(streamId);
      socket.destroy();
      return;
    }

    // WebSocket frame buffer for parsing
    let wsBuffer = Buffer.alloc(0);
    let upgradeResponseReceived = false;
    let cleanupCalled = false;

    function cleanup() {
      if (cleanupCalled) return;
      cleanupCalled = true;
      clientManager.unregisterStream(streamId);
      tcpServer.releaseStreamId(streamId);
      socket.destroy();
    }

    // Register stream handler for client's response
    clientManager.registerStream(streamId, {
      frameHandler: (frame) => {
        if (frame.type === FrameType.UPGRADE) {
          // Client is sending the target's upgrade response
          try {
            const response = JSON.parse(frame.payload.toString());
            
            if (response.status !== 101) {
              // Upgrade rejected
              cleanup();
              return;
            }

            // Send 101 response to browser
            const headers = response.headers || {};
            const headerLines = [
              'HTTP/1.1 101 Switching Protocols',
              `Upgrade: ${headers.upgrade || 'websocket'}`,
              `Connection: ${headers.connection || 'Upgrade'}`,
              `Sec-WebSocket-Accept: ${headers['sec-websocket-accept'] || ''}`,
              '',
              ''
            ];

            // Write response
            socket.write(headerLines.join('\r\n'), (err) => {
              if (err) {
                cleanup();
                return;
              }
              upgradeResponseReceived = true;
            });
          } catch (err) {
            console.error('Invalid UPGRADE response:', err.message);
            cleanup();
          }
        } else if (frame.type === FrameType.DATA && upgradeResponseReceived) {
          // Forward WebSocket frame to browser
          // frame.payload is already a WebSocket frame from the target
          socket.write(frame.payload, (err) => {
            if (err) cleanup();
          });
        } else if (frame.type === FrameType.FIN) {
          // Client signaled end - close browser connection
          cleanup();
        } else if (frame.type === FrameType.ERROR) {
          cleanup();
        }
      },
      errorHandler: (err) => {
        console.error('WebSocket stream error:', err.message);
        cleanup();
      }
    });

    // Handle WebSocket frames from browser
    socket.on('data', (chunk) => {
      wsBuffer = Buffer.concat([wsBuffer, chunk]);
      
      // Parse and forward complete frames
      while (wsBuffer.length >= 2) {
        const result = parseWebSocketFrame(wsBuffer);
        if (!result) break; // Need more data
        
        const { fin, opcode, payload, remaining } = result;
        wsBuffer = remaining;
        
        // Build WebSocket frame and wrap in DATA frame
        const wsFrame = buildWebSocketFrame(opcode, payload);
        const canWrite = client.write(encodeFrame(streamId, FrameType.DATA, wsFrame));
        
        if (!canWrite) {
          // Backpressure - pause reading
          socket.pause();
          clientSocket.once('drain', () => {
            socket.resume();
          });
        }
        
        // Handle close frame - clean up
        if (opcode === 0x08) {
          cleanup();
          return;
        }
      }
    });

    socket.on('close', () => {
      if (!cleanupCalled) {
        // Browser closed - signal to client
        client.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
        cleanup();
      }
    });

    socket.on('error', (err) => {
      console.error('WebSocket socket error:', err.message);
      cleanup();
    });

    // No stream timeout for WebSocket streams - they're long-lived
    // Connection health is managed via WebSocket ping/pong or TLS keepalive
  });

  return server;
}

module.exports = { createHTTPServer, isWebSocketUpgrade, buildWebSocketFrame, parseWebSocketFrame };
