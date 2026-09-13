# HTTP router / multi-client manager hardening (2026-09-13)

Scope of this change: `apps/server/lib/http-router.js`, `apps/server/lib/multi-client-manager.js`,
`apps/server/lib/ca.js`, `apps/server/index.js` and new uniquely named tests. `tls-server.js`,
`connection-pool.js` and `apps/client/*` are owned by another worker and were **not** modified — the
hooks needed from them are listed under "Integration hooks" below.

## 1. Issue-by-issue notes (verified against the code first)

### 1.1 WS upgrade dropped accepted extension/subprotocol headers
* Old behaviour: `http-router.js` forwarded the browser's `sec-websocket-protocol` /
  `sec-websocket-extensions` offers upstream (inside the `UPGRADE` payload) but the 101 written back
  to the browser was hard-coded to `Upgrade` / `Connection` / `Sec-WebSocket-Accept`, so the target's
  selection never reached the browser. The two peers then disagreed (e.g. target sends
  permessage-deflate frames the browser never negotiated).
* Fix: `resolveWebSocketNegotiation()` (exported, unit-tested) relays `Sec-WebSocket-Protocol` and
  `Sec-WebSocket-Extensions` from the upstream 101 **only** when each selected token was actually
  offered by the browser. Anything else is an internally inconsistent handshake and the router fails
  closed with a 502 (plus exactly one `ERROR` terminal frame carrying the reason).
* Alternative policy: `createHTTPServer(..., { stripWebSocketNegotiation: true })` strips the offers
  before forwarding, so no negotiation can be half-applied. Any 101 that still carries negotiation
  headers is then refused.
* Residual limitation: extension parameters are forwarded verbatim after a name-level offer check; the
  router does not validate parameter values (it is a transparent relay, not an extension negotiator).

### 1.2 Buffered WS frames stalled after drain
* Old behaviour: on pool backpressure the router paused the socket and waited for `drain`, but the
  remaining frames already buffered in `wsBuffer` were only re-parsed by a *new* `socket.on('data')`
  event. Frames that arrived in the same TCP chunk (or the frame after an oversized frame) stalled.
* Fix: single resumable pump in the upgrade handler. Frames are consumed from `wsBuffer` one at a
  time; every backpressure path pauses input, waits for the pool drain, then re-schedules the pump
  (`scheduleBrowserPump`) so the buffered remainder is always processed. Oversized frames are sent
  chunk-by-chunk with a retained `pendingLargeFrame`/`pendingOffset` cursor.
* The pump runs in `process.nextTick` and is wrapped in try/catch: a pump failure is turned into a
  `ERROR` terminal frame + `cleanup()` instead of an uncaught exception on the public listener.

### 1.3 Abort paths leaked remote streams / duplicate notifications
* Old behaviour: `req.on('error')` cleaned up locally without telling the tunnel client (target-side
  request leaked until its own timeout); WS `cleanup()` never notified the peer, so idle-timeout /
  overflow / socket-error paths leaked the client-side WS stream; nothing guaranteed a single
  notification.
* Fix: `cleanup(terminal)` is the only teardown path in both handlers. It is once-only, sets its
  `cleanedUp`/`cleanupCalled` flag **before** doing anything that can throw, and emits at most one
  terminal frame through `sendTerminal` (`terminalSent` guard). Every abort site names its terminal:
  * HTTP: `Public request error`, `Public client closed connection`, `Request body too large`,
    `Stream timeout`, `Invalid response headers`, `Failed to forward request headers`.
  * WS: `WebSocket upgrade timeout`, `WebSocket upgrade failed[: detail]`, `WebSocket buffer overflow`,
    `WebSocket socket error`, `WebSocket stream error`, `WebSocket pump failure`, plus `FIN` for
    clean browser `end`/`close` and the idle-timeout close handshake.
  * Inbound terminal frames (client `FIN`/`ERROR`) are *not* answered — the remote already ended.
* Late-callback guards: `frameHandler` and `errorHandler` return immediately when the stream is
  already cleaned up, and `res` writes are skipped once the response is destroyed/ended. Tested by
  invoking the captured handler after cancellation and asserting no further frames are emitted.

### 1.4 Error paths appended "Bad Gateway" inside an in-flight 200
* Old behaviour: after `res.flushHeaders()`, `res.statusCode = 502/504; res.end('Bad Gateway')` cannot
  change the status and silently **grafts** the error text onto the body of the response that is
  already streaming to the public client.
* Fix: `failResponse(status, message)` — if headers were already sent (or Node says so) it calls
  `res.destroy()` to signal a truncated response; otherwise it writes the real status/body. Used by
  the stream timeout (504), invalid headers frame (502), client `ERROR` frame (502), stream error
  (502), request-body-too-large (413) and request-error (502) paths.

### 1.5 Public routing threw on malformed/unreadable domain metadata
* Old behaviour: `MultiClientManager.reloadIssuedDomainIndex()` called `JSON.parse(readFileSync(...))`
  unguarded and dereferenced `raw.domains` / `info.serials`. `resolveByHost()` is called from inside
  the HTTP request handler and the upgrade listener, so one truncated or hand-edited
  `issued-domains.json` (or a `null`/array/`{"domains":null}` document) produced an uncaught
  exception on the public listener.
