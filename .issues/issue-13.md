# No reserved opcode validation

**Severity:** Hardening
**Location:** `apps/server/lib/http-router.js:132`, `apps/client/lib/proxy.js:477`

RFC 6455 Section 10.3 reserves opcode values 3-7 and 11-15. If an endpoint receives a frame with a reserved opcode, it MUST close the connection with code 1002.

Neither parser validates opcodes. Reserved opcodes are forwarded as raw bytes through the tunnel, potentially confusing the target server or browser.

**Fix:** After extracting `opcode = buffer[0] & 0x0f`, check if opcode is in the reserved ranges (3-7, 11-15) and close the connection with code 1002.
