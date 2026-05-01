# 09 — Multipath Virtual Socket

## Overview

Currently, the client maintains a **single TLS connection** to the server over the default network interface. When multiple internet-capable interfaces are available (e.g., WiFi + iPhone USB), only one is used.

This design introduces a **Multipath Virtual Socket** — a virtual socket layer that transparently duplicates traffic across all available network interfaces. Every frame is sent over every active connection. Whichever connection delivers a given frame first wins; duplicates are discarded via per-stream sequence numbers. The application layer is completely unaware of the multipath nature.

```
Application (Proxy / HTTP Router)
          │
          ▼
┌─────────────────────┐
│  VirtualSocket      │  ← single read/write interface
│  ┌────────────────┐ │
│  │ Dedup Windows  │ │  ← Map<streamId, sliding window>
│  │ Seq Counters   │ │  ← per-stream monotonic sequence
│  └────────────────┘ │
│          │           │
│    ┌─────┼─────┐     │
│    ▼     ▼     ▼     │
│  [en0] [en8] [enX]  │  ← one RealSocket per interface
└─────────────────────┘
```

---

## 1. Core Concepts

### 1.1 Virtual Socket

A `VirtualSocket` is a `Duplex`-like object that the application reads from and writes to. Internally, it holds a set of `RealSocket` instances — one per network interface.

**Write path**: Every frame written to the VirtualSocket is assigned a per-stream sequence number, then duplicated and written to every active `RealSocket`.

**Read path**: Incoming frames from any `RealSocket` pass through a deduplication filter. Only the first copy of each `(streamId, seqNo)` is emitted to the application.

### 1.2 Real Socket

A `RealSocket` is a single TLS connection (via `node:tls`) bound to a specific network interface. It maintains its own:

- TLS handshake + mTLS
- INIT handshake
- PING/PONG keepalive
- Reconnection logic (exponential backoff)
- Backpressure handling

A `RealSocket` is essentially a refactored version of the current `tls-connection.js`, with the added ability to bind to a specific interface (`socket.connect` with `localAddress`).

### 1.3 Sequence Numbers

Every data frame carries a **32-bit, per-stream, monotonically increasing sequence number**. The sequence space is independent per stream:

| Frame Type  | Stream ID scope      | Sequenced? |
|-------------|---------------------|------------|
| INIT        | 0 (per-connection)  | No — connection-local |
| PING/PONG   | 0 (per-connection)  | No — connection-local |
| RESET_SEQ   | 0 (per-connection)  | No — connection-local |
| HEADERS     | stream-specific      | Yes |
| DATA        | stream-specific      | Yes |
| FIN         | stream-specific      | Yes |
| ERROR       | stream-specific      | Yes |
| UPGRADE     | stream-specific      | Yes |

Control frames (INIT, PING, PONG, RESET_SEQ) remain **connection-local** — they are NOT duplicated across connections. Each connection does its own INIT handshake and keepalive independently.

### 1.4 Deduplication — Sliding Window

The receiving side maintains a per-stream dedup window: `Map<streamId, DedupWindow>`.

```
DedupWindow:
    base:    uint32    // lowest seqNo tracked (monotonically advances)
    bits:    BigInt    // bitmask, bit i set = seqNo (base + i) already seen
    size:    128       // window size (track last 128 seqNos)
```

When a frame with seqNo `S` on stream `T` arrives:
```
window = dedupWindows.get(T)

if window == null:
    window = new DedupWindow(S)   // initialize base = S
    dedupWindows.set(T, window)
    deliver frame

offset = (S - window.base) >>> 0   // unsigned 32-bit, handles wrap

if offset >= window.size:
    // seqNo jumped ahead — advance window
    shift = offset - window.size + 1
    window.base = (window.base + shift) >>> 0
    window.bits = window.bits >> BigInt(shift)
    offset = window.size - 1

if (window.bits >> BigInt(offset)) & 1n:
    drop frame (duplicate)

window.bits |= (1n << BigInt(offset))
deliver frame
```

**Window maintenance** — After each delivery, trim trailing bits:
```
while (window.bits & 1n) === 1n:
    window.bits = window.bits >> 1n
    window.base = (window.base + 1) >>> 0
```

**Why 128**: With two connections sending identical sequences, the maximum difference between the fastest and slowest connection is bounded by TCP buffer sizes. 128 slots is more than enough.

### 1.5 RESET_SEQ — Sequence Reset

Over long-lived streams (e.g., SSH/WebSocket sessions running for weeks), the 32-bit sequence counter could approach 2³². To prevent wrap-around ambiguity, a **RESET_SEQ** control frame resets the sequence space.

**RESET_SEQ frame** (connection-local, stream ID = 0):
- Type: `0x09`
- Payload (JSON): `{ "streams": [8, 15, 22] }` — list of stream IDs to reset

**Flow**:
1. When a sender's per-stream counter exceeds `2³² - 1,000,000` (configurable threshold), it sends RESET_SEQ.
2. The sender resets `seqCounters[streamId] = 0`.
3. The receiver receives RESET_SEQ, resets `dedupWindows[streamId]` (delete or reinitialize).
4. Subsequent frames for that stream start from seqNo 0 again.

