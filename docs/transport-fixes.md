# Transport fixes: fail-closed protocol v2

## Scope and provenance

Implemented and self-reviewed in workspace **015 on aZero**, based on main
`9fc6678` (which includes the HTTP lifecycle/metadata fixes). Imported worker007's
10 modified transport source files with `git diff HEAD --binary` and its six
allowlisted untracked source/test/docs files. No worker007 or main files were
modified. The unsafe salvage, reset-epoch and shared-TLS-pause designs were
replaced, not approved as originally submitted. `reset-seq.js` is intentionally
not retained: the live protocol has no reset/replay transition.

The HTTP router and CA/metadata fixes from main are retained. The only changes to
`multi-client-manager.js` are pool capacity integration and non-wrapping stream
allocation. The legacy `tls-connection.js` API now delegates to VirtualSocket so
it cannot bypass the new wire protocol or lifecycle fences. This work performs
no deployment, service restart, commit, or testing on another device. No advisor
was used.

## Guarantees and deliberate availability tradeoffs

- **No DATA/FIN delivery before opening HEADERS/UPGRADE.** Every direction starts
  at sequence 1. The server knows which streams it allocated and can buffer a
  response's DATA2 until HEADERS1 arrives. A client receiving DATA for a stream
  it has never opened cannot establish that allocation safely: it fails the
  session rather than delivering DATA and later “salvaging” HEADERS. No prefix is
  silently discarded. Active streams reorder subsequent frames within bounds.
- **Explicit session identity, not just a local counter.** All TLS lanes are
  authenticated by the existing certificates and bound to the same pair of
  random client/server session nonces. A different server nonce on a new lane
  aborts existing target work and closes old lanes before the new session can
  carry data, even if an old TCP close has not yet been observed. Decoder
  callbacks also check the exact socket and its current session membership.
- **No in-session sequence or stream-ID reuse.** HEADERS is not a restart marker.
  Completed IDs retain payload-free tombstones until session teardown. A sender
  fails the session before advancing beyond `0xffffff0f`; it never sends
  RESET_SEQ, sequence zero DATA, or a recycled epoch. Incoming RESET_SEQ, with
  or without an epoch, is a fatal protocol violation. Allocators do not wrap
  `0x7fffffff` back to 1. The legacy single-client listener rejects allocation
  after allocator exhaustion rather than recycling IDs.
- **Lane loss is session loss.** ANY established lane loss, replacement/removal,
  queue overflow, unrecoverable sequence gap, or flow-control overflow/timeout
  cancels the entire affected tunnel session. A still-live lane with the same
  interface name is not replaced in place. Sibling connections are never taken
  as proof that they hold copies of a pinned stream's bytes.
- **Cancellation is not success.** v2 ERROR is an out-of-band abort with
  `seqNo=0`, including during a gap or consumer pause. It drops queued data and
  fails the handler; it never advances a success boundary. FIN remains ordered.
  A successful HTTP response cannot finish while its request is incomplete;
  an early error status (400–599, including target-refused 502) may finish as an
  explicit HTTP failure. Existing HTTP-router behavior sends 502 before headers
  or destroys an already-started response, without appending error text to a
  partial 200. A gap followed by FIN cannot produce a normal chunked end.
- **No ACK/replay or exactly-once request execution is claimed.** Prefix bytes
  may already have reached the target/public client before cancellation. Side
  effects at a target cannot be rolled back. The transport does not retry HTTP
  requests. Callers must treat a truncated response as failure and apply their
  own idempotency policy. Automatic TLS reconnect is for new requests only;
  an interrupted SSE/WebSocket does not transparently resume.

A slow lane/consumer, a request-opening race, or the session-ID budget can thus
cancel unrelated in-flight streams. This is a deliberate conservative policy,
not a claim of seamless multipath failover or end-to-end transactional delivery.

## Wire compatibility and coordinated rollout

The 13-byte frame envelope is unchanged, **but the protocol is incompatible**.
Both endpoints must use protocol v2; no permissive legacy fallback exists.

Client INIT JSON requires:

