# Non-101 upgrade response silently drops the browser

**Severity:** Design / hardening
**Location:** `apps/server/lib/http-router.js:440-444`

If the target returns 4xx/5xx to the upgrade, we just `cleanup()` (destroys the socket). The browser sees a raw TCP close with no HTTP status.

**Fix:** Forward the actual status/headers so clients can distinguish auth failures from network errors.