Since RESET_SEQ is connection-local (stream ID = 0, not duplicated), each connection sends it independently. The receiver processes the first one and ignores duplicates (idempotent — window to reset is already gone).

**Threshold reasoning**: At 1 million frames/sec (unrealistic for a tunnel), it would take ~71 minutes to exhaust 2³². For typical tunnel traffic (hundreds of frames/sec), it takes months. The 1M threshold gives ample headroom.

**Memory safety**: When a stream is closed (FIN/ERROR processed), its dedup window is removed.

---

## 2. Frame Protocol Changes

### 2.1 Frame Header (13 bytes)

```
┌──────────────┬─────────┬──────────────┬──────────┬─────────────┐
│ Stream ID    │ Type    │ Seq Number   │ Length   │ Payload     │
│ 4 bytes BE   │ 1 byte  │ 4 bytes BE   │ 4 bytes  │ N bytes     │
└──────────────┴─────────┴──────────────┴──────────┴─────────────┘
```

| Field | Size | Description |
|-------|------|-------------|
| Stream ID | 4 bytes | 0 = control, 1..MAX = data streams |
| Type | 1 byte | Frame type (0x01–0x09) |
| Seq Number | 4 bytes | Per-stream monotonic counter (0 for connection-local frames) |
| Length | 4 bytes | Payload length |
| Payload | N bytes | Frame body |

**Frame types**:

| Type | Value | Direction | Purpose |
|------|-------|-----------|---------|
| HEADERS | `0x01` | Bidir | HTTP headers (JSON) |
| DATA | `0x02` | Bidir | Body chunk |
| FIN | `0x03` | Bidir | Stream complete |
| ERROR | `0x04` | Bidir | Stream error |
| INIT | `0x05` | Bidir | Connection handshake |
| PING | `0x06` | Bidir | Keepalive |
| PONG | `0x07` | Bidir | Keepalive response |
| UPGRADE | `0x08` | Bidir | WebSocket upgrade |
| **RESET_SEQ** | **`0x09`** | Bidir | Sequence counter reset |

### 2.2 Single-Connection Mode

When only one interface is available, the VirtualSocket has exactly one `RealSocket`. The dedup layer still operates (seqNo is assigned, checked), but every frame naturally has a unique `(streamId, seqNo)` — there are no duplicates to drop. The overhead is minimal: 4 extra bytes per frame and one integer comparison per received frame.

No fallback or version negotiation is needed — both server and client are updated together.

### 2.3 seqNo = 0 Convention

For connection-local frames (INIT, PING, PONG, RESET_SEQ), seqNo is always `0`. The decoder bypasses dedup checks for stream-ID-0 frames of these types. This keeps existing PING/PONG logic unchanged.

---

## 3. Architecture — Client Side

### 3.1 Component Diagram

```
┌────────────────────────────────────────────────┐
│  index.js (client entry)                       │
│      │                                         │
│      ▼                                         │
│  ┌──────────────────────┐                      │
│  │ VirtualSocket        │                      │
│  │                      │                      │
│  │  seqCounters:        │                      │
│  │    Map<stream, uint> │                      │
│  │                      │                      │
│  │  dedupWindows:       │                      │
│  │    Map<stream,       │                      │
│  │      {base, bits}>   │                      │
│  │                      │                      │
│  │  realSockets: Set<>  │                      │
│  │                      │                      │
│  │  write(frame) ──┬────┼──► RealSocket(en0)   │
│  │                 ├────┼──► RealSocket(en8)   │
│  │  on('frame') ◄──┼────┼──  (dedup filter)   │
│  └─────────────────┴────┴──────────────────────┘
│           │                                    │
│           ▼                                    │
│  ┌──────────────────────┐                      │
│  │ InterfaceDetector    │                      │
│  │                      │                      │
│  │  poll every 200ms    │                      │
│  │  detect changes      │                      │
│  │  emit add/remove     │                      │
│  └──────────────────────┘                      │
│           │                                    │
│           ▼                                    │
│  ┌──────────────────────┐                      │
│  │ RealSocket (×N)      │                      │
│  │                      │                      │
│  │  tls.connect({       │                      │
│  │    localAddress: ip  │  ← bind to interface │
│  │  })                  │                      │
│  │  INIT handshake      │                      │
│  │  PING/PONG keepalive │                      │
│  │  reconnect loop      │                      │
│  │  backpressure pump   │                      │
│  └──────────────────────┘                      │
└────────────────────────────────────────────────┘
```

### 3.2 VirtualSocket

**Responsibilities**:

1. **Present a single socket interface** — `write(frame)`, `on('frame')`, `close()`, error events.

2. **Assign sequence numbers** — for each outbound frame on stream S:
   ```
   if frame.type in {HEADERS, DATA, FIN, ERROR, UPGRADE}:
       seqCounters[S] = (seqCounters[S] || 0) + 1
       frame.seqNo = seqCounters[S]

       // If approaching 32-bit limit, send RESET_SEQ
       if frame.seqNo > SEQ_RESET_THRESHOLD (2^32 - 1,000,000):
           send RESET_SEQ({ streams: [S] }) to all connections
           seqCounters[S] = 0
           frame.seqNo = 0
   ```

