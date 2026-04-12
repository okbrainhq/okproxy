# Design: Simple TCP Tunnel (No Auth, No TLS)

## Overview

The simplest possible ngrok alternative: raw TCP connection with a custom framing protocol. **No TLS, no authentication** - just the core tunneling logic. This proves the framing protocol works before adding security layers.

## Architecture

```
HTTP Client                    Tunnel Server                  Tunnel Client                  Target Service
     │                              │                              │                              │
     │  GET /api/users              │                              │                              │
     ├─────────────────────────────►│                              │                              │
     │                              │  (assign streamId: 1)        │                              │
     │                              │  ┌─[Stream 1]────────────┐    │                              │
     │                              │  │ HEADERS frame         │────►│  GET localhost:3000/api/users│
     │                              │  │ {method, path, hdrs}  │    ├─────────────────────────────►│
     │                              │  └───────────────────────┘    │                              │
     │                              │                               │         {json response}      │
     │                              │  ◄──DATA frame (chunk 1)───────┤◄─────────────────────────────┤
     │  {chunk 1}                   │  │                          │    │                         │
     │◄─────────────────────────────┤  │                          │    │                         │
     │  {chunk 2}                   │  ◄──DATA frame (chunk 2)───────┤    │                         │
     │◄─────────────────────────────┤  │                          │    │                         │
     │                              │  ◄──FIN frame────────────────┤    │                         │
     │  (response complete)         │  │                          │    │                         │
     │◄─────────────────────────────┤  │                          │    │                         │
     │                              │  └─Stream 1 closed───────────┘    │                         │
     │                              │                               │                              │
     │                              │  (concurrent streams possible)    │                              │
     │                              │  ┌─[Stream 2]────────────┐    │                              │
```

## Framing Protocol

### Frame Format (9 bytes header + payload)

```
┌─────────────────┬───────────┬─────────────────┬──────────────────┐
│  Stream ID      │  Type     │  Length         │  Payload         │
│  (4 bytes)      │  (1 byte) │  (4 bytes)      │  (N bytes)       │
│  UInt32 BE      │  UInt8    │  UInt32 BE      │  Raw bytes       │
└─────────────────┴───────────┴─────────────────┴──────────────────┘
```

**Frame Types:**
| Type | Value | Description |
|------|-------|-------------|
| HEADERS | `0x01` | HTTP request/response metadata (JSON) |
| DATA | `0x02` | Body chunk (raw bytes) |
| FIN | `0x03` | Stream complete (directional half-close) |
| ERROR | `0x04` | Stream error |
| INIT | `0x05` | Connection handshake (version, settings) |
| PING | `0x06` | Keepalive ping (no payload) |
| PONG | `0x07` | Keepalive response (no payload) |

### Protocol Flow

```
1. Client connects to Server via plain TCP socket
2. Server accepts, assigns internal client ID
3. HTTP request arrives at Server
4. Server assigns streamId, sends HEADERS + DATA frames
5. Client receives, makes request to localhost
6. Client sends response: HEADERS + DATA + FIN frames
7. Server forwards to HTTP client
8. Multiple requests can be in-flight (multiplexed)
```

### Connection Lifecycle

#### INIT Handshake

On connect, client sends an INIT frame before any streams:

```
Client → Server:  INIT (streamId=0, payload={version: 1, maxFrameSize: 1048576})
Server → Client:  INIT (streamId=0, payload={version: 1, maxFrameSize: 1048576})
```

- `streamId` is 0 for INIT frames (not associated with any stream).
- If the server does not support the client's version, it sends ERROR (streamId=0) and closes the connection.
- Both sides use the lower of the two `maxFrameSize` values.
- No streams may be opened until INIT handshake completes.

#### PING/PONG Keepalive

- Server sends PING (streamId=0, no payload) every 30 seconds of inactivity.
- Client must respond with PONG within 10 seconds.
- If no PONG received, server destroys the connection and cleans up all streams (502 to any in-flight HTTP requests).
- Client may also send PING to detect dead server connections.

#### Stream Inactivity Timeout

- Each stream has a 30-second idle timeout (configurable).
- If no DATA or FIN frame is received for a stream within the timeout, the side that detects it sends ERROR and closes the stream.
- HTTP clients waiting on a timed-out stream receive a 504 Gateway Timeout.

#### Stream ID Wrapping