* Fix:
  * `reloadIssuedDomainIndex()` never throws. It validates the document shape, ignores malformed
    entries, keeps `issuedDomains` as a Map, and tracks `issuedIndexState`
    (`ok` / `missing` / `disabled` / `error`). Unreadable/malformed metadata leaves the last good
    snapshot in place and sets `error`; logging is rate-limited to 10s.
  * `resolveByHost()` returns `{ status: 'metadata-error' }` in that state; the router maps it to a
    controlled **503 `Domain metadata unavailable`**, and `safeResolveRequestRoute()` additionally
    catches any unexpected throw and returns 503 so a bug can never crash the listener.
  * `isAskAllowed()` returns `false` on `error` (the Caddy ask endpoint denies with 404).
  * The CRL read used by `isIssuedDomain()` is wrapped and tolerates missing/unreadable files.
* Atomic writes: `multi-client-manager.writeJsonAtomic()` and `ca.writeJsonFile()` now write to a
  sibling temp file and `rename()` it into place, so readers never observe a truncated document.
  `ensureIssuedDomains()` refuses to clobber metadata it cannot parse (fail closed) and
  `rebuildIndexFromCerts()` is the documented recovery path.

### 1.6 Certificate revocation did not touch live sessions
* Old behaviour: revocation was only observed on the *next* TLS handshake (`isRevoked`), so an
  already-authenticated session kept serving traffic.
* Fix: `ca.js` exposes an in-process event bus — `onCertificateRevoked(listener)` returning an
  unsubscribe function; `revokeCertificate()` emits `certificate-revoked` with
  `{ serial, caDir, domains }` after writing the CRL (the CRL write happens first so revocation takes
  effect even if metadata maintenance fails).
* `MultiClientManager` subscribes in its constructor (path-comparing `caDir` via `resolve()`), and on
  a matching event evicts the session: `_evictSession()` calls `session.evict(reason)` **first**
  (while the session is still registered), then removes the routes and the session, and finally emits
  `session-evicted` with `{ serial, domains, reason }`.
* **Eviction ordering (review follow-up).** The original ordering removed the session from
  `sessionsBySerial`/`activeRoutesByDomain` and only then destroyed the sockets, relying on
  tls-server's *async* `'close'` handler (`removeTunnelConnection` → `pool.remove`) to finish the job.
  By that time the session was no longer findable, so `pool.remove()` never ran, `_cleanupAllStreams()`
  never fired, and the pool kept the destroyed connection entry plus every registered stream handler —
  in-flight public requests hung with no error. `ClientSession.evict()` now performs the whole
  teardown synchronously, in order:
  1. `pool.evictAll(reason)` if the transport provides it (feature-detected; wrapped in try/catch);
  2. `pool.remove(socket)` for every connection, which drops the connection entry and — once the last
     one is gone — runs `_cleanupAllStreams()` (fails every registered stream handler), then
     `socket.destroy()`;
  3. a defensive sweep (`_terminateRemainingStreams`) that fails + clears any handler the pool still
     tracks, plus `activeWebSockets.clear()`.
  tls-server's late `'close'` handler is now a harmless no-op (regression-tested). Measured against the
  old code with one connection + one registered stream: `connections: 1, activeStreams: 1, failures: 0`;
  after the fix: `connections: 0, activeStreams: 0, failures: 1`.
* Polling hooks for out-of-process revocations: `evictRevokedSessions()`,
  `evictSessionsMatching(predicate)`, `startRevocationWatch(intervalMs)` / `stopRevocationWatch()`,
  `dispose()`.

### 1.7 Stream allocation protections (router side)
* HTTP path keeps the per-session limit (`route.session.maxStreams`, falling back to
  `maxConcurrentStreams`) and now reacts to a *throw* while forwarding request headers by releasing
  the allocated stream (`cleanup(...)`) and answering 502 instead of leaking the slot.
* WS path gained the same `streamLimitReached()` check (previously only `maxWebSocketStreams` was
  enforced), and the whole setup block is wrapped in try/catch: any failure after `allocateStream()`
  runs the same once-only `cleanup()` so the stream id (and idle timer) can never leak.
* `setStreamMode` failures are logged and ignored rather than aborting the request.
* The transport-side pool (dedup windows, `onceDrainForStream`, per-stream socket pinning) remains the
  other worker's responsibility.

## 2. Integration hooks (needed from `tls-server.js` / server entry point — not edited here)

1. **Revocation eviction for out-of-process revocations.** The `ca` CLI revokes in a different
   process, so the in-process event never fires. This is now wired in `apps/server/index.js`
   (owned by this change): the manager is constructed with `{ revocationWatch: true,
   revocationWatchIntervalMs: 5000 }` by default, tunable via `--revocation-watch-interval <ms>` and
   disableable with `--no-revocation-watch`. Optionally `tls-server.js` can *also* call
   `connectionPool.evictRevokedSessions()` where it already checks `isRevoked(serial, options.caDir)`
   on a new handshake — not required, but it makes eviction immediate rather than poll-bounded.
