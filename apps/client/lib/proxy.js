// Proxy - HTTP proxy to local target service

const { request } = require('node:http');
const { encodeFrame, FrameType, MAX_FRAME_SIZE } = require('../../../packages/frame-protocol');

// Hop-by-hop headers that should not be forwarded to target (RFC 2616)
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length' // Strip content-length - let Node.js recalculate for streamed body
]);

// X-Forwarded headers that must be stripped to prevent spoofing
// We will set these ourselves with authoritative values
const X_FORWARDED_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-path',
  'forwarded'
]);

/**
 * Filter hop-by-hop headers before forwarding to target
 * Also strips X-Forwarded-* headers to prevent client spoofing
 * @param {Object} headers - Raw headers from tunnel
 * @returns {Object} Filtered headers safe to send to target
 */
function filterRequestHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    // Strip both hop-by-hop and X-Forwarded headers
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && !X_FORWARDED_HEADERS.has(lowerKey)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// Hop-by-hop headers to strip for WebSocket (RFC 2616)
// Note: upgrade and connection are preserved for WebSocket handshake
const WS_HOP_BY_HOP_HEADERS = new Set([
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length' // Strip content-length - let Node.js recalculate
]);

/**
 * Filter headers for WebSocket upgrade requests
 * For WebSocket, we need to preserve Upgrade and Connection headers
 * but strip other hop-by-hop headers (te, trailer, keep-alive, etc.)
 * @param {Object} headers - Raw headers
 * @returns {Object} Filtered headers for WebSocket upgrade
 */
function filterWebSocketHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    // Strip both hop-by-hop (except upgrade/connection) and X-Forwarded headers
    if (!WS_HOP_BY_HOP_HEADERS.has(lowerKey) && !X_FORWARDED_HEADERS.has(lowerKey)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

const MAX_WS_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB max WebSocket buffer to prevent OOM

function createProxy(connection, targetPort, targetHost = 'localhost', maxStreams = 100) {
  const activeStreams = new Map(); // streamId -> { proxyReq, onDrain }
  const drainListeners = new Map(); // streamId -> onDrain function
  const activeWebSockets = new Map(); // streamId -> { socket, cleanup }

  // Increase max listeners to handle concurrent streams without warnings
  // Each active stream adds a drain listener on the shared socket
  if (connection.socket) {
    connection.socket.setMaxListeners(maxStreams + 10);
  }

  function handleFrame(frame) {
    // Handle PING (respond with PONG)
    if (frame.streamId === 0 && frame.type === FrameType.PING) {
      connection.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
      return;
    }

    // Handle WebSocket streams
    if (activeWebSockets.has(frame.streamId)) {
      handleWebSocketFrame(frame);
      return;
    }

    // Handle server frames
    if (frame.type === FrameType.HEADERS) {
      // New request from server
      startProxyRequest(frame.streamId, frame.payload);
    } else if (frame.type === FrameType.UPGRADE) {
      // WebSocket upgrade request
      startWebSocketProxy(frame.streamId, frame.payload);
    } else if (frame.type === FrameType.DATA) {
      // Body chunk from server
      const proxyReq = activeStreams.get(frame.streamId);
      if (proxyReq && !proxyReq.destroyed) {
        const canWrite = proxyReq.write(frame.payload);
        if (!canWrite) {
          // Backpressure - proxyReq will emit 'drain'
        }
      }
    } else if (frame.type === FrameType.FIN) {
      // Request body complete
      const proxyReq = activeStreams.get(frame.streamId);
      if (proxyReq && !proxyReq.destroyed) {
        proxyReq.end();
      }
    } else if (frame.type === FrameType.ERROR) {
      // Server error on this stream
      const proxyReq = activeStreams.get(frame.streamId);
      if (proxyReq) {
        proxyReq.destroy();
        activeStreams.delete(frame.streamId);
      }
    }
  }

  function handleWebSocketFrame(frame) {
    const wsState = activeWebSockets.get(frame.streamId);
    if (!wsState) return;

    if (frame.type === FrameType.DATA) {
      // Buffer and reassemble fragmented WebSocket frames
      // Large frames are split across multiple DATA frames, so we need to
      // accumulate until we have a complete WebSocket frame
      wsState.reassemblyBuffer = Buffer.concat([wsState.reassemblyBuffer, frame.payload]);

      // Try to extract complete WebSocket frames from buffer
      while (wsState.reassemblyBuffer.length >= 2 && !wsState.closeFramePending) {
        const result = parseWebSocketFrame(wsState.reassemblyBuffer, true);
        if (!result) break; // Need more data for complete frame

        const { frameSize, opcode, remaining } = result;

        // Check if this is a close frame (bug #21 fix)
        const isCloseFrame = opcode === 0x08;
        if (isCloseFrame) {
          wsState.closeFramePending = true;
        }

        // Extract complete frame and write to target
        const completeFrame = wsState.reassemblyBuffer.subarray(0, frameSize);
        wsState.reassemblyBuffer = remaining;

        const canWrite = wsState.socket.write(completeFrame);
        if (!canWrite && !isCloseFrame) {
          wsState.socket.pause();
          connection.socket.once('drain', () => {
            wsState.socket.resume();
          });
        }

        if (isCloseFrame) {
          setTimeout(() => {
            if (!wsState.cleanupCalled) {
              wsState.cleanup();
            }
          }, 5000);
          break;
        }
      }

      // Safety check: prevent unbounded buffer growth
      if (wsState.reassemblyBuffer.length > MAX_WS_BUFFER_SIZE) {
        console.error('WebSocket reassembly buffer overflow - closing connection');
        wsState.cleanup();
        return;
      }
    } else if (frame.type === FrameType.FIN) {
      // Server signaled end - close WebSocket
      // Wait for any pending close frame to be sent before cleanup (bug #21 fix)
      if (!wsState.closeFramePending) {
        wsState.cleanup();
      }
      // If close frame is pending, cleanup will be called after it's sent
    } else if (frame.type === FrameType.ERROR) {
      wsState.cleanup();
    }
  }

  function startWebSocketProxy(streamId, payload) {
    try {
      const upgradeInfo = JSON.parse(payload.toString());
      
      if (upgradeInfo.protocol !== 'websocket') {
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Unsupported protocol')));
        return;
      }

      // For WebSocket, preserve original headers including Upgrade/Connection
      const proxyHeaders = filterWebSocketHeaders(upgradeInfo.headers);
      proxyHeaders.host = `${targetHost}:${targetPort}`;

      // Set authoritative X-Forwarded-For
      if (upgradeInfo.remoteAddress) {
        proxyHeaders['x-forwarded-for'] = upgradeInfo.remoteAddress;
      }

      const proxyReq = request({
        hostname: targetHost,
        port: targetPort,
        method: upgradeInfo.method,
        path: upgradeInfo.path,
        headers: proxyHeaders
      });

      // Set timeout on upgrade request to prevent hanging if target never responds
      let upgradeTimeoutTriggered = false;
      proxyReq.setTimeout(30000, () => {
        upgradeTimeoutTriggered = true;
        proxyReq.destroy();
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Upgrade timeout')));
      });

      let cleanupCalled = false;

      // Pre-declare wsState so cleanup can reference it
      const wsState = {
        socket: null,
        cleanup: null, // Will be set below
        reassemblyBuffer: Buffer.alloc(0), // For reassembling fragmented WS frames
        closeFramePending: false, // Track if close frame is being sent (bug #21 fix)
        cleanupCalled: false // Track cleanup state for race condition handling
      };

      function cleanup() {
        if (cleanupCalled || wsState.cleanupCalled) return;
        cleanupCalled = true;
        wsState.cleanupCalled = true;

        activeWebSockets.delete(streamId);

        if (wsState.socket && !wsState.socket.destroyed) {
          wsState.socket.destroy();
        }

        // Signal to server that stream is done
        connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
      }

      wsState.cleanup = cleanup;

      proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
        // Target accepted upgrade
        wsState.socket = proxySocket;
        activeWebSockets.set(streamId, wsState);

        // Send target's response back to server
        const responseHeaders = {
          upgrade: proxyRes.headers.upgrade || 'websocket',
          connection: proxyRes.headers.connection || 'Upgrade',
          'sec-websocket-accept': proxyRes.headers['sec-websocket-accept']
        };

        // Forward any other relevant headers (case-insensitive check to avoid duplicates)
        const responseHeadersLower = Object.fromEntries(
          Object.entries(responseHeaders).map(([k, v]) => [k.toLowerCase(), v])
        );
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!(key.toLowerCase() in responseHeadersLower)) {
            responseHeaders[key] = value;
          }
        }

        connection.write(encodeFrame(streamId, FrameType.UPGRADE, JSON.stringify({
          status: 101,
          headers: responseHeaders
        })));

        // Handle data from target - forward RAW BYTES (preserves unmasked server frames)
        // Include any early data received during upgrade (bug #20 fix)
        let buffer = proxyHead && proxyHead.length > 0 ? proxyHead : Buffer.alloc(0);
        let pendingLargeFrame = null; // For fragmented sending across backpressure
        let pendingOffset = 0;

        function sendLargeFrameChunk() {
          // Continue sending pending large frame from pendingOffset
          while (pendingOffset < pendingLargeFrame.length) {
            const end = Math.min(pendingOffset + MAX_FRAME_SIZE, pendingLargeFrame.length);
            const chunk = pendingLargeFrame.subarray(pendingOffset, end);
            const canWrite = connection.write(encodeFrame(streamId, FrameType.DATA, chunk));
            if (!canWrite) {
              // Backpressure - pause and wait for drain
              proxySocket.pause();
              pendingOffset = end;
              connection.socket.once('drain', sendLargeFrameChunk);
              return;
            }
            pendingOffset = end;
          }
          // Finished sending this frame
          pendingLargeFrame = null;
          pendingOffset = 0;
          proxySocket.resume();
        }

        proxySocket.on('data', (chunk) => {
          // Check for unbounded buffer growth attack
          if (buffer.length + chunk.length > MAX_WS_BUFFER_SIZE) {
            console.error('WebSocket buffer overflow - destroying connection');
            cleanup();
            return;
          }
          buffer = Buffer.concat([buffer, chunk]);

          // Parse frame boundaries but forward RAW BYTES
          while (buffer.length >= 2) {
            // If we're in the middle of sending a large frame, skip new frames until done
            if (pendingLargeFrame) break;

            const frameInfo = parseWebSocketFrame(buffer, true); // true = boundaries only
            if (!frameInfo) break;

            const { frameSize, opcode, remaining } = frameInfo;

            // Slice the raw frame (preserves original format)
            const rawFrame = Buffer.from(buffer.subarray(0, frameSize));
            buffer = remaining;

            // Check if this is a close frame (bug #21 fix)
            const isCloseFrame = opcode === 0x08;
            if (isCloseFrame) {
              wsState.closeFramePending = true;
            }

            // Fragment large WebSocket frames to avoid tunnel frame size limit (MAX_FRAME_SIZE = 1MB)
            // This prevents the tunnel-wide kill switch when WS frames exceed 1MB
            if (rawFrame.length <= MAX_FRAME_SIZE) {
              // Small frame: send in single DATA frame
              const canWrite = connection.write(encodeFrame(streamId, FrameType.DATA, rawFrame));
              if (!canWrite) {
                proxySocket.pause();
                connection.socket.once('drain', () => {
                  proxySocket.resume();
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

            // Handle close from target - wait for write to complete before cleanup (bug #21 fix)
            if (isCloseFrame) {
              // Use setImmediate to ensure the write has been queued before we check/drain
              setImmediate(() => {
                // Wait for drain if backpressure, then cleanup
                if (!connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)))) {
                  connection.socket.once('drain', cleanup);
                } else {
                  cleanup();
                }
              });
              return;
            }
          }
        });

        proxySocket.on('close', () => {
          // Wait for any pending close frame to be sent before cleanup (bug #21 fix)
          if (!cleanupCalled && !wsState.closeFramePending) {
            cleanup();
          }
          // If close frame is pending, cleanup will be called after it's sent
        });

        proxySocket.on('error', (err) => {
          console.error(`[CLIENT WS ERROR] WebSocket target error:`, err.message, `(code: ${err.code || 'none'})`);
          cleanup();
        });
      });

      proxyReq.on('error', (err) => {
        if (upgradeTimeoutTriggered) return;
        console.error(`[CLIENT WS ERROR] WebSocket upgrade failed for ${upgradeInfo.path}:`, err.message, `(code: ${err.code || 'none'})`);
        const errorDetail = err.code ? `Upgrade failed: ${err.code}` : 'Upgrade failed';
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(errorDetail)));
      });

      // No response means upgrade was successful (handled by 'upgrade' event)
      // We need to explicitly end the request to trigger the upgrade
      proxyReq.end();

    } catch (err) {
      console.error('Invalid UPGRADE payload:', err.message);
      connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Invalid upgrade request')));
    }
  }

  function startProxyRequest(streamId, payload) {
    try {
      const reqInfo = JSON.parse(payload.toString());

      // Filter hop-by-hop headers and rewrite for local request
      const proxyHeaders = filterRequestHeaders(reqInfo.headers);
      proxyHeaders.host = `${targetHost}:${targetPort}`;

      // Remove origin/referer to prevent CSRF issues
      // The app will see this as a direct request, not cross-origin
      delete proxyHeaders.origin;
      delete proxyHeaders.referer;

      // Set authoritative X-Forwarded-For with real client IP from server
      // This prevents clients from spoofing their IP address
      if (reqInfo.remoteAddress) {
        proxyHeaders['x-forwarded-for'] = reqInfo.remoteAddress;
      }

      const proxyReq = request({
        hostname: targetHost,
        port: targetPort,
        method: reqInfo.method,
        path: reqInfo.path,
        headers: proxyHeaders
      }, (proxyRes) => {
        // Filter hop-by-hop headers from target response before sending back to server
        const filteredHeaders = filterRequestHeaders(proxyRes.headers);

        // Send response headers back to server
        const canWrite = connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
          status: proxyRes.statusCode,
          headers: filteredHeaders
        })));

        // Set up backpressure handling
        if (!canWrite) {
          proxyRes.pause();
        }

        // Capture socket reference to ensure we remove listener from correct socket
        const connectionSocket = connection.socket;
        const onDrain = () => proxyRes.resume();
        connectionSocket.on('drain', onDrain);
        drainListeners.set(streamId, onDrain);

        // Stream response body (split large chunks into multiple frames)
        proxyRes.on('data', (chunk) => {
          let offset = 0;
          let canWrite = true;
          while (offset < chunk.length) {
            const end = Math.min(offset + MAX_FRAME_SIZE, chunk.length);
            const frameChunk = chunk.subarray(offset, end);
            canWrite = connection.write(encodeFrame(streamId, FrameType.DATA, frameChunk));
            offset = end;
          }
          if (!canWrite) {
            proxyRes.pause();
          }
        });

        proxyRes.on('end', () => {
          connectionSocket.removeListener('drain', onDrain);
          drainListeners.delete(streamId);
          connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
          activeStreams.delete(streamId);
        });

        proxyRes.on('error', (err) => {
          console.error(`[CLIENT ERROR] Target response error for ${reqInfo.method} ${reqInfo.path}:`, err.message, `(code: ${err.code || 'none'})`);
          connectionSocket.removeListener('drain', onDrain);
          drainListeners.delete(streamId);
          // Include error code in message for debugging
          const errorDetail = err.code ? `Target error: ${err.code}` : 'Target error';
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(errorDetail)));
          activeStreams.delete(streamId);
        });
      });

      activeStreams.set(streamId, proxyReq);

      // Handle errors
      proxyReq.on('error', (err) => {
        console.error(`[CLIENT ERROR] Target error for ${reqInfo.method} ${reqInfo.path}:`, err.message, `(code: ${err.code || 'none'})`);
        // Check if it's a connection refused error
        if (err.code === 'ECONNREFUSED') {
          connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
            status: 502,
            headers: { 'content-type': 'text/plain' }
          })));
          connection.write(encodeFrame(streamId, FrameType.DATA, Buffer.from('Target service not available')));
        } else {
          // Include error code in message for debugging (safe - no sensitive data)
          const errorDetail = err.code ? `Target error: ${err.code}` : 'Target error';
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(errorDetail)));
        }
        activeStreams.delete(streamId);
      });

      // Handle backpressure from target
      proxyReq.on('drain', () => {
        // Target is ready for more data - we rely on server to resume sending
      });

    } catch (err) {
      // Invalid HEADERS payload
      connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Invalid request')));
    }
  }

  /**
   * Parse WebSocket frame from raw bytes
   * @param {Buffer} buffer - Raw data
   * @param {boolean} boundariesOnly - If true, only return frame size/opcode without unmasking
   * @returns {Object|null} Parsed frame or null if incomplete
   */
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
    
    // Account for mask key length if present
    if (masked) {
      offset += 4;
    }
    
    // Check if we have full payload
    const frameSize = offset + payloadLen;
    if (buffer.length < frameSize) return null;
    
    const remaining = buffer.subarray(frameSize);
    
    if (boundariesOnly) {
      return { frameSize, opcode, remaining };
    }
    
    // Full parsing with unmasking
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

  /**
   * Build WebSocket frame
   */
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

  function destroy() {
    // Clean up all WebSocket connections
    for (const [streamId, wsState] of activeWebSockets) {
      wsState.cleanup();
    }
    activeWebSockets.clear();

    // Clean up all drain listeners from the socket
    const connectionSocket = connection.socket;
    for (const [streamId, onDrain] of drainListeners) {
      connectionSocket.removeListener('drain', onDrain);
    }
    drainListeners.clear();
    // Clean up all active streams
    for (const [streamId, proxyReq] of activeStreams) {
      proxyReq.destroy();
    }
    activeStreams.clear();
  }

  return {
    handleFrame,
    destroy
  };
}

module.exports = { createProxy };