```json
{
  "version": 2,
  "capability": "session-bound-no-wrap-v2",
  "clientSession": "<64 lowercase hex characters: 32 random bytes>",
  "interface": "default#1",
  "maxFrameSize": 1048576,
  "domains": []
}
```

The server ACK repeats version/capability and the exact client nonce, and adds
`serverSession` (another independent 32-byte random nonce), `maxConcurrentStreams`
and the authorized domains. The ACK is validated before making a client lane
writable or emitting ready. The server binds INIT to the authenticated serial
before accepting stream frames. Nonces are connection/session metadata, not a
per-DATA payload field; the authenticated TLS connection supplies the binding.

- Old client → new server: INIT rejected before pool registration.
- New client → old server: legacy ACK rejected before client ready/data traffic.
- Same client certificate but different live client nonce: new lane rejected;
  it cannot take over the existing pool or inject into its stream IDs.
- New server nonce while old client lanes remain locally live: abort/rotate the
  client session, close all those lanes, and reconnect with a new client nonce.

**Rollout/rollback must be coordinated across the server and all client builds**
(including any packaged/other implementation still speaking the old protocol).
Plan a maintenance interruption, terminate/drain old sessions, then start a
matching pair. Mixed-version availability is intentionally sacrificed. Do not
roll back only one endpoint or copy the old epoch logic into a v2 peer. These are
future operational requirements; no rollout or restart was performed here.

## Resource and liveness bounds

Default limits per receiving authenticated virtual session/pool:

| Resource | Bound / behavior |
| --- | --- |
| Concurrent active streams | 100 by default; server setting is bounded to 4096 and passed to the client; a smaller explicit client cap may restrict it further |
| IDs/tombstones over a session lifetime | 65,536; next allocation explicitly fails the session, including any still-active streams |
| Aggregate retained reorder + paused-delivery bytes | 16 MiB, including 13 bytes charged per queued frame |
| Combined retained bytes for one stream | 4 MiB |
| Reorder entries / paused-delivery entries | 512 each, also subject to shared byte bounds |
| Forward sequence distance / gap lifetime | 4096 frames / 1000 ms |
| Continuous consumer pause | 10 seconds; overflow may fail sooner |
| TLS lane writable queue | 4 MiB per lane, checked on writes; at most a write-sized overshoot before session cancellation |
| Lanes | 64 per virtual client/pool and per authenticated serial (including sockets awaiting INIT on the server) |
| Unsolicited frame quota | No stream allocation; server closes the session after more than 256 invalid/unsolicited frames on one lane |
| Maximum decoded frame payload | 1 MiB |

The byte budget is **transport-owned retained payload**, not a process RSS cap:
TLS/OS buffers, HTTP target/public stream buffers and WebSocket reassembly have
separate memory costs. The 16 MiB bound is per session, not a global limit across
all authenticated clients. Direct constructor options permit controlled limits
for tests/embedding; they are not all CLI switches.

Allocation membership is checked before creating server receive windows. No
inbound stream-to-lane maps or reset-epoch maps are maintained. Unregistration,
completion and failure immediately release receive payload, gap/pause timers,
per-stream modes and pending drain listeners. Tombstones do not consume active
window slots, so thousands of completed requests cannot fill the active cap.
Retired legitimate duplicates do not consume the unsolicited-frame quota.
Registration/allocation failures explicitly notify handlers or throw on the
router's pre-registration opening-send path, rather than silently refusing a
valid response.

**TLS reading is never paused by stream flow control.** A paused consumer has a
bounded per-stream delivery queue; PING/PONG and sibling streams remain readable,
including on lanes added after the pause. Global and per-stream pause ownership
are independent. No heartbeat timeout exemptions fabricate evidence that a peer
can hear. Keepalive clocks are monotonic. Broadcast producers resume on the first
eligible lane's drain, and pinned producers wait only for their own lane. All
per-stream drain subscriptions are removed on completion/eviction.

## Revocation and HTTP/metadata integration

