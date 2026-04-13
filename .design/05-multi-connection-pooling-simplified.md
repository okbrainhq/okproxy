# Design: Multi-Connection TLS Pooling (Simplified)

## User's Key Insight

> "It's the same client on the terminating side. We just need more bandwidth."

**Translation**: Since one client app proxies to one local service, we don't need complex routing logic. Any TLS connection can handle any request. The client just forwards everything to `localhost:3000` regardless of which connection it arrived on.

## Simplified Architecture

```
HTTP Clients
     │
     ▼
┌─────────────────────────────────────┐
│         HTTP Router (server)        │
│    Single entry point for all HTTP    │
└──────────────┬──────────────────────┘
               │ Pick any available connection
               ▼
┌─────────────────────────────────────┐
│      Client Connection Pool           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ │
│  │ Conn 1  │ │ Conn 2  │ │ Conn 3  │ │  (2-N connections)
│  │stream-1 │ │stream-1 │ │stream-1 │ │  (same stream ID space)
│  └────┬────┘ └────┬────┘ └────┬────┘ │
└───────┼───────────┼───────────┼──────┘
        │           │           │
        ▼           ▼           ▼
┌─────────────────────────────────────┐
│      Tunnel Client (same process)     │
│                                       │
│  ┌─────────────────────────────────┐  │
│  │     Frame Demultiplexer           │  │
│  │  (merges frames from all conns    │  │
│  │   into single stream)             │  │
│  └─────────────────────────────────┘  │
│                   │                   │
│                   ▼                   │
│  ┌─────────────────────────────────┐  │
│  │  Proxy to localhost:3000          │  │
│  │  (doesn't care which conn)        │  │
│  └─────────────────────────────────┘  │
└─────────────────────────────────────┘
```

## Key Simplifications

### 1. No Stream ID Partitioning Needed

**Previous complex design**: 
- Conn 1: streams 1-100
- Conn 2: streams 101-200
- Conn 3: streams 201-300

**Simplified design**:
- All connections use **same stream ID space**
- Conn 1 has stream-5, Conn 2 also has stream-5 (different HTTP requests)
- Server tracks: `streamId → connection` mapping

```javascript
// Server-side tracking
const streamToConnection = new Map()

// When HTTP request arrives:
const streamId = allocateStreamId()
const conn = pickAnyAvailableConnection() // random, round-robin, least-loaded
streamToConnection.set(streamId, conn)
conn.write(frameWith(streamId))

// When response frame arrives from client:
const conn = streamToConnection.get(frame.streamId)
// Send HTTP response back
```

### 2. Client-Side: Simple Demultiplexer

Client receives frames on multiple connections, doesn't care which:

```javascript
// Client-side
function onFrameFromAnyConnection(frame) {
  // Same proxy logic regardless of source connection
  proxyToLocalService(frame)
}

// No connection-specific handling needed
```

### 3. Connection Selection Logic (Server-Side Only)

```javascript
function pickConnection() {
  // Option 1: Random
  return connections[Math.random() * connections.length | 0]
  
  // Option 2: Round-robin
  return connections[nextIndex++ % connections.length]
  
  // Option 3: Least-loaded (simple count)
  return connections.minBy(c => c.activeStreams.size)
}
```

All are valid because the client treats them identically.

## Protocol Changes: Minimal

### Frame Format: No Change
```
┌─────────────────┬───────────┬─────────────────┬──────────────────┐
│  Stream ID      │  Type     │  Length         │  Payload         │
│  (4 bytes)      │  (1 byte) │  (4 bytes)      │  (N bytes)       │
└─────────────────┴───────────┴─────────────────┴──────────────────┘
```

### INIT Frame: Add Connection Pool Metadata

```javascript
// Server → Client INIT response
{
  version: 1,
  maxFrameSize: 1048576,
  maxConcurrentStreams: 100,
  connectionPoolSize: 4,        // NEW: tell client to open N connections
  connectionId: 2               // NEW: which connection this is (1-4)
}
```

Or simpler - client decides pool size, opens N connections independently.

## Server-Side Changes

### ClientManager Becomes Connection Pool

