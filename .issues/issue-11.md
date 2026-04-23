# packages/frame-protocol/websocket.js is unused

**Severity:** Code hygiene
**Location:** `packages/frame-protocol/websocket.js`

Both `apps/client/lib/proxy.js` and `apps/server/lib/http-router.js` carry their own near-identical copies of `parseWebSocketFrame`/`buildWebSocketFrame`.

**Fix:** Either delete the shared module or switch the two callers to it (and fix bug #4 once).
