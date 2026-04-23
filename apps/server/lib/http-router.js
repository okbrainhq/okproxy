// HTTP Router - Routes public HTTP requests to the single tunnel client

const { createServer } = require('node:http');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

const STREAM_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB default
const MAX_WS_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB max WebSocket buffer to prevent OOM

// Common HTTP status texts for error responses
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
 * @param {boolean} boundariesOnly - If true, only return frame size/opcode without unmasking
 * @returns {Object|null} Parsed frame or null if incomplete
 *   - boundariesOnly=false: {fin, opcode, payload, remaining}
 *   - boundariesOnly=true: {frameSize, opcode, remaining}
 */
function parseWebSocketFrame(buffer, boundariesOnly = false) {
  if (buffer.length < 2) return null;
  
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
    const high = buffer.readUInt32BE(2);
    if (high !== 0) return null; // Payload too large (>4GB)
    payloadLen = buffer.readUInt32BE(6);
    offset = 10;
  }
  
  // Account for mask key length if present
  if (masked) {
    offset += 4;
  }
  
  // Check if we have full payload
  const frameSize = offset + payloadLen;
  if (buffer.length < frameSize) return null;
  
  const remaining = buffer.subarray(frameSize);
  
  if (boundariesOnly) {
    // Return frame size and opcode for slicing raw bytes
    return { frameSize, opcode, remaining };
  }
  
  // Full parsing with unmasking
  let payload = buffer.subarray(offset, frameSize);
  
  // Unmask if needed
  if (masked) {
    const maskKey = buffer.subarray(offset - 4, offset);
    // Create a copy to avoid modifying the original buffer
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }
  
  return {
    fin,
    opcode,
    payload,
    remaining
  };
}

