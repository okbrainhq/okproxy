// Proxy - HTTP proxy to local target service

const { request } = require('node:http');
const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');

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

      // Rewrite headers to make request appear local
      const proxyHeaders = { ...reqInfo.headers };
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
        // Send response headers back to server
        const canWrite = connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
          status: proxyRes.statusCode,
          headers: proxyRes.headers
        })));

        // Set up backpressure handling
        if (!canWrite) {
          proxyRes.pause();
        }

        const onDrain = () => proxyRes.resume();
        connection.socket.on('drain', onDrain);

        // Stream response body
        proxyRes.on('data', (chunk) => {
          const canWriteChunk = connection.write(encodeFrame(streamId, FrameType.DATA, chunk));
          if (!canWriteChunk) {
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
