# Design: Multi-Connection TLS Pooling

## Goal
Enable higher throughput by maintaining multiple TLS connections between client and server, with intelligent load distribution.

## Current Limitation
- Single TLS socket capped by TCP throughput (window size, RTT)
- ~100 concurrent streams max over one connection
- Server only accepts ONE client connection at a time

## Proposed Architecture

### Overview
```
HTTP Clients
     │
     ▼
┌─────────────────────────────────────┐
│         HTTP Router (single)        │
│    Receives all HTTP requests         │
└──────────────┬──────────────────────┘
               │ Routes to least-loaded connection
               ▼
┌─────────────────────────────────────┐
│      Connection Pool Manager          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ │
│  │ Conn 1  │ │ Conn 2  │ │ Conn 3  │ │  (2-8 connections)
│  │stream-1 │ │stream-101│ │stream-201│ │  (each 100 streams)
│  └────┬────┘ └────┬────┘ └────┬────┘ │
└───────┼───────────┼───────────┼──────┘
        │           │           │
        ▼           ▼           ▼
┌─────────────────────────────────────┐
│      TLS Sockets (node:tls)         │
│  Socket 1    Socket 2    Socket 3 │
└──────┬────────────┬───────────┬────┘
       │            │           │
       └────────────┴───────────┘
                   │
                   ▼ Single logical tunnel
          ┌───────────────┐
          │  Tunnel Client │
          └───────────────┘
```

## Key Design Decisions

### 1. Connection Pool Size
- **Dynamic**: Start with 1, scale up to max (e.g., 4-8) based on load
- **Metrics**: 
  - Active stream count per connection (threshold: 80/100)
  - Bytes/sec throughput per connection
  - Connection latency/health

### 2. Load Distribution Strategies

#### Option A: Round-Robin (Simple)
```
assignStream() {
  conn = connections[nextIndex++ % connections.length]
  if (conn.activeStreams < 100) return conn
  // else find least loaded
}
```
- Pros: Even distribution, simple
- Cons: Ignores actual load differences

#### Option B: Least-Loaded (Recommended)
```
assignStream() {
  return connections.minBy(c => c.activeStreams + c.pendingBytes)
}
```
- Pros: Balances based on actual pressure
- Cons: Slightly more compute, but negligible

#### Option C: Hash-based (Sticky)
```
assignStream(requestId) {
  // Same stream ID always goes to same connection
  return connections[hash(requestId) % connections.length]
}
```
- Pros: Request ordering preserved per ID
- Cons: Can create hot spots

**Recommendation**: Start with **Least-Loaded**, add hash-based later if needed for ordering.

### 3. Stream ID Allocation

**Problem**: Stream IDs must be unique per connection. With multiple connections, we have multiple ID namespaces.

**Solution**: Partitioned stream IDs
```
Connection 1: streams 1-100, 301-400, 601-700...
Connection 2: streams 101-200, 401-500, 701-800...
Connection 3: streams 201-300, 501-600, 801-900...

Formula: streamId = base + (round * poolSize * 100) + offset
```

Or simpler: Each connection maintains its own 1-100 counter, HTTP router maps logical stream IDs to (connection, localStreamId).

### 4. Backpressure Handling

Per-connection backpressure:
```javascript
if (conn.socket.writableNeedDrain) {
  // Don't assign new streams to this connection
  // Return 503 to HTTP client or queue locally
}
```

Global backpressure:
```javascript
if (allConnections.areBusy()) {
  // Return 503 with Retry-After header
  // Or queue in memory (with max queue size)
}
```

### 5. Connection Health & Recovery

```javascript
connectionPool = [
  { id: 1, socket, activeStreams: 45, healthy: true, latency: 20ms },
  { id: 2, socket, activeStreams: 98, healthy: true, latency: 25ms },
  { id: 3, socket, activeStreams: 0, healthy: false, reconnectTimer: ... }
]
```

- Health check: PING/PONG responses
- Auto-reconnect: Individual connections, not whole pool
- Circuit breaker: 3 failures = unhealthy, try reconnect after delay

### 6. Server-Side Changes

**Current**: Single client socket stored in `ClientManager`
**New**: Client connection pool in `ClientManager`

```javascript
// Server-side ClientManager
class ClientConnectionPool {
  connections = new Map() // socket -> connection metadata
  
  add(socket) {
    if (connections.size >= MAX_CLIENT_CONNECTIONS) {
      socket.destroy() // or use LRU
      return
    }
    connections.set(socket, { activeStreams: new Map() })
  }
  
  // Route frame to correct connection's stream handler
  routeResponse(streamId, frame) {
    // Find which connection owns this streamId
    const conn = findConnectionForStream(streamId)
    conn.handleFrame(streamId, frame)
  }
}
```

### 7. Protocol Changes

**No protocol changes needed** - framing protocol is connection-agnostic.

Server just needs to track which connection a stream belongs to.

## Implementation Plan (if we were to do it)

### Phase 1: Static Pool
- Configurable pool size (2-4 connections)
- Round-robin assignment
- No dynamic scaling

### Phase 2: Dynamic Scaling
- Scale up: When all connections > 80% streams
- Scale down: When all connections < 30% streams (after idle time)
- Max cap: 8 connections

### Phase 3: Smart Routing
- Least-loaded algorithm
- Latency-based routing
- Circuit breaker pattern

## Trade-offs

| Aspect | Single Connection | Connection Pool |
|--------|------------------|-----------------|
| **Complexity** | Low | Medium |
| **Memory** | 1 TLS context | N TLS contexts |
| **CPU** | Single encrypt/decrypt | Parallel encrypt/decrypt |
| **Latency** | Low (no routing decision) | +1-5ms routing overhead |
| **Throughput** | ~100-500 Mbps | N x single connection |
| **Ordering** | FIFO guaranteed | Per-connection only |
| **Server Cost** | 1 socket | N sockets per client |

## When to Use This

**Don't use if:**
- Throughput needs are modest (< 100 Mbps)
- Latency is critical (every ms counts)
- Simplicity is preferred

**Use if:**
- Hitting TCP throughput limits (high BDP networks)
- Many concurrent long-lived streams (SSE, WebSockets if added)
- Large file uploads/downloads saturating single connection

## Alternative: HTTP/2 or HTTP/3

Instead of custom pooling, could migrate to:
- **HTTP/2**: Native multiplexing, flow control, prioritization
- **HTTP/3 (QUIC)**: Multiplexing without head-of-line blocking, better loss recovery

Trade-off: Lose custom framing protocol simplicity, gain battle-tested standards.