- Stream IDs are UInt32 (0 to 4,294,967,295). IDs 1-2147483647 are server-initiated, IDs 2147483648-4294967295 are client-initiated (reserved for future use).
- When the server's `nextStreamId` approaches the max, it sends ERROR (streamId=0) with reason "stream ID exhaustion" and closes the connection. Client reconnects automatically.

### HEADERS Payload (JSON)

**Request:**
```json
{
  "method": "POST",
  "path": "/api/users",
  "headers": {
    "content-type": "application/json",
    "x-request-id": "abc-123"
  }
}
```

**Response:**
```json
{
  "status": 200,
  "headers": {
    "content-type": "application/json"
  }
}
```

### FIN Semantics (Half-Close)

FIN is **directional** — each direction of a stream is closed independently:

- **Server → Client FIN**: Means "request body is complete" (client can call `proxyReq.end()`).
- **Client → Server FIN**: Means "response body is complete" (server can call `res.end()`).
- A stream is fully closed only when **both sides** have sent FIN (or either side sends ERROR).

This allows long-running streams (e.g., SSE) where the server sends data for minutes after the client has finished sending its request body.

### Limits & Safety

#### MAX_FRAME_SIZE

- **Default: 1MB (1,048,576 bytes).**
- Frame decoder checks `length` field before allocating memory. If `length > MAX_FRAME_SIZE`, the connection is destroyed immediately.
- Negotiated via INIT handshake (both sides use the lower value).

#### Backpressure

When `socket.write()` returns `false`, the sending side must pause its source:

```javascript
// Server side: HTTP request → tunnel
function setupBackpressure(req, client, streamId) {
  const onDrain = () => req.resume();
  client.socket.on('drain', onDrain);
  
  req.on('data', (chunk) => {
    const canWrite = client.write(encodeFrame(streamId, 0x02, chunk));
    if (!canWrite) req.pause();
  });
  
  // Remove drain listener when stream closes
  return () => client.socket.removeListener('drain', onDrain);
}

// Client side: proxy response → tunnel
function setupClientBackpressure(proxyRes, socket) {
  const onDrain = () => proxyRes.resume();
  socket.on('drain', onDrain);
  
  proxyRes.on('data', (chunk) => {
    const canWrite = socket.write(encodeFrame(streamId, 0x02, chunk));
    if (!canWrite) proxyRes.pause();
  });
  
  // Remove drain listener when stream closes
  return () => socket.removeListener('drain', onDrain);
}
```

Drain listeners must be removed when the stream closes to prevent leaks. The cleanup function should be called on FIN, ERROR, or timeout.

#### Max Concurrent Streams

- **Default: 100 streams per client.**
- If a new stream would exceed the limit, the server sends ERROR on that streamId and does not process the request.
- Configurable via INIT handshake in future versions.

### Why No Auth/TLS in Phase 1?

1. **Prove the protocol works first** - Get framing, multiplexing, streaming working
2. **Simpler debugging** - No cert issues, no handshake failures
3. **Local development** - Can test locally without cert setup
4. **Clear separation** - Phase 2 adds TLS+mTLS as a security layer, not mixed with protocol logic

## Components

### 1. Server (`/apps/server/`)

**Files:**
- `index.js` - Entry point, CLI args parsing
- `lib/tcp-server.js` - Plain TCP socket server (`node:net`)
- `lib/http-router.js` - HTTP server, routes to tunnel clients
- `lib/client-manager.js` - Track connected clients by ID

Imports frame-protocol from `../../packages/frame-protocol/index.js` (shared package).

**Frame Decoder:**
```javascript
const MAX_FRAME_SIZE = 1048576; // 1MB

function createFrameDecoder(onFrame, onError) {
  let chunks = [];
  let totalLength = 0;
  
  return (chunk) => {
    chunks.push(chunk);
    totalLength += chunk.length;
    
    while (totalLength >= 9) {
      if (chunks.length > 1) {
        chunks = [Buffer.concat(chunks)];
      }
      
      const streamId = chunks[0].readUInt32BE(0);
      const type = chunks[0].readUInt8(4);
      const length = chunks[0].readUInt32BE(5);
      
      if (length > MAX_FRAME_SIZE) {
        onError(new Error(`Frame too large: ${length} bytes`));
        chunks = [];
        totalLength = 0;
        return;
      }
      
      if (totalLength < 9 + length) return;
      
      // Compact: merge chunks and extract payload
      const combined = chunks.length > 1 ? Buffer.concat(chunks) : chunks[0];
      const payload = combined.subarray(9, 9 + length);
      const remaining = combined.subarray(9 + length);
      
      chunks = remaining.length > 0 ? [remaining] : [];
      totalLength = remaining.length;
      
      onFrame({ streamId, type, payload });
    }
  };
}
```