function createHTTPServer(clientManager, tcpServer, options = {}) {
  const streamTimeout = options.streamTimeout || STREAM_TIMEOUT;
  const maxStreams = options.maxConcurrentStreams || 100;
  const maxWebSocketStreams = options.maxWebSocketStreams || 50; // Separate cap for WS
  const maxBodySize = options.maxBodySize || DEFAULT_MAX_BODY_SIZE;

  // Track WebSocket connections separately from HTTP streams
  const activeWebSockets = new Set();

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

    // Check max WebSocket concurrent streams (separate from HTTP)
    if (activeWebSockets.size >= maxWebSocketStreams) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Verify this is actually a WebSocket upgrade
    if (!isWebSocketUpgrade(req)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const streamId = tcpServer.allocateStreamId();

    // Track this WebSocket connection
    activeWebSockets.add(streamId);

    // Increase max listeners
    client.socket.setMaxListeners(maxStreams + maxWebSocketStreams + 10);
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

    // WebSocket frame buffer for parsing (browser -> target)
    let wsBuffer = Buffer.alloc(0);
    // Buffer for reassembling fragmented frames (target -> browser)
    let targetToBrowserBuffer = Buffer.alloc(0);
    let upgradeResponseReceived = false;
    let cleanupCalled = false;

    function cleanup() {
      if (cleanupCalled) return;
      cleanupCalled = true;
      activeWebSockets.delete(streamId);
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
              // Upgrade rejected - send HTTP error response to browser before closing
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

            // Write response - set flag synchronously before async write
            upgradeResponseReceived = true;
            socket.write(headerLines.join('\r\n'), (err) => {
              if (err) cleanup();
            });
          } catch (err) {
            console.error('Invalid UPGRADE response:', err.message);
            cleanup();
          }
        } else if (frame.type === FrameType.DATA && upgradeResponseReceived) {
          // Buffer and reassemble fragmented WebSocket frames
          // Large frames are split across multiple DATA frames, so we need to
          // accumulate until we have a complete WebSocket frame
          targetToBrowserBuffer = Buffer.concat([targetToBrowserBuffer, frame.payload]);

          // Try to extract complete WebSocket frames from buffer
          while (targetToBrowserBuffer.length >= 2) {
            const result = parseWebSocketFrame(targetToBrowserBuffer, true);
            if (!result) break; // Need more data for complete frame

            const { frameSize, remaining } = result;

            // Extract complete frame and write to browser
            const completeFrame = targetToBrowserBuffer.subarray(0, frameSize);
            targetToBrowserBuffer = remaining;

            socket.write(completeFrame, (err) => {
              if (err) cleanup();
            });
          }

          // Safety check: prevent unbounded buffer growth
          if (targetToBrowserBuffer.length > MAX_WS_BUFFER_SIZE) {
            console.error('WebSocket reassembly buffer overflow - closing connection');
            cleanup();
            return;
          }
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
    let pendingLargeFrame = null; // For fragmented sending across backpressure
    let pendingOffset = 0;

    function sendLargeFrameChunk() {
      // Continue sending pending large frame from pendingOffset
      while (pendingOffset < pendingLargeFrame.length) {
        const end = Math.min(pendingOffset + MAX_FRAME_SIZE, pendingLargeFrame.length);
        const chunk = pendingLargeFrame.subarray(pendingOffset, end);
        const canWrite = client.write(encodeFrame(streamId, FrameType.DATA, chunk));
        if (!canWrite) {
          // Backpressure - pause and wait for drain
          socket.pause();
          pendingOffset = end;
          clientSocket.once('drain', sendLargeFrameChunk);
          return;
        }
        pendingOffset = end;
      }
      // Finished sending this frame
      pendingLargeFrame = null;
      pendingOffset = 0;
      socket.resume();
    }

    socket.on('data', (chunk) => {
      // Check for unbounded buffer growth attack
      if (wsBuffer.length + chunk.length > MAX_WS_BUFFER_SIZE) {
        console.error('WebSocket buffer overflow - destroying connection');
        cleanup();
        return;
      }
      wsBuffer = Buffer.concat([wsBuffer, chunk]);

      // Parse frame boundaries but forward RAW BYTES (preserves masking)
      // RFC 6455 requires client->server frames to be masked
      while (wsBuffer.length >= 2) {
        // If we're in the middle of sending a large frame, skip new frames until done
        if (pendingLargeFrame) break;

        const result = parseWebSocketFrame(wsBuffer, true); // true = boundaries only
        if (!result) break; // Need more data

        const { frameSize, remaining, opcode } = result;

        // Slice the raw frame (preserves original masking)
        const rawFrame = Buffer.from(wsBuffer.subarray(0, frameSize));
        wsBuffer = remaining;

        // Fragment large WebSocket frames to avoid tunnel frame size limit (MAX_FRAME_SIZE = 1MB)
        // This prevents the tunnel-wide kill switch when WS frames exceed 1MB
        if (rawFrame.length <= MAX_FRAME_SIZE) {
          // Small frame: send in single DATA frame
          const canWrite = client.write(encodeFrame(streamId, FrameType.DATA, rawFrame));
          if (!canWrite) {
            // Backpressure - pause reading
            socket.pause();
            clientSocket.once('drain', () => {
              socket.resume();
            });
          }
        } else {
          // Large frame: start fragmenting
          pendingLargeFrame = rawFrame;
          pendingOffset = 0;
          sendLargeFrameChunk();
          // If backpressure hit, sendLargeFrameChunk will pause and break via pendingLargeFrame check
          if (pendingLargeFrame) break;
        }

        // Handle close frame - forward it and stop reading, but don't cleanup yet.
        // The target will respond with its own close frame, which flows back:
        // target → client → DATA → server → browser. Cleanup happens when
        // the client sends FIN (target closed) or the browser socket closes.
        if (opcode === 0x08) {
          return;
        }
      }
    });

    socket.on('end', () => {
      // Browser half-closed connection (readable side ended)
      if (!cleanupCalled) {
        client.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
        cleanup();
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

    // WebSocket idle timeout - close connection if no activity for 5 minutes
    // This prevents hung connections while still allowing long-lived WS streams
    const WS_IDLE_TIMEOUT = 300000; // 5 minutes
    let idleTimer = setTimeout(() => {
      if (!cleanupCalled) {
        // Send close frame before cleanup (if upgrade completed)
        if (upgradeResponseReceived) {
          const closeFrame = buildWebSocketFrame(0x08, Buffer.from([0x03, 0xe9])); // 1001 = going away
          socket.write(closeFrame);
        }
        cleanup();
      }
    }, WS_IDLE_TIMEOUT);

    // Reset idle timer on any data activity
    const originalOnData = socket.listeners('data')[0];
    socket.removeListener('data', originalOnData);
    socket.on('data', (chunk) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!cleanupCalled) {
          if (upgradeResponseReceived) {
            const closeFrame = buildWebSocketFrame(0x08, Buffer.from([0x03, 0xe9]));
            socket.write(closeFrame);
          }
          cleanup();
        }
      }, WS_IDLE_TIMEOUT);
      originalOnData(chunk);
    });

    // Clean up idle timer on cleanup
    const originalCleanup = cleanup;
    cleanup = function() {
      clearTimeout(idleTimer);
      originalCleanup();
    };
  });

  return server;
}

module.exports = { createHTTPServer, isWebSocketUpgrade, buildWebSocketFrame, parseWebSocketFrame };
