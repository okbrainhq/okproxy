# No RSV bit validation

**Severity:** Hardening
**Location:** `apps/server/lib/http-router.js:131`, `apps/client/lib/proxy.js:476`

RFC 6455 Section 5.2 requires RSV1, RSV2, RSV3 bits to be 0 unless an extension is negotiated that uses them. Frames with non-zero RSV bits and no negotiated extension MUST be rejected with close code 1002 (protocol error).

Currently both `parseWebSocketFrame` implementations extract only the opcode (`buffer[0] & 0x0f`) and FIN bit, ignoring the RSV bits entirely. Malformed or malicious frames with non-zero RSV bits are silently forwarded through the tunnel.

**Fix:** Check `(buffer[0] & 0x70) !== 0` in `parseWebSocketFrame`. If set, either drop the frame and send close code 1002, or at minimum strip the RSV bits.