```javascript
class ClientConnectionPool {
  // Multiple sockets from same client (same cert = same client)
  connections = new Set()
  
  // Map stream ID -> connection (for routing responses back)
  streamRoutes = new Map()
  
  addConnection(socket) {
    if (connections.size >= MAX_CONNECTIONS_PER_CLIENT) {
      socket.destroy()
      return
    }
    connections.add(socket)
  }
  
  assignStream(streamId) {
    // Pick any connection (simplest: round-robin)
    const conn = Array.from(connections)[streamCounter++ % connections.size]
    streamRoutes.set(streamId, conn)
    return conn
  }
  
  getConnectionForStream(streamId) {
    return streamRoutes.get(streamId)
  }
  
  releaseStream(streamId) {
    streamRoutes.delete(streamId)
  }
}
```

### TLS Server: Accept Multiple Connections

```javascript
// Current: rejects if client already connected
if (clientManager.hasClient()) {
  socket.destroy()
  return
}

// New: accept multiple from same cert
const cert = socket.getPeerCertificate()
const clientId = cert.serialNumber // or fingerprint

if (!clientPools.has(clientId)) {
  clientPools.set(clientId, new ClientConnectionPool())
}

const pool = clientPools.get(clientId)
pool.addConnection(socket)
```

## Client-Side Changes

### Connection Pool Manager

```javascript
class ClientConnectionPool {
  connections = []
  targetHost, targetPort
  serverHost, serverPort
  
  async init(poolSize = 4) {
    for (let i = 0; i < poolSize; i++) {
      const conn = createTLSConnection({...config})
      this.connections.push(conn)
    }
  }
  
  // Just receives frames, doesn't care which connection
  onFrame(frame, fromConnection) {
    // Forward to local service - same logic for all connections
    proxyToLocal(frame)
  }
  
  // Health: if one connection dies, reconnect just that one
  onDisconnect(connection) {
    setTimeout(() => connection.reconnect(), 1000)
  }
}
```

## Traffic Distribution Examples

### Scenario: 300 concurrent HTTP requests

```
HTTP Req 1   → stream-1   → Conn 1
HTTP Req 2   → stream-2   → Conn 2  
HTTP Req 3   → stream-3   → Conn 3
HTTP Req 4   → stream-4   → Conn 4
HTTP Req 5   → stream-5   → Conn 1
...
HTTP Req 300 → stream-300 → Conn 4

Each connection handles ~75 streams (well under 100 limit)
Total throughput: 4x single connection
```

### Response Path

```
Local Service Response
         │
         ▼
┌──────────────────────┐
│ Client Frame Encoder │
│ (picks any conn or   │
│  uses conn that made │
│  the request)        │
└──────────┬───────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
 Conn 1        Conn 3
 (stream-5)   (unused)
    │
    ▼
 Server → HTTP Response
```

**Key point**: Client can respond on ANY connection, but responding on the same connection that sent the request is simpler (no server-side tracking needed for responses).

## Trade-offs (Simplified vs Previous Design)

| Aspect | Previous Complex Design | This Simplified Design |
|--------|--------------------------|------------------------|
| Stream IDs | Partitioned by connection | Shared namespace |
| Routing logic | Complex least-loaded | Simple round-robin/random |
| Client complexity | Demux by connection ID | Single demuxer for all |
| Server memory | Map<stream, conn> + partition tracking | Just Map<stream, conn> |
| Connection selection | Latency-aware, weighted | Any available |
| Failure handling | Complex failover per partition | Just reconnect dead one |

## When to Build This

**Still don't build unless:**
1. Single connection saturates (measure with `iperf` or actual load)
2. You're on high-BDP network (satellite, transcontinental)
3. You have many concurrent long-running streams (SSE, large uploads)

**Signs you need it:**
- `tcpdump` shows TCP window exhausted
- Throughput plateaus below expected bandwidth
- High retransmit rates on single connection

## Implementation Complexity

| Component | Lines of Code (est) |
|-----------|-------------------|
| Server: Multi-connection acceptance | ~50 |
| Server: Stream-to-connection mapping | ~30 |
| Server: Simple round-robin selector | ~10 |
| Client: Connection pool manager | ~100 |
| Client: Shared frame handler | ~20 |
| **Total** | **~210 lines** |

Much simpler than the previous 500+ line design with partitioned IDs and complex routing.
