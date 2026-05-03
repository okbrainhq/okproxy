# Design: WebSocket Support for Next.js Hot Code Reload

## Overview

Add WebSocket support to okproxy to enable Next.js hot code reload (HMR). This is a minimal implementation - no third-party libraries, just enough to handle the WebSocket handshake and frame relay for HMR use cases.

**Scope:** Support WebSocket upgrade, basic frame parsing/relaying, and clean termination. Not aiming for full WebSocket spec compliance - just "good enough" for Next.js and similar development tools.

## Architecture

### Data Flow

```
Browser (ws://localhost:8080)          HTTP Server              TLS Tunnel              Target (Next.js)
        │                                    │                       │                       │
        │  1. GET /_next/webpack-hmr         │                       │                       │
        │     Upgrade: websocket             │                       │                       │
        │     Connection: Upgrade            │                       │                       │
        │     Sec-WebSocket-Key: xxx         │                       │                       │
        ├────────────────────────────────────►│                       │                       │
        │                                    │  2. UPGRADE frame     │                       │
        │                                    │     (forward headers  │                       │
        │                                    │      with Key)        │                       │
        │                                    ├──────────────────────►│                       │
        │                                    │                       │  3. Upgrade req       │
        │                                    │                       │     (same Key)        │
        │                                    │                       ├──────────────────────►│
        │                                    │                       │  4. 101 + Accept     │
        │                                    │                       │◄──────────────────────┤
        │                                    │  5. UPGRADE frame     │                       │
        │                                    │     (forward Accept)  │                       │
        │  6. 101 Switching Protocols        │◄──────────────────────┤                       │
        │◄────────────────────────────────────┤                       │                       │
        │                                    │                       │                       │
        │  7. WebSocket frames               │                       │                       │
        │     (bidirectional)                │                       │                       │
        │◄═══════════════════════════════════►◄═══════════════════════►◄═════════════════════►│
        │                                    │                       │                       │
        │  8. Close frame or disconnect      │                       │                       │
        ├────────────────────────────────────►──────────────────────►─────────────────────►│
```

### Key Differences from HTTP

| Aspect | HTTP Request | WebSocket |
|--------|-------------|-----------|
| Lifecycle | Request → Response (finite) | Upgrade → bidirectional streaming (indefinite) |
| Data format | HEADERS + DATA frames | Raw WebSocket frames after 101 response |
| Termination | FIN frame or ERROR | Close frame or connection drop |
| Headers | Full HTTP headers | Minimal WebSocket frame headers |
| Direction | Client→Server request, Server→Client response | Fully bidirectional |

## Framing Protocol Changes

### New Frame Type: UPGRADE (0x08)

```
┌─────────────────┬───────────┬─────────────────┬──────────────────┐
│  Stream ID      │  Type     │  Length         │  Payload         │
│  (4 bytes)      │  0x08     │  (4 bytes)      │  JSON metadata   │
└─────────────────┴───────────┴─────────────────┴──────────────────┘
```

The UPGRADE frame signals that a stream is switching protocols:

**Server → Client (Forward Request):**
```json
{
  "protocol": "websocket",
  "method": "GET",
  "path": "/_next/webpack-hmr",
  "headers": {
    "upgrade": "websocket",
    "connection": "upgrade",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13"
  }
}
```

**Client → Server (Target Response):**
```json
{
  "status": 101,
  "headers": {
    "upgrade": "websocket",
    "connection": "upgrade",
    "sec-websocket-accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  }
}
```

**Payload Semantics:**
- `protocol`: The protocol being upgraded to (always "websocket" for now)
- `method`: HTTP method (always "GET" for WebSocket)
- `path`: Request path (needed for client to make request to target)
- `headers`: Request/response headers including original `Sec-WebSocket-Key`

### Modified Stream Handling

After an UPGRADE frame is sent on a stream:

1. **No more HEADERS frames** on this stream - data is raw WebSocket frames
2. **DATA frames contain raw WebSocket frames** (both directions)
3. **FIN frame means WebSocket close** (not HTTP response complete)
4. **Stream stays open** until close frame received or connection drops
5. **Stream timeout is disabled** - WebSocket streams are long-lived (entire HMR session)

### WebSocket Stream Timeout Behavior

