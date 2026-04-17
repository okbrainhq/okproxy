// Mock Target - Test HTTP server that can be configured for various test scenarios

const { createServer } = require('node:http');

function createMockTarget(options = {}) {
  let requestCount = 0;
  let sseClients = new Set();

  const server = createServer((req, res) => {
    requestCount++;
    const reqId = requestCount;
    
    // Strip query string for routing
    const urlPath = req.url.split('?')[0];

    // SSE endpoint
    if (urlPath === '/sse' || urlPath === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      sseClients.add(res);

      // Send initial event
      res.write('data: connected\n\n');

      req.on('close', () => {
        sseClients.delete(res);
      });

      return;
    }

    // Streaming endpoint
    if (urlPath === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      
      let count = 0;
      const interval = setInterval(() => {
        count++;
        res.write(`chunk ${count}\n`);
        if (count >= (options.streamChunks || 10)) {
          clearInterval(interval);
          res.end();
        }
      }, options.chunkDelay || 10);

      req.on('close', () => {
        clearInterval(interval);
      });

      return;
    }

    // Slow endpoint (for backpressure testing)
    if (urlPath === '/slow') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      
      let count = 0;
      const interval = setInterval(() => {
        count++;
        res.write(`data ${count}\n`);
        if (count >= (options.slowChunks || 100)) {
          clearInterval(interval);
          res.end();
        }
      }, options.slowDelay || 100);

      req.on('close', () => {
        clearInterval(interval);
      });

      return;
    }

    // Hang endpoint (for timeout testing)
    if (urlPath === '/hang') {
      // Never respond
      return;
    }

    // Header echo endpoint - echoes back headers (for testing hop-by-hop filtering)
    if (urlPath === '/header-echo') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=5',
        'Transfer-Encoding': 'chunked',
        'Upgrade': 'h2',
        'TE': 'trailers',
        'Trailer': 'X-Trailer-Test',
        'Proxy-Authenticate': 'Basic',
        'Proxy-Authorization': 'test',
        'X-Custom-Header': 'should-be-present'
      });
      res.end(JSON.stringify({
        receivedHeaders: req.headers,
        message: 'headers echoed'
      }));
      return;
    }

    // Echo endpoint - echoes back the request body
    if (urlPath === '/echo') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: body.toString('base64')
        }));
      });
      return;
    }

    // JSON response
    if (urlPath === '/json') {
      const headers = { 'Content-Type': 'application/json' };
      // Add CORS headers if configured (for testing CORS passthrough)
      if (options.corsHeaders) {
        Object.assign(headers, options.corsHeaders);
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        message: 'hello world',
        requestId: reqId,
        timestamp: Date.now()
      }));
      return;
    }

    // Large response
    if (urlPath === '/large') {
      const size = options.largeSize || 1024 * 1024; // 1MB default
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(size, 'x'));
      return;
    }

    // Error endpoint
    if (urlPath === '/error') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }

    // 404 for unknown paths
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Method to send SSE event to all connected clients
  server.sendSSE = (data) => {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(message);
    }
  };

  // Get request count
  server.getRequestCount = () => requestCount;

  return server;
}

module.exports = { createMockTarget };
