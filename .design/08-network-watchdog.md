# Design: Network WatchDog (Network Interface Change Detection)

## Overview

A fast network change detection mechanism for the tunnel client that monitors active network interfaces via `os.networkInterfaces()` and immediately destroys the TLS connection when the network topology changes. This eliminates the 30-35 second delay currently experienced when WiFi drops and macOS switches to iPhone USB tethering.

**Target Platform:** All platforms (Node.js `os.networkInterfaces()` is cross-platform)  
**Detection Latency:** <500ms  
**Trigger Action:** Immediate socket destruction + automatic reconnection  
**Approach:** Zero process spawns — pure JS fingerprint comparison

---

## Problem Statement

### Current Behavior (Keepalive-Based Detection)

When WiFi connection drops and macOS automatically switches to iPhone USB:

1. **T+0s:** WiFi disconnects, TCP socket bound to `en0` starts blackholing packets
2. **T+0-35s:** macOS promotes iPhone USB (`en8`) as default route, traffic flows via mobile
3. **T+35s:** Client watchdog timeout (35s) fires, detects dead connection
4. **T+35.5s:** Client destroys socket and reconnects
5. **T+36s:** New connection established via `en8`

**Result:** 35+ seconds of failed requests, 502 errors for all in-flight streams.

### Why Keepalive-Based Detection Is Slow

| Mechanism | Interval | Timeout | Total Detection |
|-----------|----------|---------|-----------------|
| Server PING/PONG | 10s | 25s | 35s |
| Client watchdog | - | 35s | 35s |

TCP sockets don't receive OS notifications when the underlying interface changes. The socket stays "open" but silently fails to route packets until TCP retransmissions eventually timeout.

---

## Solution: Interface Fingerprint Polling

Monitor the system's active network interfaces using `os.networkInterfaces()` and compare a fingerprint of active interfaces on each poll. When the fingerprint changes, destroy the socket — the reconnection will bind to whatever the OS's current default route is.

### Why `os.networkInterfaces()` (Not `route`)

The original design used `route -n get default` via `child_process.exec`. This required:
- 3 process spawns per poll (sh + route + grep)
- At 200ms intervals: ~15 process spawns/second
- Constant CPU wake-ups, preventing deep idle on battery-powered MacBooks

`os.networkInterfaces()` is:
- A **pure JS call** — zero process spawns, zero overhead
- **Cross-platform** — works on macOS, Linux, and Windows identically
- **Fast** — sub-millisecond, no I/O syscall chain
- **Sufficient** — we don't need to know which interface is the default route. We just need to know the topology changed. The OS handles routing for the new socket.

### Fingerprint Strategy

Build a sorted string of `interfaceName:ipv4Address` for all active non-internal interfaces:

```
Before (WiFi):      "en0:192.168.0.105"
After (USB):        "en8:172.20.10.2"
```

When these differ, the network changed. Destroy socket, reconnect.

### Detection Latency Breakdown

| Phase | Time |
|-------|------|
| WiFi disconnect detected by macOS | 0-100ms |
| macOS switches default route to USB | 100-200ms |
| Our 200ms poll catches the change | 200-400ms |
| Socket destroy + reconnect initiated | 400-500ms |
| New connection via USB established | 800-1200ms |

**Total outage:** ~1 second vs. 35 seconds with keepalives.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TLS Connection (apps/client)              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐     ┌──────────────────┐                 │
│  │  TLS Socket  │◄────│  Network WatchDog  │                 │
│  │  (en0 bound) │     │  (fingerprint poll)│                 │
│  └──────────────┘     └────────────────────┘                 │
│         │                       │                            │
│         │  destroy()            │                            │
│         │◄──────────────────────┘                            │
│         │                                                    │
│  ┌──────▼──────┐     ┌─────────────────┐                   │
│  │ Reconnect   │────►│  New TLS Socket  │                   │
│  │  (500ms-3s) │     │  (en8 bound)     │                   │
│  └─────────────┘     └─────────────────┘                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                    │
          ┌─────────▼──────────┐
          │  os.networkInterfaces() │
          │  (pure JS, zero cost)   │
          └─────────────────────────┘
