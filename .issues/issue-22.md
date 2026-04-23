# Idle timeout destroys socket before close frame flushes

**Severity:** Critical
**Location:** `apps/server/lib/http-router.js:682-691, 698-706`

When the idle timeout fires, a close frame is written to the browser socket and then `cleanup()` is called immediately:

```js
const closeFrame = buildWebSocketFrame(0x08, Buffer.from([0x03, 0xe9]));
socket.write(closeFrame);  // async — buffered
cleanup();                  // calls socket.destroy() synchronously
```

`socket.write()` is non-blocking; the data is queued. `cleanup()` calls `socket.destroy()` synchronously, which discards the write queue before the kernel can flush the close frame to the browser.

The browser sees an unclean TCP close instead of a proper WebSocket close frame. This triggers `Event { code: 1006, wasClean: false }` rather than `Event { code: 1001, wasClean: true }`.

**Fix:** Use `socket.write(closeFrame, () => cleanup())` to defer destruction until the close frame is flushed, or use `socket.end()` instead of `socket.destroy()` in the idle timeout path.
