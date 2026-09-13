#!/usr/bin/env bash
# Behavioural checks for the macOS client's non-Swift moving parts.
#
# Unlike macos-robustness-checks.sh (which greps sources), this script actually
# EXECUTES the embedded Node.js install script against a local fixture HTTP
# server and exercises the build-lock helper. That covers the audit items that
# can be verified without a Swift/AppKit toolchain:
#
#   * checksum mismatch / missing checksum fail closed and never damage the
#     existing install;
#   * a staged install is validated before the swap (no backup deleted early);
#   * an activated-but-broken install rolls back to the retained backup;
#   * an interrupted transaction is recovered on the next run;
#   * the build lock recovers a stale owner and its signal traps exit.
#
# Limitation: Swift/AppKit behaviour (UI, process groups, main-actor logic) is
# NOT covered here — see docs/macos-fixes.md for the Mac validation commands.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s\n' "$1"; }

work="$(mktemp -d)"
server_pid=""
cleanup_all() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup_all EXIT

echo "== macOS client behaviour checks =="
echo "root: $ROOT"
echo

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  skip "behaviour checks need python3, curl and tar"
  echo
  echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
  exit 0
fi

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    return 1
  fi
}

free_port() {
  python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
}

machine_arch() {
  case "$(uname -m)" in
    arm64) echo "arm64" ;;
    x86_64) echo "x64" ;;
    *) echo "" ;;
  esac
}

# --- Extract the embedded install script, parameterising the Swift values ----
extract_node_install_script() { # <output path>
  python3 - "$ROOT/Sources/OkProxyClient/Core/AppModel.swift" "$1" <<'PY'
import os
import re
import sys

src_path, out_path = sys.argv[1], sys.argv[2]
src = open(src_path, encoding="utf-8").read()

marker = "private func installLatestNode"
start = src.index(marker)
open_marker = src.index('"""', start) + 3
first_newline = src.index("\n", open_marker) + 1
close = src.index('"""', first_newline)
body = src[first_newline:close]
if body.endswith("\n"):
    body = body[:-1]
line_start = src.rfind("\n", 0, close) + 1
indent = src[line_start:close]
lines = []
for line in body.split("\n"):
    if line.startswith(indent):
        lines.append(line[len(indent):])
    elif line.strip() == "":
        lines.append("")
    else:
        lines.append(line.lstrip(" "))
text = "\n".join(lines)

counter = [0]
def substitute(match):
    counter[0] += 1
    return '"${OKPROXY_ARG_%d}"' % counter[0]

text = re.sub(r"\\\(([^)]*)\)", substitute, text)
text = text.replace("\\\\", "\\").replace('\\"', '"')
if counter[0] != 3:
    raise SystemExit("expected 3 Swift interpolations, found %d" % counter[0])
with open(out_path, "w", encoding="utf-8") as handle:
    handle.write(text + "\n")
PY
}

script="$work/node-install.sh"
if ! extract_node_install_script "$script"; then
  fail "embedded Node.js install script extracted with 3 parameterised paths"
  echo
  echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
  exit 1
fi
pass "embedded Node.js install script extracted with 3 parameterised paths"

VERSION="v9.9.9"
ARCH="$(machine_arch)"
if [[ -z "$ARCH" ]]; then
  skip "node install behaviour checks on unsupported architecture $(uname -m)"
  echo
  echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
  exit 0
fi
TARBALL="node-${VERSION}-darwin-${ARCH}.tar.gz"
serve="$work/serve"
mkdir -p "$serve/$VERSION"
printf '[{"version":"%s","lts":"Test"}]\n' "$VERSION" >"$serve/index.json"

make_package() { # <mode: good|failWhenInstalled>
  local mode="$1"
  local pkg="$work/pkg"
  local bin="$pkg/node-${VERSION}-darwin-${ARCH}/bin"
  rm -rf "$pkg"
  mkdir -p "$bin"
  if [[ "$mode" == "failWhenInstalled" ]]; then
    cat >"$bin/node" <<'NODE'
#!/bin/sh
case "$0" in
  */node/bin/node) echo "v9.9.9-installed-broken"; exit 1 ;;
