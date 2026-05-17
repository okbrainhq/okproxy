# WebSocket upgrade head buffers can stall

**Severity:** Bug

**Status:** Fixed with e2e regression coverage.

**Location:**
- `apps/server/lib/http-router.js:314`, `apps/server/lib/http-router.js:487-494`
- `apps/client/lib/proxy.js:232`, `apps/client/lib/proxy.js:255-263`

Both WebSocket proxy directions store upgrade `head` bytes but only process them when a later `data` event arrives.

Server side, browser-to-target:

```js
let headBuffer = head && head.length > 0 ? head : Buffer.alloc(0);

socket.on('data', (chunk) => {
  if (!headBufferConsumed && headBuffer.length > 0) {
    chunk = Buffer.concat([headBuffer, chunk]);
    headBuffer = Buffer.alloc(0);
    headBufferConsumed = true;
  }
  // parse frames...
});
```

Client side, target-to-browser:

```js
let buffer = proxyHead && proxyHead.length > 0 ? proxyHead : Buffer.alloc(0);

proxySocket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // parse frames...
});
```

If a WebSocket peer sends a complete frame immediately after the HTTP upgrade headers and then sends nothing else, Node can provide that frame in the upgrade `head`/`proxyHead`. Current code leaves that data buffered indefinitely because parsing is only triggered by the next socket `data` event.

**Impact:** first WebSocket messages can be delayed or lost until another frame is sent. This affects clients or targets that send an initial frame immediately after the upgrade.

**Suggested fix:** process `headBuffer`/`proxyHead` immediately by feeding it through the same frame parser used by the `data` handlers, or call a shared `processBufferedFrames()` function once after registering the handlers.

Add tests for:
- client sends a WebSocket frame in the same TCP packet as the upgrade request;
- target sends a WebSocket frame in `proxyHead` immediately after the 101 response.
