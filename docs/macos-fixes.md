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

## Follow-up (macOS live) — the client could not be stopped at all

Reported from a running production install: the app could not stop the client,
could not update the repository (needed because the server had been updated),
and could not quit. Five `OkProxyProcessHelper` processes were parked forever
and had to be `SIGKILL`ed by hand; `ps` showed only helpers, no workload, i.e.
every supervised child had already exited.

```
[2026-09-13T11:00:14Z] Stopping client…
[2026-09-13T11:00:14Z] okproxy helper ownership failure: Operation not permitted
[2026-09-13T11:00:18Z] Stop timed out or ownership failed; client/start gate retained until confirmed cleanup.
[2026-09-13T11:00:28Z] Stop the client before running repository update.
[2026-09-13T11:00:46Z] Quitting: stopping all owned child processes…
[2026-09-13T11:00:50Z] Shutdown timed out or ownership failed; shutdown gate retained, not reporting success.
```

### Root cause (measured on macOS, not inferred)

The helper sent the final group signal and treated any error other than `ESRCH`
as an ownership failure, then parked in `for (;;) pause();`. Darwin returns
**EPERM — not ESRCH —** for `kill(-pgid, sig)` when the group has no signalable
member left, which is exactly the state after the workload leader exits and only
its unreaped zombie (kept deliberately by `waitid … WNOWAIT`) stands in for the
group. Measured on this host with the production helper source:

| state of the process group | `kill(-pgid, SIGKILL)` |
| --- | --- |
| leader alive | `0` |
| leader exited, unreaped (zombie), no other member | **`-1 EPERM`** |
| zombie leader + one live member | `0` |
| no such group | `-1 ESRCH` |

Any leader exit reaches that branch — a natural exit, a client crash, and every
`node --version` probe — so the helper never exited. Swift's `waitpid` therefore
never returned, `isRunning` stayed true forever, and the stop transaction, the
start/setup gate and the AppKit termination reply stayed retained forever.
Linux returns `0` for the same call, which is why the Linux helper fixtures
never caught it.

### Fix

* **Helper (`Sources/OkProxyProcessHelper/main.c`) never parks itself.** A
  refused group signal is classified by probing the group (`KERN_PROC_PGRP`,
  zombies excluded): delivered / already empty / genuinely unresolved. An
  unresolved group is swept member by member and re-checked; the leader is
  reaped with a bounded `WNOHANG` wait. Anything still unverified is recorded
  (`attention=1` in the run record) and reported as exit code `126`, so "cannot
  confirm" is a result instead of a hang. Setup failures stay `125`.
* **Exactly one terminal outcome per child** (`Core/OwnedChildProcess.swift`):
  a lost `waitpid`, a helper killed on a signal, and a forced reclaim now
  produce a terminal `ChildExit` with a reason, instead of a silent return that
  left callers waiting forever.
* **Bounded stop escalation** (`Core/ProcessSupervisor.swift`): graceful group
  `SIGTERM` → helper force control → reclaim (signal the recorded group,
  `SIGKILL` the helper, verify). Every rung is time-boxed, every outcome is
  reported, and every outcome releases the client gate.
* **Durable reclaim handle** (`Core/RunRecord.swift`, new): the helper records
  helper pid, workload pid and the workload's process group under
  `<state-dir>/run/`. Startup reclaims leftovers from earlier launches; **Force
  Stop** and **Clean Up Leftover Processes** are always available; a client
  start refuses to run a second client on top of an unverifiable leftover. No
  PID is signalled before its identity is verified (uid, `p_comm`, process
  group, start time), so PID/pgid reuse cannot cause a stray kill.
* **Quit always completes**: `applicationShouldTerminate` and `quit()` carry a
  hard deadline that replies anyway after a bounded hard sweep. "Refusing to
  terminate" is no longer a state the app can get stuck in.
* **The control signals are never inherited as ignored**: the launcher now asks
  `posix_spawn` to reset `SIGTERM`/`SIGINT`/`SIGUSR1` to their default
  disposition in the child (`POSIX_SPAWN_SETSIGDEF`). A launcher that ignores
  `SIGINT` (a non-interactive shell, for example) otherwise makes an immediate
  cancellation be discarded by the kernel before the child can install its
  handler, which turned a "stop it now" request into a 60-second wait.
* **Cleanup reporting is not racy**: after the final group `SIGKILL`, the helper
  allows a bounded settle (0.5 s) for descendants to leave the process table
  before calling the cleanup unverified, so an ordinary stop no longer reports
  attention because a just-killed child was still visible.

