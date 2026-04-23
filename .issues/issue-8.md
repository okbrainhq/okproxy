# WS streams share the maxStreams=100 cap with HTTP

**Severity:** Design / hardening
**Location:** `apps/server/lib/http-router.js:386`

Long-lived WS connections can trivially starve HTTP traffic.

**Fix:** Consider a separate WS cap or per-IP limit.
