# Tunnel-wide kill switch: WS frames > 1 MB

**Severity:** Critical
**Location:** `packages/frame-protocol/index.js:4,65`

Raw WS frames are forwarded inside a single `FrameType.DATA` (`proxy.js:235`, `http-router.js:502`). `MAX_FRAME_SIZE` is 1 MB, and the receiving decoder treats oversize as a fatal protocol error (`destroyed = true`, buffer cleared, `onError` → `socket.destroy()`).

A single large WS message — deliberately crafted, or a large binary push — tears down the entire TLS tunnel and every other concurrent HTTP/WS stream with it.

**Fix:** Either fragment WS frames across multiple DATA frames, or negotiate a per-stream size policy.
