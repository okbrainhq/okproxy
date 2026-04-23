# Case-sensitive header dedup in proxy upgrade response

**Severity:** Bug
**Location:** `apps/client/lib/proxy.js:271-274`

```js
for (const [key, value] of Object.entries(proxyRes.headers)) {
  if (!responseHeaders[key]) {  // case-sensitive check!
    responseHeaders[key] = value;
  }
}
```

`responseHeaders` is initialized with lowercase keys (`upgrade`, `connection`, `sec-websocket-accept`), but `proxyRes.headers` from Node.js may use title-case (`Upgrade`, `Connection`, `Sec-WebSocket-Accept`). The case-sensitive `!responseHeaders[key]` check fails to detect the duplicate, so both versions are kept:

```
upgrade: websocket
Upgrade: websocket     ← duplicate
connection: Upgrade
Connection: Upgrade    ← duplicate
```

The server then writes these duplicate headers to the browser's 101 response. Some browsers may reject the handshake or behave unpredictably.

**Fix:** Normalize keys to lowercase for the duplicate check:
```js
const lowerKey = key.toLowerCase();
if (!Object.keys(responseHeaders).some(k => k.toLowerCase() === lowerKey)) {
  responseHeaders[key] = value;
}
```
