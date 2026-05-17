# Target connection refusal sends no FIN

**Severity:** Bug

**Status:** Fixed with e2e regression coverage.

**Location:**
- `apps/client/lib/proxy.js:396-408`
- `apps/server/lib/http-router.js:221-231`

When the local target refuses a proxied HTTP request, the client sends a `HEADERS` frame and a `DATA` frame, but it never terminates the stream with `FIN` or `ERROR`:

```js
if (err.code === 'ECONNREFUSED') {
  connection.write(encodeFrame(streamId, FrameType.HEADERS, JSON.stringify({
    status: 502,
    headers: { 'content-type': 'text/plain' }
  })));
  connection.write(encodeFrame(streamId, FrameType.DATA, Buffer.from('Target service not available')));
}
```

The server receives the 502 headers and body, then waits until `streamTimeout`. After the timeout it appends `Gateway timeout` to the same response body because headers have already been sent.

Observed with `streamTimeout: 200`:

```json
{
  "statusCode": 502,
  "body": "Target service not availableGateway timeout"
}
```

With default settings this adds roughly 30 seconds of latency before the public HTTP response completes.

**Expected behavior:** after sending the 502 body for `ECONNREFUSED`, the client should send `FIN`.

**Suggested fix:** in the `ECONNREFUSED` branch, send `FrameType.FIN` after the body frame. Add an e2e test that closes the mock target, sends an HTTP request through the tunnel, and asserts the 502 response completes immediately without a trailing timeout body.