`pool.evictAll`, `pool.evictBySerial`, `server.evictSerial`, in-process CA revocation
notifications, and the existing MultiClientManager revocation/watch path
synchronously fence sockets, clear buffers and notify allocated HTTP handlers.
Teardown is idempotent and contains handler exceptions. The manager's fallback
still works if its public transport eviction hook throws. TLS-server CA/custom
revocation listeners are detached on server close.

CA events only cross the current process. MultiClientManager retains its CRL
polling path for out-of-process changes; legacy single-pool mode has no new
cross-process CRL polling mechanism here. Such a change requires its existing
operator eviction/reconnect path (and new handshakes always check revocation).

## Regression evidence and review cycle

`tests/unit/test-transport-v2.js` replaces the unsafe epoch/salvage assertions with
allocation, ordered-byte, tombstone, exhaustion, cancellation, memory, ownership,
drain-cleanup and session-fencing regressions. It includes the fake-clock 12-second
heartbeat scenario with a 300-second server consumer pause, 5,000 unsolicited IDs,
a 6,000-ID RESET payload, 4,500 completed allocations under a two-active-stream
cap, and the >4 MiB pinned lane whose sibling carries zero copies.

`test-transport-v2-integration.js` uses real local TLS/HTTP endpoints to verify:

- DATA2-before-HEADERS1 never creates a suffix-only target request.
- Reordered/duplicated upload bytes and the echoed response match exactly.
- A real allocated response preserves status 201 and every body byte even when
  response DATA2 arrives before HEADERS1.
- A started HTTP 200 with a missing middle frame and later FIN is truncated,
  never completed normally (integration with main `9fc6678`).
- A fresh server session really allocates ID1 while an old target response is
  pending; `OLD-SESSION-SECRET` cannot enter the new response.
- Real bidirectional heartbeat traffic survives three shortened deadlines during
  a consumer pause and late-lane join, while a sibling request succeeds.
- Both directions of old/new peer rejection happen before ready/stream traffic.
- Actual CA revocation in single-pool mode fails allocated public work and frees
  retained buffers/timers immediately.

The imported lane-loss test now requires truncation of a partial response and
byte equality of a >2 MiB echo after reconnect, not merely any status below 500.
Existing raw-wire fixtures now explicitly speak v2. Legacy tests expecting reset
recovery, FIN without an opening frame, transparent lane continuation, or
in-session ID reuse were replaced with explicit fail-closed expectations.
During integration review, early target-refused responses, duplicate-frame quota
accounting, eviction fallback, pause ownership and decoder disposal received
additional fixes and regression checks.

Reproduction commands (local fixtures; no external devices):

```sh
node --test tests/unit/*.js
node --test tests/e2e/tls-mtls/test-transport-v2-integration.js
npm run test:all
```

`test:all` now discovers every `test-*.js` in the unit and TLS e2e directories,
including gzip, HTTP/metadata regressions and the long SSE suite. It counts tests
without counting suite containers as extra passes. Node v22.23.2 was used on
aZero. The focused final v2 run passed **32/32** tests. The final frozen-source
full run passed **229 tests, 0 failed, 0 skipped**, including both long SSE tests
(the 65-second periodic-event connection and slow headers followed by streaming).
An additional exhaustive check passed all 120 orderings of five response frames,
with a duplicate injected at every step. All 63 source/test file hashes matched
the final full-suite inputs; JavaScript syntax and `git diff --check` also passed.
The full local log is `/tmp/okproxy-015-final-all.log`.

During this work main independently advanced to `acc2ad5` with deployment/macOS
changes. A read-only comparison found no changes under `apps/` or `packages/`
since our `9fc6678` baseline. Those unrelated changes were NOT imported or
modified. At merge time retain main's standalone gzip runner integration and
memory-test helpers; do not run gzip both through discovery and its standalone
step. Main's runner/test changes still require merge reconciliation.

At the user-requested cost/status checkpoint, implementation and the above tests
are complete; a separate final postimplementation review of the frozen diff and
merge boundaries remains. Tests are regression evidence, not a formal proof of
absence of all bugs. No WAN, other-device, production-load or native client
rollout validation is claimed.
