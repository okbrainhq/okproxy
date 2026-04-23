# No control frame rules enforcement

**Severity:** Hardening
**Location:** Both `parseWebSocketFrame` functions in `http-router.js:128` and `proxy.js:473`

RFC 6455 Section 5.5 requires:
1. Control frames (opcodes 0x08 close, 0x09 ping, 0x0A pong) MUST have FIN=1 (must not be fragmented)
2. Control frame payload MUST be ≤125 bytes (cannot use extended length encoding)

Neither rule is validated. A malicious client could send:
- A fragmented ping (FIN=0) that confuses the reassembly logic
- A ping/close frame with a multi-MB payload to abuse buffer allocation

**Fix:** When opcode is 0x08, 0x09, or 0x0A, check that `fin === true` and `payloadLen <= 125`. Violations should close with code 1002.
