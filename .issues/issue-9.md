# No liveness check for WS

**Severity:** Design / hardening
**Location:** `apps/server/lib/http-router.js:535`

Comment defers to "WebSocket ping/pong or TLS keepalive," but nothing in the proxy actually sends ping or enforces an idle timeout.

If the target crashes without FIN, the browser connection lingers until TLS keepalive (minutes).