HTTP streams use a 30-second inactivity timeout to prevent hanging connections. WebSocket streams must disable this:

```javascript
// In http-router.js: Disable timeout for WebSocket streams
if (streamState.mode === WS_MODE) {
  // Don't set streamTimer for WebSocket streams
  // They stay open until close frame or connection drop
} else {
  // Normal HTTP stream timeout
  streamTimer = setTimeout(() => { ... }, streamTimeout);
}
```

**Connection health detection alternatives:**
- WebSocket ping/pong frames (opcode 9/10) - application-level
- TLS keepalive (already implemented) - transport-level
- TCP keepalive - low-level

### Close Semantics State Machine

WebSocket close involves both WebSocket-level close frames (opcode 8) and tunnel-level FIN frames:

```
Close Scenarios:

1. Browser initiates close:
   ┌─────────┐         ┌─────────┐         ┌─────────┐         ┌─────────┐
   │ Browser │────────►│  Server │────────►│  Client │────────►│  Target │
   │         │ close(8)│         │ DATA(8) │         │  close  │         │
   └─────────┘         └─────────┘         └─────────┘         └─────────┘
                                                            │
                                                            ▼
   ┌─────────┐         ┌─────────┐         ┌─────────┐   ┌─────────┐
   │ Browser │◄────────│  Server │◄────────│  Client │◄──│  Target │
   │  (done) │  FIN    │         │  FIN    │         │   │ (done)  │
   └─────────┘         └─────────┘         └─────────┘   └─────────┘

2. Target initiates close:
   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │  Target │──►│  Client │──►│  Server │──►│  Browser│──►│  Server │
   │  close  │   │         │DATA(8)│         │  close(8)│   │   FIN   │
   └─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
                                    │                           │
                                    ▼                           ▼
                               ┌─────────┐                 ┌─────────┐
                               │  Client │◄────────────────│  Client │
                               │  (done) │       FIN       │  (done) │
                               └─────────┘                 └─────────┘

3. Connection drop:
   ┌─────────┐              ┌─────────┐              ┌─────────┐
   │  Drop   │─────────────►│  Server │─────────────►│  Client │
   │         │  (detected)  │   FIN   │              │  close  │
   └─────────┘              └─────────┘              └─────────┘
        │
        ▼
   ┌─────────┐
   │ Browser │
   │ (error) │
   └─────────┘
```

**Close Rules:**
- WebSocket close frame (opcode 8) is forwarded as a DATA frame with the close payload
- FIN frame from either side signals complete stream termination
- Connection drop (TCP close) also triggers cleanup
- Both directions must be closed for stream to be fully terminated

## WebSocket Protocol Implementation

### Server-Side WebSocket Handling (HTTP Router)

```javascript
// Detect WebSocket upgrade request
function isWebSocketUpgrade(req) {
  const upgrade = req.headers.upgrade?.toLowerCase();
  const connection = req.headers.connection?.toLowerCase();
  return upgrade === 'websocket' && 
         (connection === 'upgrade' || connection.includes('upgrade'));
}
```

**Upgrade Flow:**

1. Browser sends upgrade request with `Sec-WebSocket-Key`
2. Server detects upgrade
3. Server sends UPGRADE frame to tunnel client with original headers (including `Sec-WebSocket-Key`)
4. Client makes upgrade request to target with original `Sec-WebSocket-Key`
5. Target responds with 101 and its own `Sec-WebSocket-Accept`
6. Client sends target's response (status + headers) back via UPGRADE or HEADERS frame
7. Server forwards target's `Sec-WebSocket-Accept` in 101 response to browser
8. After 101, server switches to raw frame relay mode:
   - Browser WebSocket frames → forwarded as DATA frames to client
   - Client DATA frames → forwarded as WebSocket frames to browser

**Important:** The server does NOT generate `Sec-WebSocket-Accept`. The target (Next.js) generates it, and the server merely forwards the target's response to the browser.

### Raw Frame Relay

The HTTP router needs two modes per stream:

```javascript
// Mode: HTTP (default)
const HTTP_MODE = 'http';

// Mode: WebSocket (after upgrade)
const WS_MODE = 'websocket';

// Stream state
const streamState = {
  mode: HTTP_MODE,
  socket: browserSocket,  // For WebSocket mode, we need raw socket access
  frameBuffer: Buffer.alloc(0)  // For WebSocket frame parsing
};
```

