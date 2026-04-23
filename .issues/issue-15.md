# No masking validation

**Severity:** Hardening
**Location:** Both `parseWebSocketFrame` functions

RFC 6455 Section 5.3 requires:
- All frames from client to server MUST be masked (mask bit = 1)
- All frames from server to client MUST NOT be masked (mask bit = 0)

The proxy forwards raw bytes and never validates masking rules. An attacker could:
- Send unmasked frames through the tunnel to the target server (violating client→server rule)
- Forward masked frames from the target to the browser (violating server→client rule)

Some WebSocket servers reject unmasked frames, but others (older implementations) may accept them, creating an attack vector.

**Fix:** In the server's browser→target path, validate that frames from the browser have mask bit set. In the client's target→browser path (server frames should be unmasked), validate mask bit is 0. Close with code 1002 on violation.