3. **Duplicate writes** — write the frame (with assigned seqNo) to every active `RealSocket`. If ALL RealSockets reject the write, emit `'error'` on the VirtualSocket. Individual socket failures are logged but do not block other sockets.

4. **Deduplicate reads** — for each inbound frame from any RealSocket, apply the sliding window algorithm from section 1.4:
   ```
   if frame.type is connection-local:
       if frame.type === RESET_SEQ:
           for streamId in frame.payload.streams:
               delete dedupWindows[streamId]
       else:
           emit(frame)
       return

   window = dedupWindows.get(frame.streamId)
   if not window: initialize, deliver, return

   offset = unsigned(frame.seqNo - window.base)
   if offset >= window.size: advance window
   if bit at offset is set: drop (duplicate)
   set bit, deliver frame, trim window
   ```

5. **Cleanup on stream close** — when a FIN frame for stream S is emitted (first arrival wins), remove `dedupWindows[S]` and `seqCounters[S]`.

6. **Connection lifecycle** — when an interface is added, create a new `RealSocket`. When an interface is removed or a socket dies permanently, remove it from the set (other connections continue normally).

**Edge cases**:

- **Sequence wrap-around**: Long-lived streams (WebSocket/SSH running for weeks) may exhaust the 32-bit sequence space. RESET_SEQ (section 1.5) handles this: when the counter approaches 2³², a control frame resets the sequence to 0. Both sides clear their dedup windows for the affected streams.

- **Out-of-order across connections**: Impossible in practice. Since all connections carry the same ordered sequence of frames, and TCP guarantees per-connection ordering, whichever connection is fastest will deliver frames sequentially. The sliding window handles the rare edge case where a newer frame from a fast connection arrives while an older frame from a slow connection is still in-flight — the slow frame arrives later and its bit is already set.

- **Backpressure**: Each RealSocket handles its own backpressure (pausing/resuming the write pump). The VirtualSocket write is considered successful if at least one socket accepts the frame. If ALL sockets reject the write, the VirtualSocket emits `'error'`. Stalled sockets may buffer or drop as needed; healthy sockets carry the traffic.

### 3.3 RealSocket

The `RealSocket` is essentially the current `tls-connection.js` (`/apps/client/lib/tls-connection.js`) extracted into a reusable module with the following additions:

| Feature | Status |
|---------|--------|
| TLS + mTLS | Same as current |
| INIT handshake | Same + sends `interface` name |
| Frame encode/decode | Updated to 13-byte header with seqNo |
| PING/PONG keepalive | Same as current (3s interval, 10s timeout) |
| Watchdog | Same as current (35s inactivity timeout) |
| Reconnection | Same as current (exponential backoff: 500ms → 3s max) |
| Backpressure handling | Same as current (8s stall timeout) |
| **Bind to interface** | **NEW** — `tls.connect({ localAddress: '192.168.0.15' })` or `localAddress: '172.20.10.2'` |
| **Interface ID in INIT** | **NEW** — INIT payload includes `"interface": "en0"` |
| **Status reporting** | **NEW** — emit `'status'` events: `connected`, `connecting`, `disconnected`, `failed` |

**Interface binding**:

```javascript
tls.connect({
  host: serverHost,
  port: serverPort,
  localAddress: interfaceIP,   // bind to this interface
  key, cert, ca,
  rejectUnauthorized: true,
})
```

The `localAddress` ensures the TCP connection originates from and is routed through the specified interface's IP. This is how we achieve per-interface routing.

**INIT with interface identifier**:

```
Client → Server: INIT { maxFrameSize: 1048576, interface: "en0" }
```

The server uses the `interface` field to deduplicate reconnections: if a new connection arrives with the same interface name as an existing connection from that client, the old one is destroyed. This is more reliable than matching by source IP (which can be identical behind NAT or change due to DHCP).

### 3.4 InterfaceDetector

Builds upon the existing `network-watchdog.js` (`/apps/client/lib/network-watchdog.js`).

**Current behavior**: Polls `os.networkInterfaces()` every 200ms, builds a fingerprint string of all active IPv4 interfaces. On any change, destroys the socket.

**New behavior**: Instead of destroying the socket, the watchdog reports the **list of internet-capable interfaces** with their IPv4 addresses. The VirtualSocket uses this to create/remove RealSocket instances.

**Detection algorithm**:

```
poll():
    interfaces = os.networkInterfaces()
    internetCapable = []

    for each (name, addrs) in interfaces:
        if name is loopback or internal: skip
        for addr in addrs:
            if addr.family === 'IPv4' and not addr.internal:
                if addr.address is not 169.254.x.x:
                    // connectivity probe (async, cached)
                    if isInternetCapable(name, addr.address):
                        internetCapable.push({ name, ip: addr.address })

    if set changed from last poll:
        emit changed/internetCapable list
```

**`isInternetCapable(name, ip)`** — performs a lightweight connectivity probe using a TCP connect to the tunnel server (same host/port as the tunnel connection):
```
1. Create a raw socket bound to the interface IP
2. TCP connect to server:port with short timeout (2s)
3. If connection succeeds: internet-capable. Close the probe socket.
4. Cache result for 5 seconds to avoid probe storms
```