**HTTP Server Upgrade Event Handling:**

```javascript
// In http-router.js: Handle upgrade separately from regular requests
function createHTTPServer(clientManager, tcpServer, options = {}) {
  const server = createServer((req, res) => {
    // Check if this is a WebSocket upgrade
    if (isWebSocketUpgrade(req)) {
      // Regular HTTP handler shouldn't handle upgrades
      // The 'upgrade' event handler will take care of it
      res.statusCode = 400;
      res.end('WebSocket upgrade not handled here');
      return;
    }
    // ... existing HTTP handling
  });
  
  // Handle WebSocket upgrade events
  server.on('upgrade', (req, socket, head) => {
    if (!isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }
    
    // Allocate stream and register with client manager
    const client = clientManager.get();
    if (!client) {
      socket.destroy();
      return;
    }
    
    const streamId = tcpServer.allocateStreamId();
    
    // Send UPGRADE frame to client with original headers
    const upgradePayload = JSON.stringify({
      protocol: 'websocket',
      method: req.method,
      path: req.url,
      headers: req.headers
    });
    
    client.write(encodeFrame(streamId, FrameType.UPGRADE, upgradePayload));
    
    // Register WebSocket-mode stream handler
    // ... (see WebSocket frame relay below)
  });
  
  return server;
}
```

**WebSocket Frame Parsing (Minimal):**

```javascript
// Parse WebSocket frame from browser (minimal implementation)
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
```

**WebSocket Frame Building (Minimal):**

```javascript
// Build WebSocket frame to send to browser (server→client, unmasked)
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
```

### Client-Side WebSocket Handling (Proxy)

The client proxy needs to:

1. Detect UPGRADE frame from server
2. Make HTTP request to target with upgrade headers
3. When target responds with 101, switch to raw relay mode
4. Forward WebSocket frames bidirectionally

```javascript
// Client proxy WebSocket handling
function handleFrame(frame) {
  if (frame.type === FrameType.UPGRADE) {
    // Switch to WebSocket mode for this stream
    startWebSocketProxy(frame.streamId, frame.payload);
  } else if (isWebSocketStream(frame.streamId)) {
    // In WebSocket mode, DATA frames contain raw WebSocket frames
    handleWebSocketData(frame.streamId, frame.payload);
  }
  // ... existing HTTP handling
}

function startWebSocketProxy(streamId, payload) {
  const upgradeInfo = JSON.parse(payload.toString());
  
  // Make request to target with original upgrade headers (including Sec-WebSocket-Key)
  const proxyReq = request({
    hostname: targetHost,
    port: targetPort,
    method: upgradeInfo.method,  // 'GET'
    path: upgradeInfo.path,
    headers: {
      ...upgradeInfo.headers,  // Includes Sec-WebSocket-Key
      host: `${targetHost}:${targetPort}`
    }
  });
  
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    // Target accepted upgrade - send its response back to server
    // The target generated Sec-WebSocket-Accept based on the original key
    connection.write(encodeFrame(streamId, FrameType.UPGRADE, JSON.stringify({
      status: 101,
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-accept': proxyRes.headers['sec-websocket-accept']
        // Forward any other relevant headers
      }
    })));
    
    // Now relay raw frames
    activeWebSockets.set(streamId, proxySocket);
    
    // Forward proxySocket data to tunnel as DATA frames
    proxySocket.on('data', (chunk) => {
      // chunk is raw WebSocket frame from target - wrap in DATA frame
      connection.write(encodeFrame(streamId, FrameType.DATA, chunk));
    });
    
    // Handle target close
    proxySocket.on('close', () => {
      activeWebSockets.delete(streamId);
      connection.write(encodeFrame(streamId, FrameType.FIN, Buffer.alloc(0)));
    });
    
    // Forward tunnel DATA frames to proxySocket
    // (see handleWebSocketData below)
  });
  
  // Handle upgrade failure
  proxyReq.on('error', (err) => {
    connection.write(encodeFrame(streamId, FrameType.ERROR, Buffer.from('Upgrade failed')));
  });
}

function handleWebSocketData(streamId, payload) {
  // payload is a raw WebSocket frame from the browser (via tunnel)
  const proxySocket = activeWebSockets.get(streamId);
  if (proxySocket) {
    proxySocket.write(payload); // Forward to target
  }
}
```