Uses a chunk list instead of `Buffer.concat` on every data event to reduce GC pressure. Buffers are only concatenated when needed for reading the header or extracting a payload.

**Frame Encoder:**
```javascript
function encodeFrame(streamId, type, payload) {
  if (typeof payload === 'string') payload = Buffer.from(payload);
  const header = Buffer.alloc(9);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}
```

**Server Logic:**
```javascript
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

function extractClientIdAndPath(url) {
  const urlParts = url.split('/').filter(Boolean);
  return {
    clientId: urlParts[0] || null,
    path: '/' + urlParts.slice(1).join('/')
  };
}

// TCP server for tunnel clients
const tcpServer = createServer((socket) => {
  let initialized = false;
  let clientId = null;
  
  const decoder = createFrameDecoder(
    (frame) => {
      if (!initialized) {
        if (frame.type !== 0x05) {
          socket.destroy();
          return;
        }
        const settings = JSON.parse(frame.payload.toString());
        clientId = settings.clientId; // Self-reported in Phase 1
        socket.write(encodeFrame(0, 0x05, JSON.stringify({
          version: 1,
          maxFrameSize: 1048576
        })));
        clientManager.add(clientId, {
          socket,
          write: (data) => socket.write(data),
          registerStream: (streamId, handler) => { /* ... */ },
          unregisterStream: (streamId) => { /* ... */ },
          activeStreams: new Map()
        });
        initialized = true;
        console.log('Client initialized:', clientId);
        return;
      }
      handleFrameFromClient(clientId, frame);
    },
    (err) => {
      console.error('Protocol error:', err.message);
      socket.destroy();
    }
  );
  
  socket.on('data', decoder);
  socket.on('close', () => {
    if (clientId) clientManager.remove(clientId);
  });
  socket.on('error', (err) => console.error('Socket error:', err));
  
  socket.setTimeout(10000, () => {
    if (!initialized) socket.destroy();
  });
});

// HTTP server for public requests
const httpServer = createHttpServer((req, res) => {
  const { clientId, path: actualPath } = extractClientIdAndPath(req.url);
  const client = clientManager.get(clientId);
  
  if (!clientId || !client) {
    res.statusCode = 502;
    res.end(clientId ? 'Client not connected' : 'Invalid URL');
    return;
  }
  
  const streamId = nextStreamId++;
  
  client.write(encodeFrame(streamId, 0x01, JSON.stringify({
    method: req.method,
    path: actualPath,
    headers: req.headers
  })));
  
  req.on('data', (chunk) => {
    const canWrite = client.write(encodeFrame(streamId, 0x02, chunk));
    if (!canWrite) req.pause();
  });
  
  req.on('end', () => {
    client.write(encodeFrame(streamId, 0x03, Buffer.alloc(0)));
  });
  
  function onDrain() {
    req.resume();
  }
  client.socket.on('drain', onDrain);
  
  let streamTimeout = setTimeout(() => {
    client.write(encodeFrame(streamId, 0x04, Buffer.from('Stream timeout')));
    client.unregisterStream(streamId);
    client.socket.removeListener('drain', onDrain);
    if (!res.writableEnded) {
      res.statusCode = 504;
      res.end('Gateway timeout');
    }
  }, 30000);
  
  function resetStreamTimeout() {
    clearTimeout(streamTimeout);
    streamTimeout = setTimeout(() => {
      client.write(encodeFrame(streamId, 0x04, Buffer.from('Stream timeout')));
      client.unregisterStream(streamId);
      client.socket.removeListener('drain', onDrain);
      if (!res.writableEnded) {
        res.statusCode = 504;
        res.end('Gateway timeout');
      }
    }, 30000);
  }
  
  client.registerStream(streamId, (frame) => {
    resetStreamTimeout();
    if (frame.type === 0x01) {
      const headers = JSON.parse(frame.payload.toString());
      res.statusCode = headers.status;
      Object.entries(headers.headers).forEach(([k, v]) => res.setHeader(k, v));
    } else if (frame.type === 0x02) {
      res.write(frame.payload);
    } else if (frame.type === 0x03) {
      clearTimeout(streamTimeout);
      client.socket.removeListener('drain', onDrain);
      res.end();
      client.unregisterStream(streamId);
    } else if (frame.type === 0x04) {
      clearTimeout(streamTimeout);
      client.socket.removeListener('drain', onDrain);
      res.statusCode = 502;
      res.end('Tunnel error');
      client.unregisterStream(streamId);
    }
  });
});
```

