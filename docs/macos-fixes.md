# macOS critical premerge fixes — workspace 016

## Scope and provenance

Imported ONLY `macos-client/**` and this document from dirty workspace 010.
Source010 was read, not modified. Subsequent changes are confined to those paths.
Work ran only on the assigned aZero Linux host: no advisor, other-device connection,
live service run, GUI launch, deployment, or commit.

The imported work also contains single-instance/build locking, UTF-8 decoding,
log history/disk bounds, checksums, semantic versions, endpoint parsing and settings
hardening. Those are inherited changes, not newly audited/certified in this pass.
This document supersedes the source010 claims about process safety and recovery.

## Process ownership and shutdown

- Darwin opaque spawn handles now start as explicitly typed optional `nil`, with
  checked init/configuration APIs and deferred descriptor/handle cleanup.
- `OkProxyProcessHelper` is a separate C executable, built by SwiftPM and copied
  and signed alongside the app binary by `macos-client/scripts/build.sh`.
- Swift owns/signals ONLY the direct helper PID. A synchronous lock covers both
  nonblocking `waitpid(WNOHANG)` and signaling; identity is invalidated inside that
  same lock on reap/error. No Swift group-existence probe or post-reap group signal.
- The persistent helper stays outside the workload group. It forks a workload
  leader into its own group, observes exit with `waitid(WNOWAIT)`, and retains
  that live/zombie leader PID through the LAST group SIGKILL. Only then does it
  reap and return the workload status. Natural leader exit also triggers descendant
  cleanup, rather than abandoning its surviving children.
- TERM requests graceful group shutdown. Swift escalation sends USR1 to the helper,
  NOT SIGKILL; the helper sends the final group SIGKILL. Original parent PID is
  supplied at launch, and parent death also triggers cleanup.
- Helper wait/ownership errors fail closed. Swift `waitpid == -1` is explicit,
  never decoded as status zero. Abnormal helper death invalidates signaling identity
  but does not acknowledge workload cleanup: registry and operation gate remain held.
- Exit state is recorded off-main before log draining/UI callbacks. A blocked main
  actor no longer prevents the synchronous fallback from observing confirmed exit.
- Stop completion reports a Boolean failure at its deadline while ownership is
  unresolved. Client references/gates remain held until cleanup acknowledgement;
  both model and supervisor guard duplicate starts. Late stop callbacks cannot clear
  a replacement client. Native AppKit termination uses `terminateLater` and refuses
  completion on timeout; normal quit likewise does not report success prematurely.

## Installer transaction recovery

`node.transaction` is atomically renamed into place with `existing` or `new`
BEFORE touching the active install. `committed` is written only AFTER activated
binary validation succeeds. The valid backup is discardable only in that phase.

Installer recovery and startup recovery implement the same rules:

- Uncommitted or legacy `.previous` wins even if an active directory also exists.
- Uncommitted fresh installs (`new`) are removed before any probe/autostart.
- `existing` without a backup preserves the original/already-restored active copy,
  making a crash during rollback restart-idempotent.
- Unknown/unreadable state blocks use rather than executing an unvalidated binary.
- Startup refresh/preflight recovers before version probing or starting Node and
  refuses to race an active setup child.

State ownership is acquired before AppModel recovery regardless of delegate ordering,
with idempotent acquisition and fail-closed lock errors. The app-lock descriptor is
intentionally inherited by helpers/workloads; release closes only the app reference
(no explicit unlock), excluding immediate relaunch while old crash cleanup runs.
Darwin descriptor/flock behavior still requires macOS validation.

These are process-interruption guarantees, NOT fsync/power-loss durability claims.

## Logging

`ShellOutputBuffer.append` now performs a synchronous bounded append on its serial
queue. A fast pipe producer cannot accumulate an unbounded queue of captured-string
closures while the main actor is stalled. Chunk and aggregate buffer bounds plus
one in-flight UI delivery remain. Pipe reads are bounded per callback, including
failure cleanup with an open descendant pipe. No GUI/RSS measurements were made.

## Verification actually run here

