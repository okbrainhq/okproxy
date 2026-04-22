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

/**
 * Filter headers for WebSocket upgrade requests
 * For WebSocket, we need to preserve Upgrade and Connection headers
 * @param {Object} headers - Raw headers
 * @returns {Object} Filtered headers for WebSocket upgrade
 */
function filterWebSocketHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    // For WebSocket, preserve upgrade/connection headers
    // Strip X-Forwarded headers only
    if (!X_FORWARDED_HEADERS.has(lowerKey)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

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
      // Forward WebSocket frame to target
      // frame.payload contains the raw WebSocket frame
      const canWrite = wsState.socket.write(frame.payload);
      if (!canWrite) {
        // Backpressure
        wsState.socket.pause();
        connection.socket.once('drain', () => {
          wsState.socket.resume();
        });
      }
    } else if (frame.type === FrameType.FIN) {
      // Server signaled end - close WebSocket
      wsState.cleanup();
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

      let cleanupCalled = false;

      function cleanup() {
        if (cleanupCalled) return;
        cleanupCalled = true;
        
        activeWebSockets.delete(streamId);
        
        if (wsState.socket && !wsState.socket.destroyed) {
          wsState.socket.destroy();
        }
        
        // Signal to server that stream is done
        connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
      }

      const wsState = {
        socket: null,
        cleanup
      };

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

        // Forward any other relevant headers
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!responseHeaders[key]) {
            responseHeaders[key] = value;
          }
        }

        connection.write(encodeFrame(streamId, FrameType.UPGRADE, JSON.stringify({
          status: 101,
          headers: responseHeaders
        })));

        // Handle data from target
        let buffer = Buffer.alloc(0);
        
        proxySocket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          
          // Parse complete WebSocket frames and forward
          while (buffer.length >= 2) {
            const frameInfo = parseWebSocketFrame(buffer);
            if (!frameInfo) break;
            
            const { fin, opcode, payload, remaining } = frameInfo;
            buffer = remaining;
            
            // Build WebSocket frame and wrap in DATA frame
            const wsFrame = buildWebSocketFrame(opcode, payload);
            const canWrite = connection.write(encodeFrame(streamId, FrameType.DATA, wsFrame));
            
            if (!canWrite) {
              proxySocket.pause();
              connection.socket.once('drain', () => {
                proxySocket.resume();
              });
            }
            
            // Handle close from target
            if (opcode === 0x08) {
              cleanup();
              return;
            }
          }
        });

        proxySocket.on('close', () => {
          if (!cleanupCalled) {
            cleanup();
          }
        });

        proxySocket.on('error', (err) => {
          console.error('WebSocket target error:', err.message);
          cleanup();
        });
      });

      proxyReq.on('error', (err) => {
        console.error('WebSocket upgrade request error:', err.message);
        connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Upgrade failed')));
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
          connectionSocket.removeListener('drain', onDrain);
          drainListeners.delete(streamId);
          // Use generic error message to avoid leaking internal details to server
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Target error')));
          activeStreams.delete(streamId);
        });
      });

      activeStreams.set(streamId, proxyReq);

      // Handle errors
      proxyReq.on('error', (err) => {
        // Check if it's a connection refused error
        if (err.code === 'ECONNREFUSED') {
          connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
            status: 502,
            headers: { 'content-type': 'text/plain' }
          })));
          connection.write(encodeFrame(streamId, FrameType.DATA, Buffer.from('Target service not available')));
        } else {
          // Use generic error message to avoid leaking internal details to server
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Target error')));
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
   */
  function parseWebSocketFrame(buffer) {
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
    
    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    
    if (buffer.length < offset + payloadLen) return null;
    
    const payload = buffer.subarray(offset, offset + payloadLen);
    
    if (masked && maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    
    const remaining = buffer.subarray(offset + payloadLen);
    
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
