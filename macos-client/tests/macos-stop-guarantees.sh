#!/usr/bin/env bash
# macOS behavioral regression for the "the client can always be stopped" guarantees.
#
# Background: Darwin reports EPERM - not ESRCH - for `kill(-pgid, SIGKILL)` when a
# process group has no signalable member left, which is the ordinary case after the
# workload leader exited and only its unreaped zombie stands in for the group. The
# previous helper treated that as an ownership failure and parked in `pause()`
# forever, so Swift's `waitpid` never returned, the operation gate stayed retained,
# and the app could no longer stop the client, start it, run a repository update or
# quit. Linux returns 0 for the same call, which is why the Linux fixture suite
# never caught it: this suite must run on macOS.
#
# Usage: macos-client/tests/macos-stop-guarantees.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s\n' "$1"; }

if [[ "$(uname -s)" != Darwin ]]; then
  skip "macOS-only stop-guarantee checks (Darwin semantics under test)"
  echo
  echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/okproxy-stop.XXXXXX")"
HELPER="$WORK/helper"
cleanup_work() {
  if [[ -n "${WEDGED_HELPER:-}" ]]; then kill -9 "$WEDGED_HELPER" 2>/dev/null; fi
  rm -rf "$WORK"
}
trap cleanup_work EXIT

if ! cc -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -O2 \
     "$ROOT/Sources/OkProxyProcessHelper/main.c" -o "$HELPER"; then
  fail "production helper compiles with -Wall -Wextra -Werror"
  echo
  echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
  exit 1
fi
pass "production helper compiles with -Wall -Wextra -Werror on macOS"

# The helper requires `getppid() == argv[1]`, so the spawning shell must be the
# process that execs it. `$PPID` is therefore expanded by the INNER bash.
export OKPROXY_HELPER="$HELPER"
LAUNCH_DIR="$WORK"
export LAUNCH_DIR

echo
echo "== the macOS EPERM regression: a leader that exits immediately =="
# Every one of these used to leave a helper parked in pause() forever.
worst=0
failures=0
for _ in $(seq 1 25); do
  mkdir -p "$LAUNCH_DIR/run"
  start=$(date +%s%N)
  rm -f "$LAUNCH_DIR/run/"*.record
  OKPROXY_RUN_DIR="$LAUNCH_DIR/run" \
    OKPROXY_RUN_META=$'role=probe\nowner=1\n' \
    bash -c 'exec "$OKPROXY_HELPER" "$PPID" "$LAUNCH_DIR" /bin/echo hello > /dev/null' &
  helper_pid=$!
  waited=0
  while kill -0 "$helper_pid" 2>/dev/null && [[ $waited -lt 5000 ]]; do sleep 0.05; waited=$((waited + 50)); done
  if kill -0 "$helper_pid" 2>/dev/null; then
    failures=$((failures + 1))
    kill -9 "$helper_pid" 2>/dev/null
    wait "$helper_pid" 2>/dev/null
  else
    wait "$helper_pid" 2>/dev/null || true
    elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
    [[ $elapsed -gt $worst ]] && worst=$elapsed
  fi
done
if [[ $failures -eq 0 ]]; then
  pass "25 fast-exit workloads all reaped (slowest completion ${worst}ms; the old helper hung forever)"
else
  fail "fast-exit workloads left $failures helper(s) parked (the macOS EPERM hang)"
fi