- `python3 macos-client/tests/critical-invariants.py`: **25 passed**.
  - Production C helper compiled on Linux with `-Wall -Wextra -Werror`.
  - Real subprocess tests: natural leader exit, TERM-resistant descendants, forced
    cleanup, 50 rapid exit/reap cycles, parent death; unrelated sentinel survives.
  - Inherited state lease blocks relaunch until helper cleanup closes it.
  - Eight extracted-production-shell recovery states, each recovered twice.
  - Full extracted installer using local `file://` fixtures: success, checksum
    mismatch, missing checksum, activated-binary validation failure.
  - Actual SIGKILL during activated-binary validation: active and valid backup both
    remain, transaction stays uncommitted, recovery restores the valid backup.
  - One explicitly STRUCTURAL Swift check group (not runtime coverage).
- `bash macos-client/tests/macos-robustness-checks.sh`: **71 passed, 0 failed,
  1 skipped**. These are source assertions, XML and shell syntax checks.
- `git diff --check`: passed.
- The inherited HTTP-server behavior suite was NOT run in this pass; offline
  fixtures avoid listeners and external network access.

## Limitations stated honestly / remaining premerge blockers

- **No Swift toolchain/macOS SDK here. Swift was NOT compiled or executed.**
  The C Linux build does not verify Darwin spawn imports, `waitid(WNOWAIT)` behavior,
  Swift concurrency checking, AppKit termination, helper packaging/signing, or startup
  recovery integration. An allowed macOS build/runtime pass and full Astra review
  remain required before treating this as merge-approved.
- Logging pressure and stop timeout/error behavior in Swift have structural coverage
  only. PID-reuse correctness relies on the shared lock plus unreaped leader ownership;
  tests exercise lifecycle behavior but do not force actual kernel PID reuse.
- Group cleanup covers descendants that remain in the workload group. A process
  deliberately using `setsid`/`setpgid` to escape is not contained. External SIGKILL
  of the helper can strand its workload; Swift fails closed and never guesses a PGID.
- The helper confirms the direct workload leader's reap after delivering group
  SIGKILL. It cannot `waitpid` grandchildren on macOS; delivery is not proof that
  every descendant has been reaped or left an uninterruptible kernel wait. Linux
  fixture checks reject running orphans but permit init-owned zombies.
- Filesystem transaction markers are atomically replaced, not power-loss durable.
  Shell recovery is behaviorally tested; the matching Swift startup implementation
  still requires execution on macOS.

Later, on an explicitly allowed Mac: run `macos-client/scripts/test.sh`, then
`macos-client/scripts/build.sh`; validate bundle helper signing, lifecycle stress,
main-actor-stalled logging, forced stop timeouts, and startup recovery at every
transaction boundary. No Mac/GUI/live-service command was run in this pass.

## Reviewer 3 follow-up — three critical blockers

- Spawn blocks TERM/INT/USR1 across exec. The helper installs checked handlers,
  retains the blocked mask through fork/group setup, then unblocks. The workload
  resets dispositions and empties its mask before exec. Pending immediate cancel
  is handled by the helper rather than killing it before initialization.
- AppModel uses one token-matched `finishClientExit` path which releases the stop
  gate before clearing identity. A Stop after reap but before queued callbacks
  takes that path; repeated in-progress Stop is idempotent. Old callbacks cannot
  release the stop gate of a newer client; unresolved ownership retains the gate.
- ShellOutputBuffer stores bounded UTF-8 Data, not additive grapheme counts.
  Incoming suffix allocation and retained buffer each have a byte cap; temporary
  concatenation is at most twice that cap. Cuts discard leading continuation
  bytes, preserving scalar validity (not grapheme completeness). Drop accounting
  saturates instead of overflowing. One delivery is bounded by the byte cap plus
  its fixed-format counter marker, with no per-chunk queued closures.

Verification on assigned Linux host: critical suite **25 passed**, including
90 immediate-after-posix_spawn cancellations (30 each TERM/INT/USR1, no readiness
wait), and actual workload empty-mask verification. Focused Swift source checks
passed. `reviewer3-swift-checks.py` contains extracted-production-method runtime
regressions for the reap/second-Stop/queued-callback ordering, stale callbacks,
timeout retention, combining-mark flood, oversized chunks, scalar cuts, and a
stalled consumer. Those runtime checks were **SKIPPED: swiftc unavailable**;
they are wired into scripts/test.sh for the later authorized Mac validation.
No Swift SDK compilation, GUI/service execution, other device, or commit.
