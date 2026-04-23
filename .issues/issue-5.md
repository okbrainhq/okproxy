# buildMaskedWebSocketFrame references undefined crypto

**Severity:** Bug (currently latent)
**Location:** `packages/frame-protocol/websocket.js:116`

No `require('node:crypto')` at top of file; would throw `ReferenceError` on first call.

The module is also not imported anywhere — it's dead code right now.