**Why a probe (not routing tables)**:
- Portable across macOS, Linux, Windows — no platform-specific `netstat` or `ip route` parsing.
- Actually verifies internet connectivity, not just route presence.
- The tunnel server is the only destination that matters; probing it directly answers the right question.
- ~2s probe overhead is negligible (interface changes are infrequent, and the probe runs async).

**Internal exclusion list** — interfaces to always skip: `lo`, `awdl`, `llw`, `utun*`, `bridge*`, `vmenet*`, `anpi*`.

**Implementation note**: On macOS, WiFi is `en0`, iPhone USB is `en8`. Other interfaces (Thunderbolt bridges, VMWare, etc.) are filtered by the probe — they won't reach the tunnel server.

### 3.5 Connection Lifecycle

```
Interface appears (e.g., iPhone USB plugged in)
    │
    ▼
InterfaceDetector emits { name: 'en8', ip: '172.20.10.2' }
    │
    ▼
VirtualSocket.createRealSocket('en8', '172.20.10.2')
    │
    ▼
RealSocket connects → TLS handshake → INIT → 'connected'
    │
    ▼
VirtualSocket adds socket to active set
    │
    ▼
All subsequent writes are duplicated to this socket too
    │
    ... time passes ...
    │
    ▼
Interface disappears (iPhone unplugged)
    │
    ▼
InterfaceDetector emits removal
    │
    ▼
VirtualSocket removes socket from active set
    │
    ▼
RealSocket.destroy() — clean up
```

**Critical invariant**: There must always be at least one active connection. If the last interface goes down, the VirtualSocket emits `'error'` or `'close'`, triggering application-level reconnection.

---

## 4. Architecture — Server Side

### 4.1 Design Philosophy

The server is designed for a **single client**. There is no client identification, no multi-client session management, no cert fingerprinting. All incoming TLS connections belong to the same logical client.

This keeps the server side extremely simple: maintain a set of connections, dedup incoming frames across them, duplicate outgoing frames to all of them.

### 4.2 Component Diagram

```
┌────────────────────────────────────────────────┐
│  tls-server.js                                 │
│      │                                         │
│      ▼                                         │
│  ┌──────────────────────┐                      │
│  │ ConnectionPool       │                      │
│  │                      │                      │
│  │  connections: Set<>  │  ← all TLS sockets   │
│  │                      │                      │
│  │  dedupWindows:       │                      │
│  │    Map<stream,       │  ← sliding window     │
│  │      {base, bits}>   │    per stream         │
│  │                      │                      │
│  │  seqCounters:        │                      │
│  │    Map<stream, uint> │  ← outbound seq nos   │
│  │                      │                      │
│  │  streamMap:          │  ← same as current    │
│  │    Map<stream,       │    ClientManager      │
│  │      {handler,       │                      │
│  │       errorHandler}> │                      │
│  │                      │                      │
│  │  onFrame(frame,      │                      │
│  │           conn)      │                      │
│  │  send(frame)         │  → duplicates to all  │
│  └──────────────────────┘                      │
└────────────────────────────────────────────────┘
```

### 4.3 ConnectionPool

Replaces the current single-client `ClientManager`.

**On new TLS connection**:

```
onSecureConnection(socket):
    wait for INIT frame on this socket

    // Extract interface name from INIT
    interfaceName = initPayload.interface   // e.g., "en0"

    // If a connection for this interface already exists, replace it
    if pool.connections.has(interfaceName):
        oldSocket = pool.connections.get(interfaceName)
        oldSocket.destroy()
        pool.connections.delete(interfaceName)

    pool.connections.set(interfaceName, socket)

    // Respond with INIT ACK
    send INIT { maxFrameSize: 1048576, maxConcurrentStreams: 100 }

    // Start per-connection PING/PONG keepalive

    // Wire up frame handler
    on frame from this socket → pool.onFrame(frame, socket)
```

**On frame from any connection**:

```
ConnectionPool.onFrame(frame, socket):
    if frame.type is connection-local:
        handle locally (PING → PONG, RESET_SEQ → dedup reset)
        return

    // Dedup check (sliding window)
    window = dedupWindows.get(frame.streamId)
    if not window: initialize, deliver, return
    offset = unsigned(frame.seqNo - window.base)
    if offset >= window.size: advance window
    if bit is set: drop (duplicate)
    set bit, deliver, trim window

    // Route to stream handler
    if frame.type === HEADERS:
        create new stream, allocate ID, register handler
        streamMap[frame.streamId] = { frameHandler, errorHandler }
    else:
        handler = streamMap[frame.streamId]
        handler.frameHandler(frame)
```

**Server-to-client writes**:

```
ConnectionPool.send(frame):
    if frame.type in {HEADERS, DATA, FIN, ERROR, UPGRADE}:
        seqCounters[streamId] = (seqCounters[streamId] || 0) + 1
        frame.seqNo = seqCounters[streamId]

        if frame.seqNo > SEQ_RESET_THRESHOLD:
            send RESET_SEQ({ streams: [streamId] }) to all connections
            seqCounters[streamId] = 0
            frame.seqNo = 0

    encoded = encodeFrame(frame)
    for each socket in pool.connections.values():
        socket.write(encoded)
```

### 4.4 Stream ID Allocation

