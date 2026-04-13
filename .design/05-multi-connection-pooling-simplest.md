# Design: Multi-Connection TLS Pooling (Ultra-Simplified)

## User's Key Insight

> "I don't think we need streamId -> connection mapping as well."

**Translation**: Just respond on the same connection that sent the request. Request and response are coupled to the same socket - no tracking needed.

## Ultra-Simplified Architecture

```
HTTP Clients
     │
     ▼
┌─────────────────────────────────────┐
│         HTTP Router (server)        │
│  - Picks any available connection     │
│  - Stream lives and dies on that conn │
└──────────────┬──────────────────────┘
               │ stream-5 on Conn 2
               ▼
┌─────────────────────────────────────┐
│      Connection 2 (TLS socket)        │
│  - Receives request frame             │
│  - Sends response frame (same conn)   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│      Client (single process)          │
│  - Receives frame on Conn 2           │
│  - Proxies to localhost:3000          │
│  - Sends response back on Conn 2      │
└─────────────────────────────────────┘
```

## Key Insight: Connection = Stream Scope

Each stream is **scoped to its connection**. No cross-connection stream tracking.

```
Connection 1              Connection 2              Connection 3
├─ stream-1 (active)      ├─ stream-1 (active)      ├─ stream-1 (idle)
├─ stream-2 (active)      ├─ stream-2 (idle)        └─ stream-2 (idle)
├─ stream-3 (idle)        └─ stream-3 (idle)        
└─ stream-4 (idle)        

Server sees: 5 total active streams (2+1+0)
Each connection has its own 1-100 stream space
```

## Zero Server-Side State

### Before (with tracking):
```javascript
// Server had to track
const streamToConnection = new Map()
streamToConnection.set(5, conn2)

// On response, look it up
const conn = streamToConnection.get(streamId)
conn.write(response)
```

### After (no tracking):
```javascript
// Server: Just write to the socket that received the frame
socket.write(responseFrame)

// Client: Just respond on the socket where request arrived
// No routing decision, no lookup table
```

## How It Works

### Request Flow
```javascript
// Server side
function handleHTTPRequest(httpReq, httpRes) {
  // Pick least-loaded connection
  const conn = pickConnection()
  
  // Allocate stream ID (per-connection counter!)
  const streamId = conn.allocateStreamId()
  
  // Send to that specific connection
  conn.socket.write(encodeFrame(streamId, HEADERS, httpReq.headers))
  conn.socket.write(encodeFrame(streamId, DATA, httpReq.body))
  
  // Store httpRes locally for when response comes back
  conn.pendingResponses.set(streamId, httpRes)
}
```

### Response Flow
```javascript
// Server side - frame arrives on a socket
function onFrame(socket, frame) {
  // frame came FROM this socket, respond TO this socket
  const httpRes = socket.pendingResponses.get(frame.streamId)
  httpRes.write(frame.payload)
  
  if (frame.type === FIN) {
    socket.pendingResponses.delete(frame.streamId)
    socket.releaseStreamId(frame.streamId)
  }
}
```

### Client Side (Unchanged Logic)
```javascript
// Client receives frame on socket N
function onFrame(socket, frame) {
  // Proxy to localhost - doesn't care which socket
  proxyToLocalhost(frame)
  
  // When local responds, send back on SAME socket
  socket.write(responseFrame)
}
```

## Stream ID Allocation (Per-Connection)

Each connection maintains its own 1-100 counter:

```javascript
class Connection {
  nextStreamId = 1
  activeStreams = new Set()
  
  allocateStreamId() {
    // Simple: just increment, no global coordination needed
    const id = this.nextStreamId++
    if (this.nextStreamId > 100) {
      this.nextStreamId = 1
    }
    
    // Check collision (wraparound)
    while (this.activeStreams.has(id)) {
      id = this.nextStreamId++
    }
    
    this.activeStreams.add(id)
    return id
  }
  
  releaseStreamId(id) {
    this.activeStreams.delete(id)
  }
}
```

## Connection Selection (Only Logic We Need)

```javascript
function pickConnection() {
  // Simple: least active streams
  return connections.minBy(c => c.activeStreams.size)
  
  // Or: round-robin
  return connections[next++ % connections.length]
  
  // Or: random
  return connections[Math.random() * connections.length | 0]
}
```

That's it. No global stream ID coordination, no mapping tables.

## Server Data Structures

```javascript
// Per-connection state (no global stream tracking)
class TLSConnection {
  socket
  nextStreamId = 1
  activeStreams = new Set()        // just for allocation, not routing
  pendingHTTPResponses = new Map() // streamId -> http response object
}

// Just an array of connections
const connections = [conn1, conn2, conn3, conn4]
```

## Trade-offs: Designs Compared

| Aspect | Complex (Partitioned IDs) | Simple (Mapping) | Ultra-Simple (No Tracking) |
|--------|---------------------------|------------------|---------------------------|
| **Stream IDs** | Global namespace | Global namespace | Per-connection (1-100 each) |
| **Server state** | Partition table | Map<stream, conn> | Just pendingResponses on conn |
| **Coordination** | Central allocator | Central allocator | None (per-connection) |
| **Client complexity** | Demux by conn ID | Single demuxer | Same as now |
| **Implementation** | ~500 lines | ~210 lines | **~100 lines** |

## Implementation Complexity

| Component | Lines of Code |
|-----------|--------------|
| Server: Accept multiple connections | ~20 |
| Server: Per-connection stream allocator | ~15 |
| Server: Simple least-loaded picker | ~5 |
| Server: Per-socket pending response map | ~10 |
| Client: Connection pool (N instances) | ~50 |
| **Total** | **~100 lines** |

## When to Build This

**Still don't build unless:**
1. Single connection saturates (measure first!)
2. You have 100+ concurrent streams regularly
3. You're on lossy/high-latency networks

**Signs you need it:**
- Throughput plateaus at ~100-500 Mbps per connection
- Many concurrent long uploads/downloads
- TCP window consistently full (`ss -tin` shows high cwnd)

## Summary

| Question | Answer |
|----------|--------|
| Stream ID space? | Per-connection (1-100) |
| Server tracking? | Just `pendingResponses` on each socket |
| Connection selection? | Least-loaded or round-robin |
| Client routing? | Respond on same socket received |
| Complexity vs single-conn? | +~100 lines of code |

Your insight made this **80% simpler** than my first design!