## Protocol Changes Summary

### Frame Type Additions

| Type | Value | Description |
|------|-------|-------------|
| UPGRADE | `0x08` | Protocol upgrade (WebSocket) |

### Stream Lifecycle: WebSocket Mode

```
HTTP Mode (default):
  ┌─────────┐  HEADERS  ┌─────────┐  DATA  ┌─────────┐  FIN  ┌─────────┐
  │ Request │──────────►│ Target  │◄───────│ Response│◄──────│  Done   │
  └─────────┘           └─────────┘        └─────────┘       └─────────┘

WebSocket Mode:
  ┌─────────┐  UPGRADE  ┌─────────┐  DATA(raw WS)  ┌─────────┐  FIN/Close  ┌─────────┐
  │ Upgrade │──────────►│  101    │◄═══════════════►│ Bidir   │────────────►│  Done   │
  │ Request │           │ Response│   (continuous)   │ Stream  │  (or drop)  │         │
  └─────────┘           └─────────┘                  └─────────┘             └─────────┘
```

## Components

### 1. Server: HTTP Router WebSocket Support

**File:** `/apps/server/lib/http-router.js` (modifications)

Add:
- `isWebSocketUpgrade()` detection
- Raw socket upgrade handling (Node.js HTTP `server.on('upgrade', ...)` event)
- Factored-out stream allocation/registration for reuse in upgrade handler
- WebSocket frame parser (minimal)
- WebSocket frame builder (minimal)
- Stream mode tracking (HTTP vs WebSocket)
- Stream timeout disable for WebSocket-mode streams

### 2. Server: Frame Protocol Extension

**File:** `/packages/frame-protocol/index.js` (modifications)

Add:
- `UPGRADE: 0x08` to FrameType enum
- No encoder/decoder changes needed (same 9-byte header)

### 3. Client: Proxy WebSocket Support

**File:** `/apps/client/lib/proxy.js` (modifications)

Add:
- UPGRADE frame handling
- WebSocket connection to target
- Raw frame relay mode
- Active WebSocket stream tracking

### 4. Client: Connection (no changes)

The TLS connection layer doesn't need changes - it already handles DATA frames. The proxy layer interprets UPGRADE and switches modes.

## Implementation Plan

### Phase 1: Server-Side WebSocket Detection

1. Detect upgrade requests in http-router
2. Send UPGRADE frame to client with original headers (including `Sec-WebSocket-Key`)
3. Receive UPGRADE frame from client with target's response (including `Sec-WebSocket-Accept`)
4. Send 101 response to browser with target's `Sec-WebSocket-Accept`
5. Test: Browser can complete WebSocket handshake

### Phase 2: Server-Side Frame Relay

1. Handle Node.js HTTP `upgrade` event on server instance (`server.on('upgrade', ...)`)
2. Factor out stream allocation/registration so it can be called from both `request` and `upgrade` handlers
3. Access raw socket for WebSocket communication
4. Parse incoming WebSocket frames from browser
5. Wrap in DATA frames, send to tunnel client
6. Unwrap DATA frames from client, send to browser as WebSocket frames
7. Test: Echo server works through tunnel

### Phase 3: Client-Side WebSocket Support

1. Handle UPGRADE frame in proxy
2. Make upgrade request to target
3. On 101, store target socket in activeWebSockets
4. Relay DATA frames ↔ WebSocket frames
5. Handle close (FIN frame or actual close frame)
6. Test: Next.js HMR works

### Phase 4: Testing & Edge Cases

1. Handle close frames (opcode 8)
2. Handle ping/pong frames (opcodes 9/10)
3. Handle fragmented frames (FIN=0) - optional, HMR doesn't use them
4. ~~Handle large frames (>1MB)~~ - Skip for now, HMR messages are small (<64KB)
5. Test: Disconnect handling, reconnection
6. Test: Next.js HMR full integration

## WebSocket Frame Format Reference