```

### Component Placement

```
apps/client/
├── index.js                    # Entry point (creates TLS connection)
├── lib/
│   ├── tls-connection.js        # Existing: TLS connection with reconnection
│   ├── proxy.js                 # Existing: HTTP proxy to local target
│   └── network-watchdog.js      # NEW: Interface change detection
```

The WatchDog is instantiated alongside the TLS connection and monitors independently. When fingerprint changes, it calls `connection.destroy()` which triggers the existing reconnection logic.

---

## Implementation Design

### Fingerprint Function

```javascript
const os = require('os');

function getNetworkFingerprint() {
  const ifaces = os.networkInterfaces();
  const active = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    const ipv4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (ipv4) {
      active.push(`${name}:${ipv4.address}`);
    }
  }
  active.sort();
  return active.join(',');
}
```

**What it captures:**
- All non-internal interfaces with an IPv4 address
- Both interface name and IP address (so we detect IP renewals too)
- Sorted for deterministic comparison

**Example fingerprints:**

```
WiFi only:                    "en0:192.168.0.105"
WiFi + USB tethering:         "en0:192.168.0.105,en8:172.20.10.2"
USB only (WiFi dropped):      "en8:172.20.10.2"
VPN active:                   "en0:192.168.0.105,utun0:10.8.0.1"
No network:                   ""
```

### WatchDog Logic

```javascript
class NetworkWatchDog {
  constructor(onChange, options = {}) {
    this.pollInterval = options.pollInterval || 200;
    this.onChange = onChange;
    this.lastFingerprint = null;
    this.lastFingerprintDetail = null;
    this.timer = null;
    this.running = false;
    this.pollCount = 0;
  }

  _log(msg) {
    console.log(`[network-watchdog] [${new Date().toISOString()}] ${msg}`);
  }

