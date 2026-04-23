# Unbounded buffer growth

**Severity:** Critical
**Location:** `apps/server/lib/http-router.js:487` and `apps/client/lib/proxy.js:221`

`wsBuffer = Buffer.concat([wsBuffer, chunk])` with no cap. A peer that sends a frame header claiming huge payload but dribbles bytes will grow the buffer until OOM, and the repeated `concat` is O(n²).

**Fix:** Cap per-stream buffered bytes and reject on overflow.