### From Browser (masked)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
|N|V|V|V|       |S|             |   (if payload len==126/127)   |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
|     Extended payload length continued, if payload len == 127  |
+ - - - - - - - - - - - - - - - +-------------------------------+
|                               |Masking-key, if MASK set to 1  |
+-------------------------------+-------------------------------+
| Masking-key (continued)       |          Payload Data         |
+-------------------------------- - - - - - - - - - - - - - - - +
:                     Payload Data continued ...                :
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
|                     Payload Data continued ...                |
+---------------------------------------------------------------+
```

### To Browser (unmasked)

Same format but MASK bit is 0 and no masking key.

### Opcodes

| Opcode | Meaning | Action |
|--------|---------|--------|
| 0 | Continuation | Fragmented frame (part of larger message) |
| 1 | Text | UTF-8 text message |
| 2 | Binary | Binary message |
| 8 | Close | Connection close |
| 9 | Ping | Keepalive ping |
| 10 | Pong | Keepalive response |

## Limitations (Acceptable for Next.js HMR)

1. **No compression** - `Sec-WebSocket-Extensions` not supported
2. **No subprotocols** - `Sec-WebSocket-Protocol` ignored
3. **No fragmented messages** - FIN=0 not implemented (Next.js uses small messages)
4. **No large message splitting** - WebSocket frames must fit in single DATA frame (<1MB)
5. **No strict UTF-8 validation** - Binary treated as opaque
6. **Single WebSocket per stream** - No multiplexing within WebSocket

## Testing Strategy

### Unit Tests

```javascript
// Test WebSocket frame parser
// Test WebSocket frame builder
// Test Sec-WebSocket-Accept generation (target-side, not server-side)
// Test close frame handling
```

### Integration Tests

```javascript
// Test 1: WebSocket handshake
// - Start server, client, echo target
// - Connect WebSocket through tunnel
// - Assert: 101 response received

// Test 2: WebSocket echo
// - Send text frame through tunnel
// - Assert: Echo received

// Test 3: Next.js HMR simulation
// - Mock Next.js HMR server
// - Connect through tunnel
// - Send HMR update messages
// - Assert: Messages flow both directions

// Test 4: WebSocket close
// - Send close frame (opcode 8)
// - Assert: Clean shutdown, both directions closed

// Test 5: Next.js HMR full test
// - Start actual Next.js dev server
// - Tunnel through to it
// - Modify a file
// - Assert: HMR update received via WebSocket
```

## Verification Checklist

- [ ] WebSocket upgrade request detected
- [ ] UPGRADE frame sent to client with original headers (including `Sec-WebSocket-Key`)
- [ ] Client makes upgrade request to target with original `Sec-WebSocket-Key`
- [ ] Target's 101 response (with `Sec-WebSocket-Accept`) forwarded to browser
- [ ] Server does NOT generate its own `Sec-WebSocket-Accept`
- [ ] 101 response sent to browser with target's `Sec-WebSocket-Accept`
- [ ] Raw socket access for frame relay
- [ ] WebSocket frames parsed from browser
- [ ] WebSocket frames wrapped in DATA frames
- [ ] DATA frames unwrapped to WebSocket frames
- [ ] Client handles UPGRADE frame
- [ ] Client relays frames bidirectionally
- [ ] Stream timeout disabled for WebSocket streams
- [ ] Close frame (opcode 8) handled
- [ ] Next.js HMR works through tunnel
- [ ] Existing HTTP functionality unchanged

## Files to Modify

| File | Changes |
|------|---------|
| `/packages/frame-protocol/index.js` | Add `UPGRADE: 0x08` frame type |
| `/apps/server/lib/http-router.js` | WebSocket detection, upgrade handling, frame relay |
| `/apps/client/lib/proxy.js` | UPGRADE handling, WebSocket proxy mode |

## No New Dependencies

Uses only:
- `node:http` - Already used, upgrade event handling
- `node:net` - Already used, raw socket access
- Existing frame protocol

Note: `node:crypto` is available if needed later (e.g., for Sec-WebSocket-Accept generation), but not required for this WebSocket implementation since the target generates the accept hash.

## Security Considerations

1. **No origin validation** - Accept connections from any origin (HMR use case)
2. **No rate limiting on WebSocket** - Relies on underlying TLS connection limits
3. **Max frame size enforced** - Same 1MB limit as HTTP frames
4. **No compression** - Prevents CRIME/BREACH attacks
5. **Close on error** - Malformed frames destroy connection (fail closed)
6. **Stream timeout disabled for WebSockets** - Relies on WebSocket ping/pong or TLS keepalive
