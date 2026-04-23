# No fragmentation state tracking

**Severity:** Hardening
**Location:** Both files, all WS frame parsing loops

RFC 6455 Section 5.4 requires:
- Only data frames (opcode 0 continuation, 1 text, 2 binary) can be fragmented
- A fragmented message starts with opcode 1 or 2, followed by zero or more continuation frames (opcode 0), ending with a FIN=1 continuation
- Control frames may appear between fragments but must themselves be unfragmented
- A non-zero data opcode appearing mid-fragment is a protocol error

Neither the server nor client tracks fragment state. Invalid frame sequences (e.g., two text frames without FIN, or a continuation frame with no preceding data frame) are forwarded silently.

**Fix:** Track `fragmentOpcode` state per connection. On receiving a data frame with non-zero opcode, verify no fragment is in progress. On continuation frame, verify a fragment is in progress. On FIN+non-zero opcode, verify no fragment is in progress. Violations close with code 1002.
