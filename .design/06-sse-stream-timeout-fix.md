# SSE Stream Timeout Fix

## Problem Summary

SSE (Server-Sent Events) connections are being dropped after exactly 30 seconds, even when data is actively flowing from the server to the client. This breaks long-lived streaming connections.

### Root Cause

In `apps/server/lib/http-router.js`, the `STREAM_TIMEOUT` (30 seconds) only tracks **client-to-server** activity:

```javascript
// resetStreamTimeout() is ONLY called in frameHandler when receiving frames FROM the client
clientManager.registerStream(streamId, {
  frameHandler: (frame) => {
    resetStreamTimeout();  // <-- Only called when CLIENT sends frames
    // ...
  }
});
```

For SSE:
1. Browser sends initial HTTP request (headers + possibly body)
2. Target server sends periodic events (server → client direction only)
3. Client proxy forwards DATA frames to tunnel server
4. Tunnel server forwards to browser
5. **No frames flow from client → server after the initial request**
6. After 30 seconds, timeout fires and the stream is killed

The timeout mechanism incorrectly assumes that bidirectional communication implies activity. For unidirectional streams like SSE, server-to-client data flow must also count as "activity."

## Solution Design

### Option A: Reset timeout on outgoing frames (Recommended)

Modify `apps/server/lib/http-router.js` to reset the stream timeout whenever the server **sends** frames to the browser (both HEADERS and DATA):

```javascript
// In the frameHandler, when handling HEADERS frames from client:
if (frame.type === FrameType.HEADERS) {
  try {
    const headers = JSON.parse(frame.payload.toString());
    res.statusCode = headers.status || 200;
    if (headers.headers) {
      const filteredHeaders = filterResponseHeaders(headers.headers);
      for (const [k, v] of Object.entries(filteredHeaders)) {
        try {
          res.setHeader(k, v);
        } catch (headerErr) {
          console.error(`Skipping malformed header '${k}':`, headerErr.message);
        }
      }
    }
    headersSent = true;
    resetStreamTimeout();  // <-- ADD THIS: receiving/sending headers is activity
  } catch (err) {
    // ...
  }
} else if (frame.type === FrameType.DATA) {
  if (!headersSent) {
    res.statusCode = 200;
    headersSent = true;
  }
  res.write(frame.payload);
  // Reset timeout on outgoing data - critical for SSE where client sends nothing after initial request
  // The original bug: timeout only reset on incoming frames, but SSE is server→client only
  resetStreamTimeout();
}
```

**Pros:**
- Minimal change (2-3 lines + comment)
- Conceptually correct: any frame movement = activity
- Fixes SSE without side effects on other stream types
- Handles slow-starting responses (headers after 29s, then streaming)

**Cons:** None significant

### Option B: Content-Type-based exemption (Not Recommended)

Detect `text/event-stream` responses and disable timeout for them:

```javascript
// Detect SSE and skip timeout
if (headers['content-type']?.includes('text/event-stream')) {
  // Disable or greatly extend timeout
}
```

**Pros:**
- SSE-specific fix

**Cons:**
- Fragile (relies on header detection)
- Doesn't fix other unidirectional streams (e.g., streaming downloads, video)
- SSE might have `Content-Type: text/event-stream; charset=utf-8`

### Option C: Bidirectional activity tracking (Complex)

Track last activity time separately for each direction and timeout only when BOTH directions are idle.

**Pros:**
- Most precise

**Cons:**
- Over-engineered for the problem
- More code, more bugs

## Recommended Approach: Option A (Enhanced)

### Implementation Plan

1. **File:** `apps/server/lib/http-router.js`
2. **Changes:**
   - Call `resetStreamTimeout()` in the HEADERS frame handler after `headersSent = true` (line ~202)
   - Call `resetStreamTimeout()` in the DATA frame handler after `res.write(frame.payload)` (line ~215)
   - Add explanatory comment on the DATA frame reset explaining the SSE bug
3. **Optional:** Also reset on `res.end()` / FIN handler to prevent narrow race conditions

### Code Comment Template

```javascript
// Reset timeout on outgoing data - critical for SSE where client sends nothing after initial request.
// Without this, unidirectional server→client streams timeout after 30s because the timeout
// was only being reset when receiving frames FROM the client. See: .design/06-sse-stream-timeout-fix.md
resetStreamTimeout();
```

### Testing Strategy

1. **Create a new E2E test:** `tests/e2e/tls-mtls/test-sse-timeout.js`
   - Connect to SSE endpoint
   - Wait for **60+ seconds** (2x the default 30s timeout) while receiving events every 1-2 seconds
   - Verify connection stays open
   - Verify events are received throughout

2. **Update existing test:** Verify `test-sse.js` passes with extended durations
   - Current test only waits 500ms, which doesn't catch the 30s timeout
   - Add a longer test case (60+ seconds) to verify the fix

3. **Regression test:** Ensure regular requests still timeout correctly
   - Verify hanging targets still get 504 after 30s
   - Verify active bidirectional streams don't timeout

4. **Slow-start test:** Verify headers after 29s then streaming works
   - Target delays 29s before sending headers
   - Then sends data every 5s
   - Should not timeout

### Edge Cases to Consider

1. **Very slow SSE:** Events sent every 40+ seconds
   - Current default timeout: 30s
   - If target sends events every 40s, timeout will still fire
   - **Mitigation:** This is correct behavior - the target is genuinely slow
   - Document: Users can increase `--stream-timeout` if needed

2. **SSE with gaps:** Bursts of events then long silence
   - Timeout resets during bursts
   - If gap > 30s, connection drops (expected)

3. **Mixed traffic:** SSE + regular requests
   - Each stream has independent timeout
   - SSE streams timeout if idle, regular streams unaffected

4. **Slow headers + fast streaming:**
   - Target takes 29s to send headers
   - Then streams data every 100ms
   - With HEADERS reset: timeout resets at 29s, then every 100ms → works
   - Without HEADERS reset: timeout fires at 30s even though streaming is about to start

### Configuration Impact

The `--stream-timeout` option remains valid and useful:

```bash
# Default: 30 seconds
node apps/server/index.js

# For very slow SSE (events every 60s)
node apps/server/index.js --stream-timeout 70000
```

## Success Criteria

- [ ] SSE connection stays open for > 60 seconds (2x timeout) when receiving events every 1-5 seconds
- [ ] SSE with slow headers (29s delay) followed by streaming works correctly
- [ ] Regular hanging targets still timeout with 504 after configured timeout
- [ ] No regression in existing test suite
- [ ] Code includes explanatory comment for future maintainers
- [ ] Documentation updated if behavior change is user-visible

## Related Files

- `apps/server/lib/http-router.js` - Main fix location
- `apps/server/index.js` - Timeout configuration (no changes needed)
- `tests/e2e/tls-mtls/test-sse.js` - Update with longer duration test
- `tests/e2e/tls-mtls/mock-target.js` - SSE endpoint already exists
