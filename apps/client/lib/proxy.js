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

/**
 * Filter hop-by-hop headers before forwarding to target
 * @param {Object} headers - Raw headers from tunnel
 * @returns {Object} Filtered headers safe to send to target
 */
function filterRequestHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function createProxy(connection, targetPort, targetHost = 'localhost') {
  const activeStreams = new Map(); // streamId -> proxyReq

  function handleFrame(frame) {
    // Handle PING (respond with PONG)
    if (frame.streamId === 0 && frame.type === FrameType.PING) {
      connection.write(encodeFrame(0, FrameType.PONG, Buffer.alloc(0)));
      return;
    }

    // Handle server frames
    if (frame.type === FrameType.HEADERS) {
      // New request from server
      startProxyRequest(frame.streamId, frame.payload);
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

        const onDrain = () => proxyRes.resume();
        connection.socket.on('drain', onDrain);

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
          connection.socket.removeListener('drain', onDrain);
          connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
          activeStreams.delete(streamId);
        });

        proxyRes.on('error', (err) => {
          connection.socket.removeListener('drain', onDrain);
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(err.message)));
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
          connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from(err.message)));
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

  function destroy() {
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