  _getDetail() {
    const ifaces = os.networkInterfaces();
    const details = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) {
          details.push({ name, address: a.address, netmask: a.netmask });
        }
      }
    }
    return details;
  }

  check() {
    this.pollCount++;
    const fp = getNetworkFingerprint();
    const detail = this._getDetail();

    if (this.pollCount % 30 === 0) {
      this._log(`periodic status: poll#${this.pollCount} fingerprint="${fp}" interfaces=${JSON.stringify(detail)}`);
    }

    if (this.lastFingerprint !== null && fp !== this.lastFingerprint) {
      this._log(`NETWORK CHANGE DETECTED`);
      this._log(`  previous fingerprint: "${this.lastFingerprint}"`);
      this._log(`  current  fingerprint: "${fp}"`);
      this._log(`  previous interfaces: ${JSON.stringify(this.lastFingerprintDetail)}`);
      this._log(`  current  interfaces: ${JSON.stringify(detail)}`);
      this._log(`  poll #${this.pollCount}, interval=${this.pollInterval}ms`);
      this._log(`  triggering socket destroy for reconnection`);

      this.lastFingerprint = fp;
      this.lastFingerprintDetail = detail;
      this.onChange();
      return;
    }

    if (this.pollCount === 1) {
      this._log(`initial fingerprint: "${fp}" interfaces=${JSON.stringify(detail)}`);
    }

    this.lastFingerprint = fp;
    this.lastFingerprintDetail = detail;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.pollCount = 0;

    this._log(`starting network watchdog (interval=${this.pollInterval}ms)`);

    this.check();
    this.timer = setInterval(() => this.check(), this.pollInterval);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._log(`stopping network watchdog after ${this.pollCount} polls`);

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

### Integration with TLS Connection

```javascript
// In tls-connection.js
const { NetworkWatchDog } = require('./network-watchdog');

function createTLSConnection(config, onFrame, onConnect, onDisconnect) {
  // ... existing connection setup ...

  const watchdog = new NetworkWatchDog(
    () => {
      console.log(`[${new Date().toISOString()}] watchdog: destroying connection due to network change`);
      socket.destroy();
    },
    { pollInterval: 200 }
  );

  socket.on('connect', () => {
    console.log(`[${new Date().toISOString()}] tls: connected, starting network watchdog`);
    watchdog.start();
  });

  socket.on('close', () => {
    console.log(`[${new Date().toISOString()}] tls: connection closed, stopping network watchdog`);
    watchdog.stop();
    // ... existing close handling ...
  });

  // ... rest of existing connection logic ...
}
```

### Logging Strategy

The watchdog logs aggressively so we can diagnose issues from user logs:

| Event | Log Level | When |
|-------|-----------|------|
| Watchdog start | info | On connect |
| Watchdog stop | info | On disconnect |
| Initial fingerprint | info | First poll after start |
| Network change detected | info (multi-line) | Fingerprint differs |
| Periodic heartbeat | info | Every 30 polls (~30s) |
| Socket destroy triggered | info | In onChange callback |

**Logged data on change:**
- Previous and current fingerprint strings
- Previous and current interface details (name, IP, netmask)
- Poll number and interval
- Timestamp

**Why not just log on change:** The periodic heartbeat (every 30s) proves the watchdog is alive even when nothing happens. Without it, silence could mean either "no changes" or "watchdog crashed silently."

---

## Edge Cases & Handling

### Case 1: WiFi Briefly Flaps (Comes Back Quickly)

```
T=0:    fingerprint="en0:192.168.0.105"
T=1000: fingerprint="en8:172.20.10.2"  (WiFi dropped, USB took over)
T=2000: fingerprint="en0:192.168.0.105"  (WiFi reconnected)
```

**Result:** Two triggers. First destroys socket and reconnects via USB. Second destroys again and reconnects via WiFi. Two brief reconnects (~2s each) vs. 35s outage. Acceptable tradeoff.

### Case 2: WiFi Dies, USB Takes Over Permanently

```
T=0:    fingerprint="en0:192.168.0.105"
T=1000: fingerprint="en8:172.20.10.2"  → TRIGGER destroy
```

**Result:** Socket destroyed at T=1000, reconnection via USB begins. Clean.

### Case 3: VPN Connection Added/Removed

```
T=0:    fingerprint="en0:192.168.0.105"
T=1000: fingerprint="en0:192.168.0.105,utun0:10.8.0.1"  → TRIGGER
```

**Result:** Trigger fires, connection rebinds via VPN. This is correct — the tunnel should use the VPN interface if it's the system default.

### Case 4: No Interface Available (Offline)

```
T=0:    fingerprint="en0:192.168.0.105"
T=1000: fingerprint=""  → TRIGGER (all interfaces went down)
```

**Result:** Trigger fires, socket destroyed. Reconnection will fail and retry per existing backoff logic. Keepalive won't help here either.

### Case 5: Initial Connection (No Previous Fingerprint)

```
T=0: lastFingerprint=null
T=0: fingerprint="en0:192.168.0.105"
```

**Result:** No trigger (null check prevents false trigger on first poll). Clean startup.

### Case 6: IP Address Renewal (DHCP)

```
T=0:    fingerprint="en0:192.168.0.105"
T=1000: fingerprint="en0:192.168.0.200"  → TRIGGER
```

**Result:** Trigger fires. Slightly aggressive but safe — if the IP changed, existing socket may have routing issues. Better to reconnect than risk silent failure.

### Case 7: Multiple Active Interfaces (WiFi + Ethernet)

```
T=0:    fingerprint="en0:192.168.0.105,en5:10.0.0.50"
T=1000: fingerprint="en5:10.0.0.50"  (WiFi dropped, Ethernet stays)
```

**Result:** Trigger fires, reconnects. The new socket binds via Ethernet (still up). This is correct behavior.

---

## Safety Considerations

### No Process Spawning

Unlike the previous `route -n get default` approach, `os.networkInterfaces()` is a synchronous V8/Node.js builtin:
- Zero process spawns
- Zero file descriptor consumption
- Zero child process management
- Sub-millisecond execution
- No battery impact from constant CPU wake-ups

### Race Conditions

**Scenario:** Interface changes while frame is being written.

```javascript
socket.write(encodeFrame(...));
socket.destroy();  // WatchDog callback
```

**Handling:** Node.js is single-threaded. The write either completes before destroy() is called, or destroy() interrupts it. Both are handled by existing error handling in `tls-connection.js`.

### Simultaneous Keepalive Timeout

If interface change and keepalive timeout fire simultaneously:

```javascript
socket.destroy();  // WatchDog
socket.destroy();  // Keepalive (no-op, already destroying)
```

**Result:** Idempotent, safe.

### False Positive Cost

The main tradeoff vs. the `route`-based approach: we detect **any** interface change, not just default route changes. This means occasional unnecessary reconnects (e.g., a secondary interface going down). Cost of a false positive: ~2s reconnect. Cost of a false negative: 35s outage. Clear tradeoff in favor of sensitivity.

---

## Fallback Strategy

Since `os.networkInterfaces()` is a Node.js builtin, it cannot fail or be missing. Edge cases:

1. **Empty fingerprint (no interfaces):** Could mean offline or unusual config. Log it, still trigger — reconnect logic handles offline gracefully.
2. **Rapid fingerprint changes:** Multiple triggers in quick succession. Each triggers a destroy + reconnect. The existing reconnection backoff handles this — won't create a tight loop.
3. **Laptop sleep/wake:** After wake, the next poll detects the changed fingerprint. Works naturally.

The keepalive watchdog (35s) remains as a safety net even with the Network WatchDog enabled.

---

## Configuration Options

```javascript
const DEFAULTS = {
  pollInterval: 200,           // How often to compare fingerprints (ms)
  enabled: true,               // Can disable if causing issues
  fallbackToKeepalive: true    // Always keep keepalive as backup
};
```

**CLI/Env overrides:**
```bash
# Disable watchdog, rely on keepalives only
TUNZERO_NETWORK_WATCHDOG=false

# Slower polling (less sensitive, less reconnect churn — still zero process spawns)
TUNZERO_NETWORK_WATCHDOG_INTERVAL=1000

# Faster polling (more sensitive)
TUNZERO_NETWORK_WATCHDOG_INTERVAL=100
```

Note: No debounce config needed. The `os.networkInterfaces()` fingerprint is stable — no flapping from route table churn. Each poll is a clean snapshot.

---

## Testing Strategy

### Unit Test: Fingerprint Generation

```javascript
// Mock os.networkInterfaces
const mockIfaces = {
  lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  en0: [{ family: 'IPv4', address: '192.168.0.105', internal: false }],
};
assert.strictEqual(getNetworkFingerprint(mockIfaces), 'en0:192.168.0.105');
```

### Unit Test: Fingerprint Change Detection

```javascript
const watchdog = new NetworkWatchDog(onChange, { pollInterval: 100 });
watchdog.lastFingerprint = 'en0:192.168.0.105';

// Simulate change
mockIfaces.en0 = [];
mockIfaces.en8 = [{ family: 'IPv4', address: '172.20.10.2', internal: false }];
watchdog.check();
assert.strictEqual(triggered, true);
```

### Unit Test: No Change → No Trigger

```javascript
watchdog.lastFingerprint = 'en0:192.168.0.105';
watchdog.check();  // Same interfaces
assert.strictEqual(triggered, false);
```

### Unit Test: Null Initial State

```javascript
watchdog.lastFingerprint = null;
watchdog.check();  // First poll
assert.strictEqual(triggered, false);  // No trigger on first poll
```

### Integration Test: Interface Change Simulation

```javascript
let mockInterface = 'en0';
watchdog.start();

await sleep(100);
assert.strictEqual(triggered, false);

mockInterface = 'en8';
await sleep(1200);
assert.strictEqual(connectionDestroyed, true);
```

### Manual Test: Real WiFi/USB Switch

1. Connect client via WiFi
2. Verify log: `initial fingerprint: "en0:192.168.0.105" interfaces=[{"name":"en0","address":"192.168.0.105",...}]`
3. Disable WiFi (turn off from menu bar)
4. Verify iPhone USB is connected
5. Observe logs:
   ```
   [network-watchdog] NETWORK CHANGE DETECTED
   [network-watchdog]   previous fingerprint: "en0:192.168.0.105"
   [network-watchdog]   current  fingerprint: "en8:172.20.10.2"
   [network-watchdog]   previous interfaces: [{"name":"en0","address":"192.168.0.105","netmask":"255.255.255.0"}]
   [network-watchdog]   current  interfaces: [{"name":"en8","address":"172.20.10.2","netmask":"255.255.255.240"}]
   [network-watchdog]   poll #5, interval=1000ms
   [network-watchdog]   triggering socket destroy for reconnection
   ```
6. Verify socket destroyed and reconnected via USB
7. Re-enable WiFi
8. Verify switch back to en0 logged and reconnected
9. Wait 30s, verify periodic heartbeat log appears

---

## Verification Checklist

- [ ] `os.networkInterfaces()` returns correct interfaces on macOS
- [ ] `getNetworkFingerprint()` produces sorted, deterministic fingerprints
- [ ] WatchDog polls at configured interval (200ms default)
- [ ] First poll after start does NOT trigger (null check)
- [ ] On fingerprint change, `onChange()` callback fires
- [ ] Callback destroys TLS socket immediately
- [ ] Existing reconnection logic creates new socket
- [ ] New socket binds to current default route automatically
- [ ] Keepalive watchdog remains as fallback
- [ ] Zero CPU overhead when idle (<0.1% CPU)
- [ ] Aggressive logging: start, stop, change, periodic heartbeat all logged
- [ ] Change logs include previous/current fingerprints and interface details
- [ ] Manual test: WiFi → USB switch detected in ~1-2s
- [ ] Manual test: USB → WiFi switch detected correctly
- [ ] Manual test: VPN connect/disconnect detected correctly
- [ ] Manual test: Laptop sleep/wake triggers correct reconnect

---

## Migration from Keepalive-Only

**Phase 1 (Current):** Aggressive keepalives (2s/3s) - fast but unreliable  
**Phase 2 (This design):** Network WatchDog + moderate keepalives (10s/25s)  
**Phase 3 (Future):** QUIC connection migration (no disconnect needed)

With Network WatchDog deployed, keepalive intervals can be relaxed back to original values (10s/25s) since they only serve as a backup. This eliminates the false-disconnect risk while maintaining fast failover.

---

## Summary

| Approach | Detection Time | Process Spawns | Reliability | Complexity |
|----------|---------------|----------------|-------------|------------|
| Keepalive only (35s) | 35s | 0 | High (but slow) | Low |
| Aggressive keepalive (2s/3s) | 3-5s | 0 | Low (false triggers) | Low |
| Route polling (200ms) | <500ms | 15/sec | High | Medium |
| **os.networkInterfaces() polling** | **<500ms** | **0** | **High** | **Low** |
| QUIC connection migration | 0s (seamless) | 0 | High | High |

**`os.networkInterfaces()` polling** is the sweet spot: zero overhead, cross-platform, detects changes fast enough (~1-2s vs 35s), with aggressive logging for production debugging.
