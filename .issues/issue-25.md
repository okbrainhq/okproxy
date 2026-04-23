# Idle timer listener wrapping is fragile

**Severity:** Bug
**Location:** `apps/server/lib/http-router.js:694-708`

```js
const originalOnData = socket.listeners('data')[0];
socket.removeListener('data', originalOnData);
socket.on('data', (chunk) => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { ... }, WS_IDLE_TIMEOUT);
  originalOnData(chunk);
});
```

This assumes the first `data` listener is the WS frame handler. If anything adds a listener before this code runs (Node.js internals, the `headBuffer` prepend logic, or future code changes), it wraps the wrong function. Removing and re-adding listeners also disrupts listener ordering.

**Fix:** Use a simpler approach — set a flag in the existing `data` handler instead of wrapping:

```js
socket.on('data', () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(idleTimeoutHandler, WS_IDLE_TIMEOUT);
});
```

Node.js allows multiple `data` listeners. Adding a second one just for idle reset avoids the fragile remove/re-add pattern entirely.
