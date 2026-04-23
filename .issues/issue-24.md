# No timeout on WS upgrade request to target

**Severity:** Bug
**Location:** `apps/client/lib/proxy.js:217-229`

The `http.request()` for WebSocket upgrade has no timeout configured:

```js
const proxyReq = request({
  hostname: targetHost,
  port: targetPort,
  method: upgradeInfo.method,
  path: upgradeInfo.path,
  headers: proxyHeaders
});
```

If the target service never responds to the upgrade request (hung process, network partition, firewall drop), the stream hangs indefinitely. The server-side idle timeout (5 minutes) eventually cleans up the browser connection, but the proxy request and stream slot remain occupied for the full duration.

Additionally, the `proxyReq.on('error', ...)` handler sends an ERROR frame but doesn't clean up the `activeWebSockets` entry (the entry was never added since upgrade didn't complete), so this is minor. However, the stream ID is never released.

**Fix:** Add `timeout` option to `http.request()` (e.g., 10-30 seconds). On timeout, destroy the request, send ERROR frame to server, and release the stream ID.
