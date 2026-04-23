# Server crash on malformed frame

**Severity:** Critical
**Location:** `apps/server/lib/http-router.js:132`

When a browser sends a 64-bit length frame with the high 32 bits set, `parseWebSocketFrame` throws `'Payload too large (>4GB)'` synchronously inside `socket.on('data')`. There is no try/catch around the parser call (line 492), so it propagates as an `uncaughtException`.

The client-side twin at `apps/client/lib/proxy.js:408` handles the same case with `return null` — the two implementations disagree.

**Fix:** Either wrap the call in try/catch or make both return null.
