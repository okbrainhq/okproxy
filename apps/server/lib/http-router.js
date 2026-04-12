// HTTP Router - Routes public HTTP requests to the single tunnel client
// Note: This is a transparent proxy - it does NOT filter headers.
// Security should be handled at the application/target service layer.

const { createServer } = require('node:http');
const { encodeFrame, FrameType } = require('../../../packages/frame-protocol');

const STREAM_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB default

function createHTTPServer(clientManager, tcpServer, options = {}) {
  const streamTimeout = options.streamTimeout || STREAM_TIMEOUT;
  const maxStreams = options.maxConcurrentStreams || 100;
  const maxBodySize = options.maxBodySize || DEFAULT_MAX_BODY_SIZE;

  const server = createServer((req, res) => {
    // CORS headers to add to all responses
    // Note: Allow-Credentials is NOT set because we use '*' for origin
    // Setting both would be a security risk and is blocked by browsers
    function addCORSHeaders() {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    // Handle CORS preflight (OPTIONS) directly
    if (req.method === 'OPTIONS') {
      addCORSHeaders();
      res.statusCode = 204;
      res.end();
      return;
    }

    const client = clientManager.get();
    if (!client) {
      res.statusCode = 502;
      addCORSHeaders();
      res.end('Tunnel client not connected');
      return;
    }

    // Check max concurrent streams
    if (client.activeStreams && client.activeStreams.size >= maxStreams) {
      res.statusCode = 503;
      addCORSHeaders();
      res.end('Max concurrent streams exceeded');
      return;
    }

    const streamId = tcpServer.allocateStreamId();

    // Set up backpressure handling
    let paused = false;
    function onDrain() {
      paused = false;
      req.resume();
    }
    client.socket.on('drain', onDrain);

    // Send HEADERS frame (use full URL as path to target)
    // Pass headers through transparently - tunnel is not a firewall
    const canWriteHeaders = client.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
      method: req.method,
      path: req.url,
      headers: req.headers
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
          addCORSHeaders();
          res.end('Request body too large');
        }
        return;
      }
      const canWrite = client.write(encodeFrame(streamId, FrameType.DATA, chunk));
      if (!canWrite && !paused) {
        paused = true;
        req.pause();
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
      client.socket.removeListener('drain', onDrain);
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
            // Add CORS headers first
            addCORSHeaders();
            // Then add target service headers (pass through all headers)
            if (headers.headers) {
              Object.entries(headers.headers).forEach(([k, v]) => {
                res.setHeader(k, v);
              });
            }
            headersSent = true;
          } catch (err) {
            console.error('Invalid headers frame:', err.message);
            cleanup();
            res.statusCode = 502;
            addCORSHeaders();
            res.end('Invalid response');
          }
        } else if (frame.type === FrameType.DATA) {
          if (!headersSent) {
            // Auto-send 200 if headers not sent yet
            res.statusCode = 200;
            addCORSHeaders();
            headersSent = true;
          }
          res.write(frame.payload);
        } else if (frame.type === FrameType.FIN) {
          cleanup();
          if (!res.writableEnded) {
            res.end();
          }
        } else if (frame.type === FrameType.ERROR) {
          cleanup();
          if (!res.writableEnded) {
            res.statusCode = 502;
            addCORSHeaders();
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
          addCORSHeaders();
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

  return server;
}

module.exports = { createHTTPServer };