esac
echo "v9.9.9"
NODE
  else
    printf '#!/bin/sh\necho "%s"\n' "$VERSION" >"$bin/node"
  fi
  chmod +x "$bin/node"
  tar -czf "$serve/$VERSION/$TARBALL" -C "$pkg" "node-${VERSION}-darwin-${ARCH}"
}

write_shasums() { # <mode: good|wrong|missing>
  local file="$serve/$VERSION/SHASUMS256.txt"
  case "$1" in
    good) printf '%s  %s\n' "$(sha256_of "$serve/$VERSION/$TARBALL")" "$TARBALL" >"$file" ;;
    wrong) printf '%064d  %s\n' 0 "$TARBALL" >"$file" ;;
    missing) printf '%064d  other-file.tar.gz\n' 0 >"$file" ;;
  esac
}

seed_existing_install() { # <state dir>
  local state="$1"
  mkdir -p "$state/node/bin"
  echo "keep-me" >"$state/node/marker"
  printf '#!/bin/sh\necho "v0.0.1"\n' >"$state/node/bin/node"
  chmod +x "$state/node/bin/node"
}

run_install() { # <state dir> <dist base> -> writes $work/out.log
  local state="$1"
  local base="$2"
  OKPROXY_ARG_1="$state/node" \
    OKPROXY_ARG_2="$state/node/bin/node" \
    OKPROXY_ARG_3="$state" \
    OKPROXY_NODE_DIST_BASE="$base" \
    bash "$script" >"$work/out.log" 2>&1
}

port="$(free_port)"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$serve" >/dev/null 2>&1 &
server_pid=$!
ready=0
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$port/index.json" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" != "1" ]]; then
  fail "fixture HTTP server started"
  echo
  echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
  exit 1
fi
pass "fixture HTTP server started"
DIST_BASE="http://127.0.0.1:$port"
closed_base="http://127.0.0.1:$(free_port)/dist"

# --- 1. happy path ----------------------------------------------------------
make_package good
write_shasums good
state="$work/state-ok"
mkdir -p "$state"
if run_install "$state" "$DIST_BASE"; then
  if [[ -x "$state/node/bin/node" ]] \
    && grep -q "Verified SHA-256 checksum" "$work/out.log" \
    && grep -q "Staged Node.js validated" "$work/out.log" \
    && [[ ! -e "$state/node.previous" ]] && [[ ! -e "$state/node.staging" ]]; then
    pass "fresh install verifies the checksum, validates staging and leaves no leftovers"
  else
    fail "fresh install verifies the checksum, validates staging and leaves no leftovers"
    sed 's/^/      /' "$work/out.log"
  fi
else
  fail "fresh install succeeds (exit $?)"
  sed 's/^/      /' "$work/out.log"
fi

# --- 2. checksum mismatch is fail-closed and non-destructive ----------------
state="$work/state-mismatch"
seed_existing_install "$state"
make_package good
write_shasums wrong
if run_install "$state" "$DIST_BASE"; then
  fail "checksum mismatch refuses to install"
else
  if grep -q "Checksum mismatch" "$work/out.log" \
    && [[ -f "$state/node/marker" ]] \
    && grep -q "v0.0.1" "$state/node/bin/node"; then
    pass "checksum mismatch refuses to install and keeps the working install"
  else
    fail "checksum mismatch refuses to install and keeps the working install"
    sed 's/^/      /' "$work/out.log"
  fi
fi

# --- 3. missing checksum entry is fail-closed ------------------------------
state="$work/state-nosum"
seed_existing_install "$state"
write_shasums missing
if run_install "$state" "$DIST_BASE"; then
  fail "missing published checksum refuses to install"
else
  if grep -q "No published SHA-256 checksum" "$work/out.log" \
    && [[ -f "$state/node/marker" ]] \
    && grep -q "v0.0.1" "$state/node/bin/node"; then
    pass "missing published checksum refuses to install and keeps the working install"
  else
    fail "missing published checksum refuses to install and keeps the working install"
    sed 's/^/      /' "$work/out.log"
  fi
fi

