#!/usr/bin/env bash
# Atomic build lock with stale-owner recovery, for macOS (no flock(1)).
#
# Sourced by scripts/build.sh and exercised directly by
# tests/macos-behavior-checks.sh.
#
# Layout: <lock_dir>/pid holds the PID of the owning build. A lock whose owner
# PID is no longer present (SIGKILLed build, reboot) is stale and is removed.
# Liveness is checked with `ps -p`, which works for other users' processes too
# (unlike `kill -0`, which can fail with EPERM for a live process).

OKPROXY_BUILD_LOCK=""

okproxy_build_lock_owner() { # <lock_dir>
  cat "$1/pid" 2>/dev/null || true
}

okproxy_build_lock_owner_alive() { # <pid>
  [[ -n "$1" ]] && ps -p "$1" >/dev/null 2>&1
}

okproxy_acquire_build_lock() { # <lock_dir> [timeout_seconds]
  local lock_dir="$1"
  local timeout="${2:-300}"
  local waited=0
  local owner

  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      # BASHPID (bash 4+) is correct even when the helper is sourced; bash 3.2
      # falls back to $$ which is correct when build.sh runs as its own process.
      printf '%s\n' "${BASHPID:-$$}" >"$lock_dir/pid"
      OKPROXY_BUILD_LOCK="$lock_dir"
      return 0
    fi

    owner="$(okproxy_build_lock_owner "$lock_dir")"
    if [[ -z "$owner" ]]; then
      # The owner may be between mkdir and writing its pid; re-check once.
      sleep 1
      owner="$(okproxy_build_lock_owner "$lock_dir")"
    fi

    if [[ -n "$owner" ]] && ! okproxy_build_lock_owner_alive "$owner"; then
      echo "Removing stale build lock at $lock_dir (owner $owner is gone)" >&2
      rm -rf "$lock_dir"
      continue
    fi

    if ((waited >= timeout)); then
      echo "Another build has held $lock_dir for ${timeout}s (owner ${owner:-unknown}); aborting." >&2
      return 1
    fi

    sleep 1
    waited=$((waited + 1))
  done
}

okproxy_release_build_lock() {
  [[ -n "$OKPROXY_BUILD_LOCK" ]] || return 0
  rm -rf "$OKPROXY_BUILD_LOCK"
  OKPROXY_BUILD_LOCK=""
}