### 2. Client (`/apps/client/`)

**Files:**
- `index.js` - Entry point, CLI args parsing
- `lib/connection.js` - TCP connection, reconnection logic
- `lib/proxy.js` - HTTP client to local target

Imports frame-protocol from `../../packages/frame-protocol/index.js` (shared package).

**Client Logic:**
```javascript
import { connect } from 'node:net';
import { request } from 'node:http';

const socket = connect({ host: serverHost, port: serverPort });

let initialized = false;
const decoder = createFrameDecoder(
  (frame) => {
    if (!initialized) {
      if (frame.type !== 0x05) {
        socket.destroy();
        return;
      }
      handleInitResponse(frame);
      initialized = true;
      return;
    }
    handleFrame(frame);
  },
  (err) => {
    console.error('Protocol error:', err.message);
    socket.destroy();
  }
);

socket.on('data', decoder);
socket.on('error', (err) => {
  console.error('Connection error:', err);
  scheduleReconnect();
});
socket.on('close', () => {
  console.log('Connection closed');
  scheduleReconnect();
});

// Send INIT handshake
socket.write(encodeFrame(0, 0x05, JSON.stringify({
  version: 1,
  maxFrameSize: 1048576
})));

function handleFrame(frame) {
  if (frame.type === 0x06) { // PING
    socket.write(encodeFrame(0, 0x07, Buffer.alloc(0)));
    return;
  }
  
  if (frame.type === 0x01) { // HEADERS - new request
    const reqInfo = JSON.parse(frame.payload.toString());
    startProxyRequest(frame.streamId, reqInfo);
  } else if (frame.type === 0x02) { // DATA - body chunk, stream directly
    const proxyReq = activeStreams.get(frame.streamId);
    if (proxyReq && !proxyReq.writableEnded) {
      const canWrite = proxyReq.write(frame.payload);
      if (!canWrite) {
        // Backpressure: tell server to pause (could use a PAUSE frame in future)
        // For now, Node.js buffers internally but we log a warning
      }
    }
  } else if (frame.type === 0x03) { // FIN - request body complete
    const proxyReq = activeStreams.get(frame.streamId);
    if (proxyReq && !proxyReq.writableEnded) proxyReq.end();
  } else if (frame.type === 0x04) { // ERROR
    const proxyReq = activeStreams.get(frame.streamId);
    if (proxyReq) {
      proxyReq.destroy();
      activeStreams.delete(frame.streamId);
    }
  }
}

function startProxyRequest(streamId, reqInfo) {
  const proxyHeaders = { ...reqInfo.headers };
  proxyHeaders.host = `localhost:${targetPort}`;
  
  const proxyReq = request({
    hostname: 'localhost',
    port: targetPort,
    method: reqInfo.method,
    path: reqInfo.path,
    headers: proxyHeaders
  }, (proxyRes) => {
    socket.write(encodeFrame(streamId, 0x01, JSON.stringify({
      status: proxyRes.statusCode,
      headers: proxyRes.headers
    })));
    
    const onDrain = () => proxyRes.resume();
    socket.on('drain', onDrain);
    
    proxyRes.on('data', (chunk) => {
      const canWrite = socket.write(encodeFrame(streamId, 0x02, chunk));
      if (!canWrite) proxyRes.pause();
    });
    
    proxyRes.on('end', () => {
      socket.removeListener('drain', onDrain);
      socket.write(encodeFrame(streamId, 0x03, Buffer.alloc(0)));
      activeStreams.delete(streamId);
    });
    
    proxyRes.on('error', (err) => {
      socket.removeListener('drain', onDrain);
      socket.write(encodeFrame(streamId, 0x04, Buffer.from(err.message)));
      activeStreams.delete(streamId);
    });
  });
  
  activeStreams.set(streamId, proxyReq);
  
  proxyReq.on('error', (err) => {
    socket.write(encodeFrame(streamId, 0x04, Buffer.from(err.message)));
    activeStreams.delete(streamId);
  });
}
```