2. **Session teardown contract.** Eviction no longer depends on the socket `'close'` handler: the
   manager tears down connections and streams itself before removing the session, and
   `tls-server.js`'s existing `connectionPool.removeTunnelConnection(socket)` on `'close'` remains a
   harmless no-op afterwards. Transport pools may expose `evictAll(reason)` (feature-detected: if
   present it is called first; if it throws or does nothing, the manager's own teardown still runs). If
   tls-server is refactored, keep `removeTunnelConnection` on `'close'` — and note that eviction now
   requires only that `pool.connections` / `pool.activeStreams` stay the authoritative maps.
3. **WS negotiation policy.** `stripWebSocketNegotiation` is a `createHTTPServer` option; if the
   deployment wants strict offer stripping it must be passed from the server entry point.
4. **Client side (other worker).** `apps/client/lib/proxy.js` already copies `sec-websocket-protocol`
   and `sec-websocket-extensions` from the target's 101 into the `UPGRADE` frame — that is what makes
   the server-side relay work. If the client ever filters those headers, negotiation silently
   degrades to "refuse with 502", not corruption, by design.

## 3. Tests added (new files, run directly with `node --test`)

| File | Covers |
| --- | --- |
| `tests/e2e/tls-mtls/http-router-harness-008.js` | Helper: fake pool/stream table + raw browser socket + fake-pool HTTP server |
| `test-router-ws-negotiation-008.js` | Offer forwarding, selection relay, fail-closed 502 for unoffered protocol/extension, strip mode, unit tests for `resolveWebSocketNegotiation` |
| `test-router-ws-pump-008.js` | 3 frames in one TCP chunk across a backpressure boundary; oversized frame + trailing frame after drain; ordering/byte fidelity |
| `test-router-abort-terminal-008.js` | public abort ⇒ exactly one ERROR + late-callback no-ops; stream timeout and stream/client-error truncate a partial 200 instead of grafting text; 413 notification; stream-id release when header forwarding throws; 503 stream-table limit for HTTP *and* WS |
| `test-domain-metadata-hardening-008.js` | corrupt/wrong-shape/unreadable metadata never throws, 503 + ask-deny fail-closed, atomic write + no temp leftovers + refuse-to-clobber, revocation eviction (event, `evictRevokedSessions`, `revocationWatch`, equivalent `caDir` spellings); **new:** revoke against a real `ConnectionPool` asserts `connections.size === 0`, `activeStreams.size === 0`, every registered `errorHandler` was invoked, `socket.destroyed`, session removed, late `removeTunnelConnection` is a no-op; `pool.evictAll` hook is called first and a *throwing* hook still yields full teardown |

Run example:

```bash
node --test --test-timeout=20000 \
  tests/e2e/tls-mtls/test-router-ws-negotiation-008.js \
  tests/e2e/tls-mtls/test-router-ws-pump-008.js \
  tests/e2e/tls-mtls/test-router-abort-terminal-008.js \
  tests/e2e/tls-mtls/test-domain-metadata-hardening-008.js
```

The shared runners (`run.js` / `run-all.js` / root `package.json`) were intentionally left untouched.

## 4. Verification performed

* New tests: 23/23 pass.
* Existing suite `node tests/e2e/tls-mtls/run-all.js`: **202 passed, 0 failed, 0 skipped** (whole e2e
  suite including the timeout/SSE/multipath suites), re-verified after the eviction-ordering fix;
  plus targeted reruns of `test-bugfixes`, `test-websocket*`, `test-multi-client-domains`,
  `test-revocation`, `test-security`, `test-stream-timeout`, `test-max-streams`.
* Old-eviction-ordering evidence: the new regression assertions were executed against
  `HEAD:apps/server/lib/multi-client-manager.js` (temporary copy, then deleted) and reported
  `connections: 1, activeStreams: 1, failures: 0`; with the fix `0 / 0 / 1`.
* `apps/server/index.js --help` and the `--revocation-watch-interval abc` validation path were smoke
  tested; no deployment, no service restarts, no changes outside the owned files and new tests.

## 5. Residual limitations / known risks

* Subprotocol/extension negotiation is validated at token-name level only; extension parameters are
  relayed verbatim.
* `serialToDecimalString()` keeps the codebase convention that TLS serials are hex (see the
  `isRevoked` comments); a caller that feeds a decimal-looking serial into `addTunnelConnection()`
  would be misinterpreted, exactly as before this change.
* `handleUpgrade()` now performs the WS setup in a `try`/`catch`; the failure path is a 502 + one
  terminal frame, so a partially-upgraded socket is never left half-registered.
* The initial `HEADERS` frame is still forwarded before `registerStream()` (pre-existing ordering).
  A client response that arrived within the same tick could theoretically be dropped; the pool's
  frame delivery goes through socket `'data'` events, so this has not been observable. Changing the
  order would touch the request timeout/backpressure setup and was left out of scope.
* Revocation eviction destroys sockets but does not wait for in-flight public responses to finish;
  those responses are truncated, which is the intended fail-closed behaviour.
