# 10 — Interface Detector Stabilization

## Problem

**Poll interval:** 2000ms (2 seconds), set in `interface-detector.js:39`.

The `InterfaceDetector` in `09-multipath-virtual-socket` causes a cascade of
connect/remove cycles for perfectly healthy RealSockets. Log evidence (note
missing timestamps on `[virtual-socket]` lines — part of the observability gap):

```
[en8] PING → PONG ✓
[en0] PING → PONG ✓
[virtual-socket] Removing interface: en0       ← no timestamp, no debounce
[virtual-socket] Removing interface: en8
[virtual-socket] Interface en8 connected
[virtual-socket] Removing interface: en8       ← loop repeats
[virtual-socket] Interface en8 connected
[virtual-socket] Removing interface: en8
... (many cycles) ...
```

Both sockets are torn down simultaneously even though PING/PONG was succeeding.

---

## Root Causes (three compounding issues)

### 1. No debounce — single probe failure kills the socket

`_probe()` (interface-detector.js:95) opens a raw TCP connect to the TLS server
port with a 2s idle timeout as a connect timeout. On transient failure (network
hiccup, server congestion, iPhone USB latency spike), `this.cache.delete(name)`
fires. Then `_poll()`'s `Promise.all().then()` excludes that interface from
`active`, emits `'change'`, and `_syncInterfaces()` calls `rs.destroy()`.

A single failed probe immediately tears down a socket that may still have
working PING/PONG traffic.

### 2. Concurrent `_poll()` calls race on `this.cache`

`setInterval` fires `_poll()` every 2s. `_poll()` is async (`Promise.all`). If
probes take >2s (conceivable for 2s-timeout probes), multiple polls run
simultaneously, racing to write `this.cache`. Poll-1's probe might succeed and
cache the entry, then Poll-2's probe deletes it because it timed out — creating
oscillation even without real network issues.

### 3. 2s probe timeout is tight

iPhone USB (`en8`) over cellular has higher/variable latency. 2s is marginal
for an initial TCP SYN→SYN-ACK round-trip on a tethered connection. A single
slow poll → removal → recreation → repeats.

### Why both are removed simultaneously

The cache TTL (5s) is longer than the poll interval (2s). Every 2–3 polls the
cache expires and all probes fire at once. When they all fail (timeout), all
interfaces drop from `active` simultaneously — producing the log pattern where
both en0 and en8 are removed at the same time.

---

## Fixes

### Fix 1: Serialize `_poll()` — prevent overlapping invocations

Add a `_polling` guard flag. If a poll is already in-flight, skip the scheduled
tick. This eliminates the race condition on `this.cache`.

```js
_poll() {
    if (this._polling) return;
    this._polling = true;

    // ... existing logic ...

    Promise.all(probes).then(() => {
      // ... existing logic ...
    }).finally(() => {
      this._polling = false;
    });
}
```

### Fix 2: Require N consecutive failures before removal

Replace `_syncInterfaces`' immediate `rs.destroy()` with a failure counter.
Only destroy after `N = 3` consecutive polls where the interface is missing from
`active`. A single successful poll (interface re-appears) resets the counter.

Add a `_failureCount` map in `VirtualSocket`:

```js
_syncInterfaces(interfaces) {
    const activeNames = new Set(interfaces.map(i => i.name));

    for (const [name, rs] of this.realSockets) {
      if (name === 'default') continue;
      if (!activeNames.has(name)) {
        const fails = (this._failureCount.get(name) || 0) + 1;
        this._failureCount.set(name, fails);
        if (fails >= 3) {
          console.log(`[virtual-socket] Removing interface: ${name}`);
          rs.destroy();
          this.realSockets.delete(name);
          this._failureCount.delete(name);
        }
      } else {
        this._failureCount.delete(name); // reset on re-appearance
      }
    }
    // ...
}
```

### Fix 3: Increase probe timeout to 5s

Change default `probeTimeout` from 2000ms to 5000ms. Paired with Fix 2, even 5s
is safe — a single slow probe won't cause removal.

### Fix 4: Add ISO timestamps to all client-side log lines

Several `console.log` calls lack timestamps, making it hard to correlate events
during debugging. Add `${new Date().toISOString()} ` prefix to every
client-side log line.

**Files and lines affected:**

| File | Line(s) | Log message |
|------|---------|-------------|
| `apps/client/lib/virtual-socket.js` | 52 | `network change detected, reconnecting` |
| `apps/client/lib/virtual-socket.js` | 68 | `Removing interface: ${name}` |
| `apps/client/lib/real-socket.js` | 84 | `Connection timeout ${...}` |
| `apps/client/lib/real-socket.js` | 115 | `INIT response timeout ${...}` |
| `apps/client/lib/real-socket.js` | 140 | `Reconnected after ${...}` |
| `apps/client/lib/real-socket.js` | 214 | `Reconnect attempt #${...}` |
| `apps/client/lib/real-socket.js` | 229 | `watchdog: no activity for ${...}` |
| `apps/client/lib/real-socket.js` | 249 | `backpressure: socket not drained` |
| `apps/client/lib/real-socket.js` | 255 | `keepalive: no PONG for ${...}` |
| `apps/client/index.js` | 108 | `Interface ${interfaceName} connected` |

Lines 162, 167, 260 in `real-socket.js` already have timestamps — use as
template.

### Fix 5: Use `socket.connect()`'s dedicated connect timeout (optional / bonus)

`net.Socket` has no built-in connect timeout — `setTimeout()` acts as idle
timeout which happens to approximate connect timeout. A cleaner alternative is
to use a separate `setTimeout` + clear in the connect handler, but fix 1 + 2
make this low priority.

---

## Implementation Plan

| Step | File | Change |
|------|------|--------|
| 1 | `apps/client/lib/interface-detector.js` | Add `_polling` guard to `_poll()` |
| 2 | `apps/client/lib/interface-detector.js` | Change `probeTimeout` default from 2000ms to 5000ms |
| 3 | `apps/client/lib/virtual-socket.js` | Add `_failureCount` map, debounce removal in `_syncInterfaces()` (require N=3) |
| 4 | `apps/client/lib/virtual-socket.js` | Reset `_failureCount` for an interface on re-appearance |
| 5 | `apps/client/lib/virtual-socket.js` | Add ISO timestamps to lines 52, 68 |
| 6 | `apps/client/lib/real-socket.js` | Add ISO timestamps to lines 84, 115, 140, 214, 229, 249, 255 |
| 7 | `apps/client/index.js` | Add ISO timestamp to line 108 |

### Behavior after fix

```
Poll 1: probe fails for en8 → failureCount[en8] = 1 (socket stays alive)
Poll 2: probe fails for en8 → failureCount[en8] = 2 (socket stays alive)
Poll 3: probe fails for en8 → failureCount[en8] = 3 → destroy socket
```

If at any point en8 re-appears in `active` before reaching 3, the counter resets
to 0. Real network removal takes ~6s (3 polls × 2s) to detect — acceptable.

---

## What This Does NOT Change

- `RealSocket` internal reconnect logic (unchanged)
- Server-side `ConnectionPool` (unchanged)
- Dedup logic (unchanged)
- PING/PONG timing (unchanged)
- `_probe()` itself (unchanged — only the reaction to its output changes)
- The `cache.delete()` on probe failure stays — it only means "try again next poll"

### Rationale for keeping `cache.delete()` on failure

The cache deletion on failure is useful: it forces a real probe next poll
instead of serving a stale success cache. The problem was never the cache
eviction — it was the immediate destructive reaction to a single failure.