## HTTP Streaming & SSE Support

The framing protocol naturally supports streaming without any special handling:

### Regular Response
```
Server → Client: HEADERS (status: 200)
Server → Client: DATA (chunk 1)
Server → Client: DATA (chunk 2)
Server → Client: DATA (chunk 3)
Server → Client: FIN
```

### SSE (Server-Sent Events)
```
Server → Client: HEADERS (status: 200, content-type: text/event-stream)
Server → Client: DATA ("data: event1\n\n")
Server → Client: DATA ("data: event2\n\n")
Server → Client: DATA ("data: event3\n\n")
... (continues for minutes/hours)
Server → Client: FIN (when stream ends)
```

Each SSE event is just a DATA frame. The server immediately forwards it to the HTTP client.

## Reconnection Logic

Client should automatically reconnect with exponential backoff:

```javascript
let reconnectDelay = 1000;
const maxReconnectDelay = 30000;

function scheduleReconnect() {
  setTimeout(() => {
    const newSocket = connectToServer();
    
    newSocket.on('connect', () => {
      reconnectDelay = 1000;
    });
    
    newSocket.on('error', () => {
      reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
      scheduleReconnect();
    });
  }, reconnectDelay);
}

function connectToServer() {
  const socket = connect({ host: serverHost, port: serverPort });
  // ... set up decoder, INIT handshake, etc.
  return socket;
}
```

## End-to-End Tests

**Location:** `/tests/e2e/simple-tcp/`

### Test 1: Frame Protocol Unit Tests
```javascript
// Test encodeFrame produces correct buffer
// Test decoder handles single complete frame
// Test decoder handles multiple frames in one chunk
// Test decoder handles partial frame (waits for rest)
// Test decoder handles split across multiple chunks
// Test empty payload
// Test maximum payload size accepted
// Test oversized frame triggers onError and stops decoding
```

### Test 2: INIT Handshake
```javascript
// Start server on :8080 (HTTP) and :9000 (TCP)
// Client connects and sends INIT frame
// Assert: Server responds with INIT ACK
// Assert: No streams can be opened before INIT completes
// Assert: Client sending HEADERS before INIT gets disconnected
```

### Test 3: Connection
```javascript
// Start mock target on :9001
// Start server on :8080 (HTTP) and :9000 (TCP)
// Start client connecting to :9000
// Assert: Server shows client connected
// Assert: INIT handshake completed
```

### Test 4: Simple HTTP GET
```javascript
// Setup server + client + mock target
// Mock returns {"hello": "world"}
// Make HTTP GET to server
// Assert: Response is {"hello": "world"}
```

### Test 5: Simple HTTP POST
```javascript
// Setup server + client + mock target
// Mock echoes body
// Make HTTP POST with JSON body
// Assert: Echoed body received
```

### Test 6: Concurrent Requests
```javascript
// Setup server + client
// Send 5 parallel requests
// Assert: All 5 complete successfully
// Assert: Each has unique streamId
```

### Test 7: Streaming Response
```javascript
// Setup server + client
// Mock streams 1000 chunks with 10ms delay each
// Make HTTP request
// Assert: Chunks arrive progressively (not buffered)
```

### Test 8: SSE Support
```javascript
// Setup server + client
// Mock is SSE endpoint sending 10 events
// Connect with EventSource to server
// Assert: All 10 events received
// Assert: Connection stays open until FIN
```

### Test 9: Large Body
```javascript
// Setup server + client
// Mock accepts large POST
// Send 10MB body
// Assert: Complete body reaches mock
// Assert: Response received
```

### Test 10: Client Disconnection
```javascript
// Setup server + client
// Kill client mid-request
// Assert: Server returns 502
// Assert: Server cleans up stream
```

### Test 11: Client Reconnection
```javascript
// Setup server + client
// Kill client
// Assert: Client reconnects automatically
// Assert: INIT handshake happens again
// Assert: New requests work after reconnection
```

