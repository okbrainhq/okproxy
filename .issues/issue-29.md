# HTTP abort paths do not notify tunnel client

**Severity:** Bug

**Status:** Fixed with e2e regression coverage.

**Location:**
- `apps/server/lib/http-router.js:180-190`
- `apps/server/lib/http-router.js:300-304`

Some server-side HTTP cleanup paths unregister and release the stream ID without sending `ERROR` or `FIN` to the tunnel client.

Request body too large:

```js
if (bodySize > maxBodySize) {
  cleanup();
  res.statusCode = 413;
  res.end('Request body too large');
  req.destroy();
  return;
}
```

Public client closes early:

```js
res.on('close', () => {
  if (!res.writableEnded) {
    cleanup();
  }
});
```

By this point the client proxy may already have opened a request to the local target. Since it never receives a tunnel `ERROR` or `FIN`, that target request can remain open until the target, OS, or local HTTP client times it out. Long-lived endpoints and incomplete request bodies make this especially visible.

**Impact:** leaked local target work, stuck client-side `activeStreams`, and wasted tunnel/client resources after public-side aborts.

**Suggested fix:** before `cleanup()` in abort paths, send a stream `ERROR` frame such as `Request aborted` or `Request body too large`. The client already handles `FrameType.ERROR` by destroying the target request and deleting the active stream.

Add tests for:
- request exceeding `maxBodySize` closes the target request promptly;
- public client disconnect during a long response aborts the target-side request.