### Policy change (explicit)

Previous rule: *fail closed — retain ownership and the operation gate forever*.
On this failure mode that made the app permanently unusable with no recovery
path. New rule: *always stop, always report* — cleanup that cannot be verified
is forced, surfaced in the log and the Connection tab, and enforced before the
next client start.

### Verification actually run here (macOS workstation, live install)

* `macos-client/tests/macos-stop-guarantees.sh` (new): **12 passed, 0 failed**.
  Production helper compiled `-Wall -Wextra -Werror`; **25** fast-exit workloads
  all reaped (slowest 257 ms — the old helper hung forever on every one of them);
  run records removed after clean cleanup; workload status passed through;
  `SIGTERM` path cleaned a TERM-resistant descendant (2063 ms), force path 66 ms;
  and a **`SIGSTOP`ped, otherwise unkillable helper plus its group were reclaimed
  from the recorded pgid alone**.
* `python3 macos-client/tests/reviewer3-swift-checks.py`: source invariants plus
  extracted production regressions — reap-before-callback, duplicate Stop, stale
  callbacks, **forced completion releases the gate**, force stop with nothing
  owned clearing a wedged transaction, log buffer bounds.
* `bash macos-client/tests/macos-robustness-checks.sh`: **86 passed, 0 failed**.
* `python3 macos-client/tests/critical-invariants.py` (its Linux-host suite, run
  here with a default `SIGINT` disposition): **25 passed** — including 90
  immediate-after-`posix_spawn` cancellations and the descendant/leader cases.
  Its fixtures assume the launching shell does not ignore `SIGINT`; a
  non-interactive harness shell does, and a signal generated while its
  disposition is `SIG_IGN` is discarded by the kernel before it can become
  pending, which is why that suite must run with a default `SIGINT`.
* `bash macos-client/tests/macos-behavior-checks.sh`: **11 passed, 0 failed**.
* `macos-client/scripts/test.sh` (Swift build + two suites): passed.
* **Live install, hands-free end to end**: a stale run record plus a planted
  leftover process were reclaimed at launch — logged as
  `startup cleanup: 1 run record(s), 1 reclaimed (1 signal(s))` — and the client
  then started normally. The supervisor was then frozen with `SIGSTOP` (the
  previously un-stoppable state) and the app was asked to quit through the real
  AppKit terminate path. It reclaimed the frozen supervisor and exited:

```
[2026-09-13T11:57:20Z] Child exit could not be confirmed by waitpid (errno 10); a terminal result is still reported, so no operation stays blocked on it.
[2026-09-13T11:57:20Z] Shutdown finished with attention: stopped with attention: supervisor had to be reclaimed by force; recorded leftovers were swept
```

  (The duplicated "attention" prefix in that last line was tidied afterwards; the
  sweep and the exit path it reports are unchanged.)

  Afterwards the workstation was verified clean: no app, no helper, no `node`
  process, and no run records left behind. The wedged processes from the report
  were also killed and the same clean state confirmed.
* The installed bundle at `macos-client/OkProxy Client.app` (a gitignored build
  artifact) was refreshed from this build and smoke-tested the same way — start,
  client start, graceful quit, clean exit — so the app the user runs carries the
  fix. The source lives on the workspace branch; `scripts/build.sh --prod`
  reproduces the bundle.

### Limitations stated honestly

* A descendant that deliberately `setsid`/`setpgid`s out of the workload group
  is still not contained; the reclaim path covers the recorded group only.
* Reclaim is verified by enumerating the group and by per-PID identity. If group
  enumeration itself fails, the record is kept and the result is reported as
  unverified rather than assumed clean.
* Exit code `126` is shared with a workload that exits `126` itself; the helper's
  `attention=1` record is what disambiguates, so a missing record means "the
  workload's own status".
* The Linux fixture suite cannot exercise Darwin's EPERM classification, which is
  why `tests/macos-stop-guarantees.sh` exists and must run on macOS; it skips
  cleanly elsewhere.
* The in-app **Stop Client / Force Stop / menu** controls were exercised only
  through the app's own terminate path on this workstation: the macOS GUI agent
  has no Control grant for this app, and the per-app prompt needs a person at the
  keyboard, so a click on the status-bar item was not driven. The clicked actions
  call exactly the same `stop`/`forceStop` code paths that the live quit test and
  the extracted runtime regressions cover.
* No other device, deployment, commit or push was touched.