### Test 12: Malformed Frames
```javascript
// Send frame with bad JSON in HEADERS payload
// Assert: Server sends ERROR on that streamId, connection stays alive
// Send frame with unknown type (0xFF)
// Assert: Server sends ERROR on that streamId, connection stays alive
// Send frame for nonexistent streamId
// Assert: Server sends ERROR back, connection stays alive
```

### Test 13: Oversized Frame Rejection
```javascript
// Send frame with length field > MAX_FRAME_SIZE
// Assert: Connection destroyed immediately
// Assert: No memory allocated for the payload
```

### Test 14: PING/PONG Timeout
```javascript
// Setup server + client
// Client stops responding to PING frames
// Assert: Server detects dead client within keepalive timeout
// Assert: Server cleans up all streams
// Assert: In-flight HTTP requests get 502
```

### Test 15: Backpressure Under Slow Target
```javascript
// Setup server + client
// Mock target processes chunks slowly (100ms delay each)
// Send large streaming request
// Assert: No unbounded memory growth on server or client
// Assert: Chunks flow at target's pace
// Assert: All chunks eventually delivered
```

### Test 16: Max Concurrent Streams
```javascript
// Setup server + client
// Set max concurrent streams to 5
// Send 6 parallel requests
// Assert: First 5 complete successfully
// Assert: 6th gets ERROR frame
```

### Test 17: Stream Inactivity Timeout
```javascript
// Setup server + client
// Mock target that hangs (never responds)
// Assert: Server sends ERROR after 30s idle timeout
// Assert: HTTP client receives 504 Gateway Timeout
```

## Directory Structure

```
/packages/
  /frame-protocol/
    index.js           # Shared encoder/decoder (used by both server and client)
    package.json
/apps/
  /server/
    index.js
    lib/
      tcp-server.js      # Plain TCP, no TLS
      http-router.js     # HTTP → TCP routing (path-based)
      client-manager.js  # Track clients
      keepalive.js       # PING/PONG + stream timeout logic
    package.json
  /client/
    index.js
    lib/
      connection.js      # TCP connection + reconnect
      proxy.js           # HTTP to localhost (streaming, no buffering)
    package.json
/tests/
  /e2e/
    /simple-tcp/
      test-frames.js
      test-init.js
      test-connection.js
      test-http-get.js
      test-http-post.js
      test-concurrent.js
      test-streaming.js
      test-sse.js
      test-large-body.js
      test-disconnect.js
      test-reconnect.js
      test-malformed.js
      test-oversized-frame.js
      test-ping-pong.js
      test-backpressure.js
      test-max-streams.js
      test-stream-timeout.js
      run.js             # Test runner
      setup.js           # Shared test setup
      mock-target.js     # Test HTTP target
/package.json
```

## Technology Stack (Zero Dependencies)

- `node:net` - TCP sockets
- `node:http` - HTTP server and client
- `node:stream` - Streaming utilities
- `node:test` + `node:assert` - Testing

## Running

```bash
# Terminal 1: Start server
node apps/server/index.js --http-port 8080 --tcp-port 9000

# Terminal 2: Start target service
python -m http.server 3000

# Terminal 3: Start client
node apps/client/index.js --server localhost:9000 --target localhost:3000 --id myapp

# Terminal 4: Test
# curl http://localhost:8080/myapp/path
```

## Verification Checklist

- [ ] Frame encoding/decoding correct
- [ ] Partial TCP chunk handling works
- [ ] Oversized frame rejected (connection destroyed)
- [ ] INIT handshake completes before streams
- [ ] Client disconnected if no INIT sent first
- [ ] Server accepts TCP connections
- [ ] Client connects to server
- [ ] Path-based routing works (/:clientId/*)
- [ ] Host header rewritten to localhost:<targetPort> when proxying
- [ ] HTTP GET works
- [ ] HTTP POST works (streaming, no buffering)
- [ ] Headers pass through correctly
- [ ] Concurrent requests work (multiplexed)
- [ ] Max concurrent streams enforced
- [ ] Streaming responses work
- [ ] SSE works
- [ ] Large bodies work (streaming)
- [ ] Backpressure applied under slow target
- [ ] PING/PONG keepalive works
- [ ] Dead client detected via PING timeout
- [ ] Stream inactivity timeout triggers 504
- [ ] Client reconnects automatically (with INIT)
- [ ] Malformed frames handled gracefully
- [ ] FIN half-close semantics correct
- [ ] All e2e tests pass

