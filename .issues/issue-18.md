# No WebSocket version or key validation on upgrade

**Severity:** Hardening
**Location:** `apps/server/lib/http-router.js:414-419`

RFC 6455 requires the server to verify:
1. `Sec-WebSocket-Version: 13` (the only defined version)
2. `Sec-WebSocket-Key` is present and is a 16-byte base64-encoded value
3. The `Upgrade` header contains "websocket"
4. The `Connection` header contains "upgrade"

The server only checks `upgrade === 'websocket'` and `connection.includes('upgrade')` in `isWebSocketUpgrade()`. It doesn't validate the version or key. Non-standard or outdated WebSocket handshakes are accepted and forwarded to the target.

**Fix:** In the upgrade handler, validate `Sec-WebSocket-Version === '13'` and reject with 400 if missing/wrong. Optionally validate `Sec-WebSocket-Key` format. The `isWebSocketUpgrade` check covers upgrade/connection headers already.
