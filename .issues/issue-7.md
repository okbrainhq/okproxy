# Hop-by-hop header filtering is too permissive for WS

**Severity:** Design / hardening
**Location:** `apps/client/lib/proxy.js:54-65`

`filterWebSocketHeaders` strips only `X-Forwarded-*`. It forwards `te`, `trailer`, `keep-alive`, `proxy-authorization`, etc.

**Fix:** Keep `upgrade`/`connection`, but still strip the other hop-by-hop entries.