# --- 4. staged validation happens BEFORE the backup is dropped -------------
state="$work/state-rollback"
seed_existing_install "$state"
make_package failWhenInstalled
write_shasums good
if run_install "$state" "$DIST_BASE"; then
  fail "a node that only fails once installed is rejected"
else
  if grep -q "previous version restored" "$work/out.log" \
    && [[ -f "$state/node/marker" ]] \
    && grep -q "v0.0.1" "$state/node/bin/node"; then
    pass "post-activation validation failure rolls back to the retained backup"
  else
    fail "post-activation validation failure rolls back to the retained backup"
    sed 's/^/      /' "$work/out.log"
  fi
fi

# --- 5. interrupted transaction is recovered on the next run --------------
state="$work/state-recover"
mkdir -p "$state/node.previous/bin"
echo "recovered" >"$state/node.previous/marker"
printf '#!/bin/sh\necho "v0.0.1"\n' >"$state/node.previous/bin/node"
chmod +x "$state/node.previous/bin/node"
if run_install "$state" "$closed_base"; then
  fail "unreachable release index fails the install"
else
  if [[ -f "$state/node/marker" ]] && [[ ! -e "$state/node.previous" ]]; then
    pass "an interrupted install is recovered from .previous on the next run"
  else
    fail "an interrupted install is recovered from .previous on the next run"
    sed 's/^/      /' "$work/out.log"
  fi
fi

# --- 6. build lock: stale owner recovery ---------------------------------
lib="$ROOT/scripts/lib/build-lock.sh"
if [[ -f "$lib" ]]; then
  lock_dir="$work/build-lock"
  # A real separate process, deliberately WITHOUT an EXIT trap: this simulates a
  # build that was SIGKILLed and therefore could not release its lock.
  holder_script="$work/holder.sh"
  cat >"$holder_script" <<'SH'
set -euo pipefail
source "$1"
okproxy_acquire_build_lock "$2" 5
sleep 30
SH
  bash "$holder_script" "$lib" "$lock_dir" >/dev/null 2>&1 &
  holder=$!
  sleep 1
  if (
    # shellcheck disable=SC1090
    source "$lib"
    okproxy_acquire_build_lock "$lock_dir" 2
  ) >/dev/null 2>&1; then
    fail "build lock refuses a second owner while the first is alive"
  else
    pass "build lock refuses a second owner while the first is alive"
  fi
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
  if (
    # shellcheck disable=SC1090
    source "$lib"
    okproxy_acquire_build_lock "$lock_dir" 10
  ) >/dev/null 2>&1; then
    pass "build lock recovers a lock whose owner is gone"
  else
    fail "build lock recovers a lock whose owner is gone"
  fi
  rm -rf "$lock_dir"

  # --- 7. build lock: signal trap releases and exits -----------------------
  signal_script="$work/signal-holder.sh"
  cat >"$signal_script" <<'SH'
set -euo pipefail
source "$1"
trap 'okproxy_release_build_lock' EXIT
trap 'okproxy_release_build_lock; exit 130' INT
trap 'okproxy_release_build_lock; exit 143' TERM
okproxy_acquire_build_lock "$2" 5
kill -TERM $$
sleep 30
SH
  bash "$signal_script" "$lib" "$work/build-lock-signal" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" == "143" ]] && [[ ! -e "$work/build-lock-signal" ]]; then
    pass "build lock signal trap exits (rc=$rc) and releases the lock"
  else
    fail "build lock signal trap exits (rc=$rc) and releases the lock"
  fi

  # --- 8. build lock: normal exit releases --------------------------------
  normal_script="$work/normal-holder.sh"
  cat >"$normal_script" <<'SH'
set -euo pipefail
source "$1"
trap 'okproxy_release_build_lock' EXIT
okproxy_acquire_build_lock "$2" 5
SH
  bash "$normal_script" "$lib" "$work/build-lock-normal" >/dev/null 2>&1
  if [[ ! -e "$work/build-lock-normal" ]]; then
    pass "build lock is released on normal exit"
  else
    fail "build lock is released on normal exit"
  fi
else
  fail "build lock helper exists at scripts/lib/build-lock.sh"
fi

echo
echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
[[ "$FAIL" -eq 0 ]]