Unchanged from current behavior. Stream IDs are allocated per-server-instance (since there's only one client). The allocation logic stays in `tls-server.js` unchanged — `allocateStreamId()` tracks IDs in an `activeStreams` Set, wraps at MAX, collision-detects.

### 4.5 Per-Connection State

Each connection needs:
- Its own INIT state (pending/complete).
- Its own PING/PONG timer and timeout tracking.
- A write backpressure pump.

All managed per-socket within the `ConnectionPool`.

**Connection removal**: When a connection closes:
1. Remove it from `pool.connections`.
2. If `pool.connections` becomes empty → close all streams with errors.
3. If other connections are still active → the pool continues normally. No stream interruption.

---

## 5. Sequence Number Management

### 5.1 Sliding Window Implementation

Each stream gets a `DedupWindow`:

```javascript
class DedupWindow {
  constructor(firstSeqNo) {
    this.base = firstSeqNo >>> 0    // unsigned 32-bit
    this.bits = 0n                  // BigInt bitmask
    this.size = 128                 // window size
  }

  checkAndAdd(seqNo) {
    let offset = (seqNo - this.base) >>> 0   // unsigned, handles wrap

    if (offset >= this.size) {
      // Advance window forward
      const shift = BigInt(offset - this.size + 1)
      this.base = (this.base + Number(shift)) >>> 0
      this.bits = this.bits >> shift
      offset = this.size - 1
    }

    const bit = 1n << BigInt(offset)
    if (this.bits & bit) return 'duplicate'

    this.bits |= bit

    // Trim trailing contiguous bits
    while (this.bits & 1n) {
      this.bits >>= 1n
      this.base = (this.base + 1) >>> 0
    }

    return 'new'
  }
}
```

### 5.2 RESET_SEQ Frame

A new control frame type (`0x09`). Connection-local (stream ID = 0).

**Purpose**: When a per-stream sequence counter approaches the 32-bit limit on a long-lived stream (e.g., SSH session running for weeks), reset the sequence to avoid wrap-around ambiguity.

**Payload** (JSON):
```json
{
  "streams": [8, 15]
}
```

**Sequence reset threshold**: `2³² - 1,000,000`. The sender sends RESET_SEQ, then resets `seqCounters[streamId] = 0`. The receiver clears `dedupWindows[streamId]`.

**Why RESET_SEQ is connection-local**: Each active connection sends it independently (not duplicated across connections). The receiver processes the first arrival and ignores subsequent resets for the same stream (idempotent — window already cleared). This avoids needing to dedup the reset message itself.

**Threshold reasoning**: 32-bit = ~4.3 billion. At 10,000 frames/sec (extreme for a tunnel), that's ~5 days before exhausting. At realistic tunnel traffic (hundreds/sec), it takes months. The 1M threshold provides ample headroom for the exchange to complete.

### 5.3 Memory Management

| When | Action |
|------|--------|
| Stream closed (FIN processed) | Remove `dedupWindows[streamId]` |
| Stream errored (ERROR processed) | Remove `dedupWindows[streamId]` |
| RESET_SEQ received | Remove `dedupWindows[streamId]` for listed streams |
| ConnectionPool destroyed | Clear entire dedupWindows Map |
| Connection closed (not last) | No action (dedup is pool-level) |
| Last connection closed | Destroy pool, clear dedupWindows |

---

## 6. PING/PONG — Per Socket

### 6.1 Design

PING/PONG remains **per-connection**, unchanged from the current implementation. Each `RealSocket` has its own keepalive cycle:

```
Client RealSocket:
  - Sends PING every 3s (CLIENT_PING_INTERVAL)
  - Expects PONG within 10s (CLIENT_PONG_TIMEOUT)
  - Responds to server PINGs with PONG immediately

Server per-connection:
  - Sends PING every 10s (KEEPALIVE_INTERVAL)
  - Expects PONG within 25s (KEEPALIVE_TIMEOUT)
  - Responds to client PINGs with PONG immediately
```

### 6.2 Changes

**None.** PING/PONG frames carry `streamId = 0` and are processed immediately without sequence number assignment or dedup checks. They are connection-local by nature — they test the health of a specific TCP/TLS link.

### 6.3 What Happens When One Connection Times Out

1. The failing connection's `RealSocket` detects the PONG timeout.
2. It destroys its socket and begins reconnection (exponential backoff).
3. The other connections continue operating normally.
4. The VirtualSocket removes the failing socket from its write set.
5. Traffic continues uninterrupted over healthy connections.
6. When the interface returns (or reconnection succeeds), the socket rejoins.

### 6.4 Minimum Connection Requirement

If ALL connections fail simultaneously (rare), the VirtualSocket emits `'error'` and the application-layer reconnection logic takes over (reconnect the VirtualSocket with whatever interfaces are available).

---

## 7. Write Path — Detailed Flow

### 7.1 Client → Server

```
1. Application calls virtualSocket.write(frame)

2. VirtualSocket:
   a. If frame.type in {HEADERS, DATA, FIN, ERROR, UPGRADE}:
        streamId = frame.streamId
        seqCounters[streamId] = (seqCounters[streamId] || 0) + 1
        frame.seqNo = seqCounters[streamId]

        if frame.seqNo > SEQ_RESET_THRESHOLD:
            send RESET_SEQ({ streams: [streamId] })
            seqCounters[streamId] = 0
            frame.seqNo = 0

   b. encoded = encodeFrame(frame)
      writeOk = false
      for each realSocket in activeSockets:
          if realSocket.write(encoded):
              writeOk = true

      if not writeOk:
          emit 'error' on VirtualSocket
```

### 7.2 Server → Client

```
1. HTTP router or WebSocket handler calls pool.send(frame)

2. ConnectionPool:
   a. Same seqNo assignment as client side (including RESET_SEQ threshold)
   b. Duplicate to all connections in pool.connections
   c. If zero connections: error
```

### 7.3 Frame Types Summary

| Frame Type | Client → Server | Server → Client | SeqNo? | Dedup? | Duplicated? |
|-----------|-----------------|-----------------|--------|--------|-------------|
| INIT      | Yes (handshake) | Yes (ACK)       | No (0) | No     | No — connection-local |
| PING      | Yes (keepalive) | Yes (keepalive) | No (0) | No     | No — connection-local |
| PONG      | Yes (response)  | Yes (response)  | No (0) | No     | No — connection-local |
| RESET_SEQ | Yes             | Yes             | No (0) | No     | No — connection-local |
| HEADERS   | Yes (request)   | Yes (response)  | Yes    | Yes    | Yes — to all connections |
| DATA      | Yes             | Yes             | Yes    | Yes    | Yes — to all connections |
| FIN       | Yes             | Yes             | Yes    | Yes    | Yes — to all connections |
| ERROR     | Yes             | Yes             | Yes    | Yes    | Yes — to all connections |
| UPGRADE   | Yes (WebSocket) | Yes (WebSocket) | Yes    | Yes    | Yes — to all connections |

---

## 8. Connection Health & Monitoring

### 8.1 Per-Connection Metrics

Each `RealSocket` (client) / per-connection tracker (server) reports:

| Metric | Description |
|--------|-------------|
| `rtt_avg` | Smoothed round-trip time (PING↔PONG) |
| `bytes_sent` | Bytes written to this socket |
| `bytes_received` | Bytes read from this socket |
| `dup_frames_dropped` | Frames received but dedup'd out |
| `state` | connecting / connected / disconnected / failed |
| `interface` | Which network interface (e.g., `en0`, `en8`) |
| `local_ip` | Bound IP address |

### 8.2 VirtualSocket-Level Metrics

| Metric | Description |
|--------|-------------|
| `active_connections` | Number of healthy RealSockets |
| `total_connections` | Total created (including failed/removed) |
| `interface_changes` | Count of interface add/remove events |

### 8.3 Health Dashboard (Future)

These metrics could be exposed via a debug endpoint or logged periodically for operators to understand multipath performance.

---

## 9. Reconnection Strategy

### 9.1 Current Behavior (to preserve)

The current reconnection logic (`tls-connection.js`) uses exponential backoff:
- Initial delay: 500ms
- Max delay: 3000ms
- Doubles each attempt
- Resets after successful INIT

### 9.2 Multipath Extensions

With multipath, reconnection is **per-RealSocket**, not per-VirtualSocket:

```
RealSocket disconnected
    │
    ├── Temporary failure? (e.g., WiFi blip)
    │   → Exponential backoff reconnect
    │   → If successful: rejoin VirtualSocket
    │
    ├── Interface gone? (e.g., iPhone unplugged)
    │   → InterfaceDetector detects removal
    │   → VirtualSocket removes this socket permanently
    │   → No reconnect attempt (interface is gone)
    │
    └── Auth error? (e.g., cert revoked)
        → Permanent failure
        → VirtualSocket removes this socket
        → Log error
```

### 9.3 Connection Deduplication on the Server

When a client reconnects a RealSocket after a disconnect, the server must handle the case where the old socket for the same interface still exists (half-open connection).

```
New connection arrives, INIT payload includes { interface: "en0" }
    │
    ▼
Check: Is there already a connection with interface === "en0" in pool.connections?
    │
    ├── Yes → Destroy old connection, accept new one
    │
    └──  No → Accept new connection normally
```

The server identifies "same interface" by the `interface` field in the INIT payload. This is reliable across NATs and DHCP IP changes — unlike matching by source IP.

---

## 10. Interface Detection

### 10.1 Connectivity Probe

The primary detection method is a lightweight TCP connect to the tunnel server from each candidate interface. This is reliable and portable across platforms.

```javascript
isInternetCapable(interfaceName, ip):
    socket = new net.Socket()
    socket.connect({
        host: serverHost,
        port: serverPort,
        localAddress: ip,          // bind to this interface
    })
    await race(socket.on('connect'), timeout(2000))
    socket.destroy()
    return connected
```

**Rationale**: Platform-specific routing table parsing (`netstat -rn` on macOS, `ip route` on Linux) is fragile and non-portable. A direct probe to the only server that matters is simple and definitive.

### 10.2 Interface Filtering

Not every interface with an IP is internet-capable. The detector filters in two phases:

**Phase 1 — Quick exclude** (no probe needed):
- Internal interfaces: `lo`, `awdl`, `llw`, `utun*`, `bridge*`, `vmenet*`, `anpi*`
- Self-assigned IPs: `169.254.x.x`
- No IPv4 address: skip

**Phase 2 — Connectivity probe** (async):
- Bind to interface, TCP connect to server
- Cache result for 5s to avoid probe storms
- On failure, interface is excluded until next poll

### 10.3 Platform-Specific Behavior

| OS | WiFi | iPhone USB | Detection Method |
|----|------|------------|-----------------|
| macOS | `en0` | `en8` | Connectivity probe |
| Linux | `wlan0`/`wlp*` | `enp*`/`eth*` (usb) | Connectivity probe |

The probe-based approach means we don't need to know WiFi vs Ethernet naming conventions — any interface that can reach the server passes the test.

### 10.4 Configuration

```yaml
# .deploy.client
MULTIPATH_ENABLED=true
MULTIPATH_INTERFACES=auto          # auto-detect | "en0,en8" (manual list)
MULTIPATH_MIN_CONNECTIONS=1        # min healthy connections before considering "up"
```

---

## 11. INIT Handshake

Each connection performs its own INIT handshake independently. Both server and client use the 13-byte frame protocol.

**Client → Server**:
```json
{
  "maxFrameSize": 1048576,
  "interface": "en0"
}
```

**Server → Client**:
```json
{
  "maxFrameSize": 1048576,
  "maxConcurrentStreams": 100
}
```

**`interface` field** — Identifies which physical interface (e.g., `en0`, `en8`) created this connection. The server uses it to deduplicate reconnections from the same interface (see section 9.3).

The seqNo field in the frame header is always present (0 for INIT, PING, PONG, RESET_SEQ; assigned for data frames).

---

## 12. Error Handling

| Scenario | Behavior |
|----------|----------|
| One RealSocket write fails | Log, continue with other sockets |
| All RealSocket writes fail | Emit `'error'` on VirtualSocket |
| Connection times out (PONG) | Remove that RealSocket, reconnect it |
| Interface removed | Remove RealSocket, no error if others active |
| Last connection lost | Emit `'error'`, application reconnects |
| Server rejects connection (auth) | Remove RealSocket permanently, log |
| Dup frame received | Drop silently, increment metric |
| Sequence gap (shouldn't happen) | Log warning, accept the frame (don't block) |
| Frame decode error | Close that specific connection, others continue |

### 12.1 Error Propagation

RealSocket errors do NOT propagate to the VirtualSocket's application interface unless ALL sockets have failed. This prevents transient single-interface issues from disrupting the application.

---

## 13. Backpressure Handling

### 13.1 Per-Connection Backpressure (Client)

Each `RealSocket` handles its own write backpressure:

```javascript
write(frame):
    encoded = encodeFrame(frame)
    ok = socket.write(encoded)

    if not ok:
        pause pump (don't write more to this socket until 'drain')

    if stalled > BACKPRESSURE_TIMEOUT (8s):
        destroy this socket (it will reconnect)
```

### 13.2 VirtualSocket-Level Backpressure

The VirtualSocket does NOT apply backpressure from individual connection stalls. It delegates writes to each socket independently. If one socket is slow, others continue. The slow socket buffers or drops.

If ALL sockets experience backpressure simultaneously (all connections saturated), the VirtualSocket will emit backpressure to the application layer.

### 13.3 Per-Connection Backpressure (Server)

Same as client: per-socket write pump with 8s stall timeout. If a server-to-client write is stalled on one connection, frames flow through the other connections.

---

## 14. Implementation Plan

### Phase 1: Frame Protocol (no multipath yet)

- [ ] Update `frame-protocol/index.js`: 13-byte header encode/decode with seqNo field.
- [ ] Add RESET_SEQ frame type (`0x09`).
- [ ] All frames carry seqNo (0 for INIT/PING/PONG/RESET_SEQ, assigned for data frames).
- [ ] Tests: encode/decode with seqNo, RESET_SEQ frame.

### Phase 2: RealSocket Extraction (no multipath yet)

- [ ] Extract `tls-connection.js` → `RealSocket` class (reusable, with `localAddress` support).
- [ ] Add `interface` field to INIT payload.
- [ ] Add status event system.
- [ ] Keep same PING/PONG, watchdog, reconnect logic.
- [ ] Tests: RealSocket connects, reconnects, handles keepalive.

### Phase 3: InterfaceDetector

- [ ] Build `InterfaceDetector` class.
- [ ] Extend `network-watchdog.js` to report interface list (not just changes).
- [ ] Implement connectivity probe (TCP connect via each interface to server).
- [ ] Cache probe results (5s TTL).
- [ ] Tests: detect WiFi, detect iPhone USB plug/unplug.

### Phase 4: VirtualSocket (client-side multipath)

- [ ] Build `VirtualSocket` class.
- [ ] Implement `DedupWindow` (sliding window with BigInt bitmask).
- [ ] Implement write duplication + seqNo assignment + RESET_SEQ threshold.
- [ ] Implement read dedup + RESET_SEQ processing.
- [ ] Error on all-socket write failure.
- [ ] Integrate with InterfaceDetector — dynamic add/remove RealSockets.
- [ ] Tests: 2-connection setup, dedup works, interface removal handled.

### Phase 5: Server-Side ConnectionPool

- [ ] Build `ConnectionPool` class (replaces `ClientManager`).
- [ ] Accept multiple connections, keyed by interface name from INIT.
- [ ] Dedup incoming frames (sliding window).
- [ ] Duplicate outgoing frames to all connections + seqNo assignment.
- [ ] Per-connection keepalive (PING/PONG).
- [ ] Tests: multiple connections, dedup, connection failover.

### Phase 6: Integration & E2E

- [ ] Wire everything together in `apps/client/index.js`.
- [ ] E2E tests with both WiFi + iPhone USB (manual testing).
- [ ] Performance benchmarks: single vs multipath latency.
- [ ] Documentation update.

### Phase 7: Observability

- [ ] Per-connection metrics.
- [ ] VirtualSocket-level metrics.
- [ ] Debug logging.

---

## 15. Configuration

### Client `.deploy.client`

```bash
# Multipath
MULTIPATH_ENABLED=true
MULTIPATH_INTERFACES=auto
MULTIPATH_MIN_CONNECTIONS=1

# Existing (unchanged)
SERVER=server.example.com:9443
TARGET=localhost:3000
KEY=.certs/client-key.pem
CERT=.certs/client-cert.pem
CA=.ca/ca-cert.pem
```

### Server `.deploy.server`

```bash
# Multipath support
MULTIPATH_ENABLED=true

# Existing (unchanged)
HTTP_PORT=8080
TLS_PORT=9443
MAX_STREAMS=100
KEEPALIVE_INTERVAL=10000
KEEPALIVE_TIMEOUT=25000
```

---

## 16. Security Considerations

1. **No new trust model**: The multipath layer operates within the existing mTLS envelope. Each connection is individually authenticated. No new cryptographic material or trust models are introduced.

2. **Sequence number injection**: An attacker on the network path could try to inject or replay frames. Since all traffic is TLS-encrypted, frame injection is not possible. Replayed ciphertext would fail TLS sequence validation.

3. **No new attack surface**: The RESET_SEQ frame is just another control frame within the existing mTLS channel. It cannot be triggered by an external party.

---

## 17. Trade-offs & Alternatives Considered

### 17.1 Why Duplicate All Traffic (Not Load-Balance)?

**Duplicate (chosen)**: Every frame goes over every connection. First-arrival wins.
- Pros: Lowest latency (fastest path wins), automatic failover, transparent to application.
- Cons: Wastes bandwidth (2x–4x data usage on metered connections).

**Load-balance**: Distribute streams across connections.
- Pros: Efficient bandwidth usage.
- Cons: Connection-level latency matters per stream; slow connection = slow stream; failover is complex; application might need awareness.

**Decision**: The primary use case is **reliability + low latency** during network transitions (WiFi ↔ cellular). Duplication achieves this with simple logic. Bandwidth waste is acceptable for the tunnel control/data plane (typically low volume).

### 17.2 Why SeqNo in Header (Not in Payload Envelope)?

**Header (chosen)**: 13-byte fixed header.
- Pros: Single pass parsing, no wrapping/unwrapping, consistent for all frame types.
- Cons: 4-byte overhead per frame.

**Payload envelope**: Wrap frame with VirtualSocket-specific header.
- Pros: No frame protocol change.
- Cons: Double encode/decode, harder to reason about, seqNo not visible at frame decoder level.

**Decision**: The frame protocol change is minimal (4 bytes). The simplicity of having seqNo in the native frame header outweighs the overhead.

### 17.3 Why Not MPTCP / QUIC?

- MPTCP requires kernel support and protocol-level adoption. Not available in `node:tls`.
- QUIC multipath is experimental and not available in Node.js built-ins.
- Building a userspace multipath layer on top of `node:tls` is simpler, portable, and fits the "zero dependencies" philosophy.

---

## 18. Future Enhancements

1. **Smart duplication**: Only duplicate when RTT of the primary connection exceeds a threshold. Save bandwidth when primary is fast enough.

2. **Per-stream interface preference**: Certain streams (e.g., large uploads) could prefer high-bandwidth interfaces; latency-sensitive streams prefer low-RTT interfaces.

3. **Connection scoring**: Weight connections by RTT, jitter, packet loss. Dynamically promote/demote connections.

4. **Bandwidth aggregation**: Striping data across connections for throughput (beyond the current duplication model).

5. **Web UI for connection health**: Real-time dashboard showing all connections, their metrics, and dedup statistics.

---

## Appendix A: Comparison with Existing Designs

| Aspect | `05-multi-connection-pooling*` | `09-multipath-virtual-socket` |
|--------|-------------------------------|-------------------------------|
| Goal | Load distribution / parallelism | Reliability / latency reduction |
| Strategy | Partition streams across connections | Duplicate all frames across connections |
| Stream IDs | Per-connection scope (simplest) | Global scope per server instance |
| Failover | Stream must be retried on another connection | Automatic — duplicate already in flight |
| Bandwidth | Efficient (no duplication) | Wastes bandwidth (2x–4x) |
| Complexity | Moderate to high | Moderate (dedup + duplication + RESET_SEQ) |
| Application awareness | Transparent | Transparent |
| Server side | Multi-client sessions | Single client, connection pool |