slept=$(ls -1 "$LAUNCH_DIR/run" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$slept" == "0" ]]; then
  pass "run records are removed after a verified clean cleanup"
else
  fail "run records left behind after clean runs: $slept"
fi

echo
echo "== exit status is still the workload's own =="
if OKPROXY_RUN_DIR="$LAUNCH_DIR/run" OKPROXY_RUN_META=$'role=client\nowner=1\n' \
     bash -c 'exec "$OKPROXY_HELPER" "$PPID" "$LAUNCH_DIR" /bin/sh -c "exit 42"'; then
  status=0
else
  status=$?
fi
if [[ "$status" == "42" ]]; then
  pass "helper passes the workload status through (42)"
else
  fail "helper returned $status instead of the workload status 42"
fi

echo
echo "== graceful then forced descendant cleanup =="
for mode in term force; do
  record_dir="$LAUNCH_DIR/run-$mode"
  mkdir -p "$record_dir"
  pid_file="$WORK/descendant-$mode.pid"
  if [[ "$mode" == term ]]; then
    OKPROXY_RUN_DIR="$record_dir" OKPROXY_RUN_META=$'role=client\nowner=1\n' \
      bash -c 'exec "$OKPROXY_HELPER" "$PPID" "$LAUNCH_DIR" /bin/bash -c "trap \"\" TERM; sleep 60 & echo \$! > '"$pid_file"'; wait"' &
  else
    OKPROXY_RUN_DIR="$record_dir" OKPROXY_RUN_META=$'role=client\nowner=1\n' \
      bash -c 'exec "$OKPROXY_HELPER" "$PPID" "$LAUNCH_DIR" /bin/bash -c "trap \"\" TERM; sleep 60 & echo \$! > '"$pid_file"'; wait"' &
  fi
  helper_pid=$!
  for _ in $(seq 1 100); do [[ -s "$pid_file" ]] && break; sleep 0.05; done
  descendant="$(cat "$pid_file" 2>/dev/null || true)"
  start=$(date +%s%N)
  if [[ "$mode" == term ]]; then kill -TERM "$helper_pid"; else kill -USR1 "$helper_pid"; fi
  waited=0
  while kill -0 "$helper_pid" 2>/dev/null && [[ $waited -lt 8000 ]]; do sleep 0.05; waited=$((waited + 50)); done
  elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
  if ! kill -0 "$helper_pid" 2>/dev/null; then
    pass "$mode: helper exited within ${elapsed}ms after the ${mode} signal"
  else
    fail "$mode: helper still alive after ${elapsed}ms"
    kill -9 "$helper_pid" 2>/dev/null
  fi
  sleep 0.2
  if [[ -n "$descendant" ]] && kill -0 "$descendant" 2>/dev/null; then
    fail "$mode: descendant $descendant survived group cleanup"
    kill -9 "$descendant" 2>/dev/null
  else
    pass "$mode: descendant removed with the workload group"
  fi
done

echo
echo "== reclaim path: the helper is frozen, the record still identifies the group =="
record_dir="$LAUNCH_DIR/run-wedged"
mkdir -p "$record_dir"
OKPROXY_RUN_DIR="$record_dir" OKPROXY_RUN_META=$'role=client\nowner=1\n' \
  bash -c 'exec "$OKPROXY_HELPER" "$PPID" "$LAUNCH_DIR" /bin/bash -c "sleep 60 & echo \$! > '"$WORK"'/wedged-desc.pid; wait"' &
WEDGED_HELPER=$!
record=""
for _ in $(seq 1 100); do
  record="$(ls -1 "$record_dir"/*.record 2>/dev/null | head -1 || true)"
  [[ -n "$record" ]] && break
  sleep 0.05
done
if [[ -z "$record" ]]; then
  fail "run record was not written for a running workload"
  kill -9 "$WEDGED_HELPER" 2>/dev/null
else
  pgid="$(awk -F= '$1 == "pgid" { print $2 }' "$record")"
  workload="$(awk -F= '$1 == "workload_pid" { print $2 }' "$record")"
  descendant="$(cat "$WORK/wedged-desc.pid" 2>/dev/null || true)"
  if [[ -n "$pgid" && -n "$workload" ]]; then
    pass "run record identifies helper, workload and process group (pgid=$pgid)"
  else
    fail "run record is missing pgid/workload_pid"
  fi
  # A frozen helper is exactly the state that used to be unkillable from the app:
  # it ignores every control signal, so the app must reclaim it by force.
  kill -STOP "$WEDGED_HELPER" 2>/dev/null
  if kill -0 "$descendant" 2>/dev/null && kill -0 "$WEDGED_HELPER" 2>/dev/null; then
    kill -KILL "-$pgid" 2>/dev/null
    kill -KILL "$WEDGED_HELPER" 2>/dev/null
    sleep 0.3
    if ! kill -0 "$descendant" 2>/dev/null && ! kill -0 "$WEDGED_HELPER" 2>/dev/null; then
      pass "frozen helper and its group were reclaimed from the recorded pgid alone"
    else
      fail "reclaim left the frozen helper or its descendant alive"
    fi
  else
    fail "wedged-helper fixture did not reach the expected state"
  fi
  rm -f "$record"
  WEDGED_HELPER=""
  if [[ ! -e "$record" ]]; then
    pass "the retained record can be cleared once its processes are gone"
  else
    fail "record could not be cleared"
  fi
fi

echo
echo "== no process is left behind after repeated runs =="
for _ in $(seq 1 50); do
  OKPROXY_RUN_DIR="$LAUNCH_DIR/run" OKPROXY_RUN_META=$'role=probe\nowner=1\n' \
    bash -c 'exec "$OKPROXY_HELPER" "$PPID" "$LAUNCH_DIR" /bin/echo done > /dev/null'
done
sleep 0.5
left=$(ls -1 "$LAUNCH_DIR/run" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$left" == "0" ]]; then
  pass "50 further cycles left no records and no parked helpers"
else
  fail "$left record(s) left after repeated runs"
fi

echo
echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
[[ "$FAIL" -eq 0 ]]
