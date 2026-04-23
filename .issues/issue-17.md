# No close frame payload validation

**Severity:** Hardening
**Location:** Both `parseWebSocketFrame` functions

RFC 6455 Section 5.5.1 requires:
- The first 2 bytes of a close frame payload MUST be an unsigned big-endian status code
- Status codes in the range 0-999, 1004-1006, 1014, 1015, and 1016-2999 are reserved and MUST NOT be used
- Any body after the status code MUST be valid UTF-8

Neither parser validates close frame payloads. A malformed close frame with an invalid status code or non-UTF-8 body is forwarded through the tunnel.

**Fix:** When opcode === 0x08, validate: payload is either empty, exactly 2 bytes (status code only), or 2+ bytes where first 2 are a valid status code and remaining bytes are valid UTF-8. Invalid payloads should close with code 1002.
