// Mock Target - Test HTTP server that can be configured for various test scenarios

const { createServer } = require('node:http');
const crypto = require('node:crypto');

function createMockTarget(options = {}) {
  let requestCount = 0;
  let sseClients = new Set();
  let wsClients = new Map(); // Store WebSocket clients by path

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

  // Handle WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    const urlPath = req.url.split('?')[0];
    
    // Check for WebSocket upgrade
    const upgrade = req.headers.upgrade?.toLowerCase();
    const connection = req.headers.connection?.toLowerCase();
    
    if (upgrade !== 'websocket' || 
        !(connection === 'upgrade' || connection?.includes('upgrade'))) {
      socket.destroy();
      return;
    }
    
    // Get Sec-WebSocket-Key and generate accept hash
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    
    const acceptHash = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    
    // Send 101 response
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptHash}`,
      '',
      ''
    ].join('\r\n');
    
    socket.write(headers);
    
    // Store client
    const clientId = Math.random().toString(36).substring(7);
    wsClients.set(clientId, { socket, path: urlPath });
    
    // Handle WebSocket frames
    let buffer = Buffer.alloc(0);
    
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      
      // Parse WebSocket frames
      while (buffer.length >= 2) {
        const result = parseWebSocketFrame(buffer);
        if (!result) break;
        
        const { frame, remaining } = result;
        buffer = remaining;
        
        // Handle opcodes
        switch (frame.opcode) {
          case 0x01: // Text
          case 0x02: // Binary
            // Echo back the message (unmasked)
            const echoFrame = buildWebSocketFrame(frame.opcode, frame.payload);
            socket.write(echoFrame);
            break;
            
          case 0x08: // Close
            // Send close response
            const closeFrame = buildWebSocketFrame(0x08, frame.payload);
            socket.write(closeFrame);
            socket.end();
            wsClients.delete(clientId);
            break;
            
          case 0x09: // Ping
            // Respond with pong
            const pongFrame = buildWebSocketFrame(0x0a, frame.payload);
            socket.write(pongFrame);
            break;
            
          case 0x0a: // Pong
            // No action needed
            break;
        }
      }
    });
    
    socket.on('close', () => {
      wsClients.delete(clientId);
    });
    
    socket.on('error', () => {
      wsClients.delete(clientId);
    });
  });

  // Helper functions for WebSocket
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
    
    return {
      frame: { fin, opcode, payload },
      remaining
    };
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

  // Get request count
  server.getRequestCount = () => requestCount;

  return server;
}

module.exports = { createMockTarget };
