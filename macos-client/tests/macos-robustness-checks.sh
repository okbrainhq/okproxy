#!/usr/bin/env bash
# macOS robustness source checks for the OkProxy macOS client.
#
# These checks are static/source-level (plus bash syntax and XML well-formedness)
# because the Linux build host cannot compile or run the SwiftUI/AppKit client.
# They assert that the audited fixes are present and that the forbidden patterns
# (name-based process killing, duplicate dev launch) are gone.
#
# Usage: macos-client/tests/macos-robustness-checks.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/Sources/OkProxyClient"
PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s\n' "$1"; }

check_contains() { # file pattern description
  if [[ ! -f "$1" ]]; then
    fail "$3 (missing file: ${1#"$ROOT"/})"
  elif grep -Eq -- "$2" "$1"; then
    pass "$3"
  else
    fail "$3 (pattern '$2' not found in ${1#"$ROOT"/})"
  fi
}

check_absent_in_tree() { # dir pattern description
  # Ignore comment-only mentions (docs/comments describe the forbidden pattern).
  local hits
  hits="$(grep -rEn --include='*.swift' -- "$2" "$1" 2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*//' || true)"
  if [[ -n "$hits" ]]; then
    fail "$3"
    printf '      %s\n' "$hits"
  else
    pass "$3"
  fi
}

echo "== macOS client robustness checks =="
echo "root: $ROOT"
echo

# --- Lifecycle / ownership ---------------------------------------------------
check_contains "$SRC/Core/ProcessSupervisor.swift" 'terminateAllNow' \
  "central lifecycle exposes a synchronous quit sweep"
check_contains "$SRC/Core/ProcessSupervisor.swift" 'SIGTERM' \
  "graceful termination uses SIGTERM"
check_contains "$SRC/Core/ProcessSupervisor.swift" 'SIGKILL' \
  "termination escalates to SIGKILL"
check_contains "$SRC/Core/ProcessSupervisor.swift" 'role == \.setup && hasRunningSetup' \
  "setup operations are serialized (single setup role)"
check_contains "$SRC/Core/OwnedChildProcess.swift" 'POSIX_SPAWN_SETPGROUP' \
  "children are isolated in their own process group via posix_spawn"
check_contains "$ROOT/Sources/OkProxyProcessHelper/main.c" 'kill\(-pgid, signal_number\)' \
  "termination signals the owned process group, not just the bash PID"
check_contains "$SRC/Core/OwnedChildProcess.swift" 'waitpid\(' \
  "ownership is released only after waitpid confirms exit"
check_contains "$ROOT/Sources/OkProxyProcessHelper/main.c" 'setpgid\(0, 0\)' \
  "the app's own process group is never signalled"
check_absent_in_tree "$SRC" '\b(pkill|pgrep|killall)\b' \
  "no name-based/global process killing"
check_contains "$SRC/OkProxyClientApp.swift" 'applicationWillTerminate' \
  "app termination performs a final child-process sweep"

# --- Guaranteed stop (the macOS killpg EPERM hang) ---------------------------
check_contains "$ROOT/Sources/OkProxyProcessHelper/main.c" 'EPERM' \
  "the helper classifies Darwin's killpg EPERM instead of failing closed"
check_contains "$ROOT/Sources/OkProxyProcessHelper/main.c" 'HELPER_CLEANUP_ATTENTION' \
  "the helper reports incomplete cleanup with a distinct exit code"
if grep -qE '^[[:space:]]*pause\(\);' "$ROOT/Sources/OkProxyProcessHelper/main.c" ||
   grep -q 'okproxy helper ownership failure' "$ROOT/Sources/OkProxyProcessHelper/main.c"; then
  fail "the helper never parks itself forever (found the old fail-closed park)"
else
  pass "the helper never parks itself forever (no pause() park)"
fi
check_contains "$SRC/Core/OwnedChildProcess.swift" 'func terminalOutcome()' \
  "every child reaches exactly one terminal outcome"
check_contains "$SRC/Core/ProcessSupervisor.swift" 'static func forceReclaim' \
  "stop escalates to reclaiming the helper itself"
check_contains "$SRC/Core/ProcessSupervisor.swift" 'case confirmedClean' \
  "stop reports an explicit terminal outcome"
check_contains "$SRC/Core/RunRecord.swift" 'KERN_PROC_PGRP' \
  "recorded process groups are enumerated through the kernel"
check_contains "$SRC/Core/RunRecord.swift" 'matchesExecutable' \
  "no PID is signalled before its identity is verified"
check_contains "$SRC/Core/AppModel.swift" 'func forceStopClient()' \
  "an always-available force stop exists"
check_contains "$SRC/Core/AppModel.swift" 'private func completeStop' \
  "every stop outcome releases the client gate"
check_contains "$SRC/OkProxyClientApp.swift" 'reply\(toApplicationShouldTerminate: true\)' \
  "AppKit termination always replies, even after the hard deadline"
check_absent_in_tree "$SRC" 'Stop timed out or ownership failed' \
  "a stop timeout no longer leaves the client gate retained"
check_absent_in_tree "$SRC" 'shutdown gate retained' \
  "a shutdown timeout no longer refuses to terminate"
if [[ -f "$ROOT/tests/macos-stop-guarantees.sh" ]]; then
  pass "the macOS stop-guarantee behavioral suite is shipped"
else
  fail "the macOS stop-guarantee behavioral suite is shipped"
fi

# --- Single instance --------------------------------------------------------
check_contains "$SRC/Core/SingleInstanceGuard.swift" 'flock\(descriptor, LOCK_EX [|] LOCK_NB\)' \
  "single-instance guard uses a non-blocking exclusive flock"
check_contains "$SRC/OkProxyClientApp.swift" 'alreadyRunning' \
  "duplicate instance exits instead of sharing config/log"
check_contains "$ROOT/scripts/run.sh" 'open "\$APP"' \
  "dev launcher uses plain open"
if grep -Eq -- '^[[:space:]]*open[[:space:]]+-n' "$ROOT/scripts/run.sh"; then
  fail "dev launcher does not force duplicate instances (found 'open -n')"
else
  pass "dev launcher does not force duplicate instances"
fi

# --- Logging ----------------------------------------------------------------
check_contains "$SRC/Core/IncrementalUTF8Decoder.swift" 'incompleteSuffixCount' \
  "incremental UTF-8 decoder withholds split scalars"
check_contains "$SRC/Core/ShellRunner.swift" 'decoder\.decode\(' \
  "pipe reader decodes incrementally"
check_contains "$SRC/Core/ShellRunner.swift" 'removeFirst\(overflow\)' \
  "child output buffer is bounded (drops oldest)"
check_contains "$SRC/Core/ShellRunner.swift" 'Data\(bytes.suffix\(maxBytes\)\)' \
  "incoming UTF-8 storage is byte bounded during synchronous append"
check_contains "$SRC/Core/ShellRunner.swift" 'deliveryInFlight' \
  "only one log delivery is outstanding at a time"
check_contains "$SRC/Core/ShellRunner.swift" 'earlier UTF-8 bytes were dropped' \
  "bounded byte deliveries include an explicit overflow marker"
check_contains "$SRC/Core/LogStore.swift" 'diskQueue\.async' \
  "log disk writes happen off the main thread"
check_contains "$SRC/Core/LogStore.swift" 'maxTotalCharacters' \
  "log history is bounded by total characters"
check_contains "$SRC/Core/LogStore.swift" 'beginQueuedWrite' \
  "log writes are capped before they are enqueued"
check_contains "$SRC/Core/LogStore.swift" 'maxPayloadCharacters' \
  "log payload size is bounded before enqueue"
check_contains "$SRC/Core/LogStore.swift" 'takeOverflowNotice' \
  "dropped log output is reported explicitly"
check_contains "$SRC/Core/LogStore.swift" 'String\(decoding: initialLog\.data, as: UTF8\.self\)' \
  "log tail decoding is byte-safe"
check_contains "$SRC/Core/LogStore.swift" 'generation' \
  "in-flight log writes are invalidated by clear()"
check_contains "$SRC/UI/LogsView.swift" 'storage\.append' \
  "log view appends incrementally instead of full redraw"

# --- Node.js install --------------------------------------------------------
check_contains "$SRC/Core/AppModel.swift" 'SHASUMS256\.txt' \
  "node install downloads published checksums"
check_contains "$SRC/Core/AppModel.swift" 'shasum -a 256' \
  "node install verifies SHA-256"
check_contains "$SRC/Core/AppModel.swift" 'No published SHA-256 checksum' \
  "node install fails closed when checksums are missing"
check_contains "$SRC/Core/AppModel.swift" 'Checksum mismatch' \
  "node install fails closed on checksum mismatch"
check_contains "$SRC/Core/AppModel.swift" '\.staging' \
  "node install stages into a transactional directory"
check_contains "$SRC/Core/AppModel.swift" 'STAGED_VERSION' \
  "staged node binary is version-validated before the swap"
check_contains "$SRC/Core/AppModel.swift" 'Activated Node\.js failed validation' \
  "activating a validated copy can still roll back to the retained backup"
check_contains "$SRC/Core/AppModel.swift" 'recoverNodeTransaction' \
  "an interrupted install is recovered on the next run"
check_contains "$SRC/Core/AppModel.swift" 'rm -rf "\$PREV"' \
  "the backup is only removed after post-activation validation"

# --- Setup/start serialization ---------------------------------------------
check_contains "$SRC/Core/OperationGate.swift" 'isShuttingDown' \
  "a central gate blocks new transactions after shutdown"
check_contains "$SRC/Core/AppModel.swift" 'gate\.acquire\(\.setup\)' \
  "setup acquires the central exclusion gate"
check_contains "$SRC/Core/AppModel.swift" 'gate\.acquire\(\.clientStart\)' \
  "client start acquires the central exclusion gate"
check_contains "$SRC/Core/AppModel.swift" 'gate\.acquire\(\.clientStop\)' \
  "client stop acquires the central exclusion gate"
check_contains "$SRC/Core/AppModel.swift" 'gate\.isShuttingDown' \
  "setup/start refuse to run while quitting"
check_contains "$SRC/Core/AppModel.swift" '!isStoppingClient' \
  "setup refuses to run while the client is shutting down"
check_contains "$SRC/Core/AppModel.swift" 'supervisor\.hasRunningSetup' \
  "client start refuses while setup is running"
check_contains "$SRC/Core/AppModel.swift" 'role: \.versionProbe' \
  "the node version probe is a supervised child too"

# --- Build lock -------------------------------------------------------------
check_contains "$ROOT/scripts/lib/build-lock.sh" 'okproxy_acquire_build_lock' \
  "build lock helper is shared and sourceable"
check_contains "$ROOT/scripts/lib/build-lock.sh" 'ps -p' \
  "build lock treats a lock as stale only when its owner is really gone"
check_contains "$ROOT/scripts/build.sh" "okproxy_release_build_lock; exit 130" \
  "build lock INT trap releases and exits"
check_contains "$ROOT/scripts/build.sh" "okproxy_release_build_lock; exit 143" \
  "build lock TERM trap releases and exits"

# --- Version matching -------------------------------------------------------
check_contains "$SRC/Core/SemanticVersion.swift" 'func updateKind' \
  "update availability compares full semantic versions"
check_contains "$SRC/Core/SemanticVersion.swift" 'if latest\.minor != installed\.minor' \
  "minor updates are distinguished from major"
check_contains "$SRC/Core/SemanticVersion.swift" 'latestLTS\(from data: Data\)' \
  "release index is parsed and compared semantically"
check_contains "$SRC/Core/SemanticVersion.swift" 'request\.timeoutInterval' \
  "release index fetch is bounded by a timeout"

# --- Config / paths / IPv6 --------------------------------------------------
check_contains "$SRC/Core/AppSettings.swift" 'decodeIfPresent' \
  "settings decode per-key with defaults"
check_contains "$SRC/Core/AppSettings.swift" 'loadResult' \
  "settings corruption is reported instead of silently wiped"
check_contains "$SRC/Core/AppPaths.swift" 'sanitizedDirectoryName' \
  "plist-derived state directory name is sanitized"
check_contains "$SRC/Core/AppPaths.swift" 'ensureStateDirectories' \
  "state/log directories are created before use"
check_contains "$SRC/Core/Endpoint.swift" 'inet_pton\(AF_INET6' \
  "IPv6 literals are validated with inet_pton"
check_contains "$SRC/Core/Endpoint.swift" 'isIPv6Literal' \
  "IPv6 endpoints serialize in bracketed form"
check_contains "$SRC/Core/AppModel.swift" 'Endpoint\.parse\(settings\.server\)' \
  "client start validates/canonicalizes the server endpoint"

# --- Plist XML well-formedness ---------------------------------------------
for plist in "$ROOT/Info.plist" "$ROOT/Info-Dev.plist"; do
  if [[ ! -f "$plist" ]]; then
    fail "plist exists: ${plist#"$ROOT"/}"
  elif command -v python3 >/dev/null 2>&1; then
    if python3 -c 'import sys, xml.etree.ElementTree as ET; ET.parse(sys.argv[1])' "$plist" 2>/dev/null; then
      pass "plist XML is well-formed: ${plist#"$ROOT"/}"
    else
      fail "plist XML is well-formed: ${plist#"$ROOT"/}"
    fi
  else
    skip "plist XML well-formedness (python3 not available)"
  fi
done

# --- Script syntax ----------------------------------------------------------
for script in "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/*.sh; do
  [[ -f "$script" ]] || continue
  if bash -n "$script"; then
    pass "bash syntax: ${script#"$ROOT"/}"
  else
    fail "bash syntax: ${script#"$ROOT"/}"
  fi
done

# --- Embedded bash scripts (extracted from Swift multi-line strings) ---------
if command -v python3 >/dev/null 2>&1; then
  embedded_dir="$(mktemp -d)"
  if python3 - "$SRC/Core/AppModel.swift" "$embedded_dir" <<'PY'
import os
import re
import sys

src_path, out_dir = sys.argv[1], sys.argv[2]
src = open(src_path, encoding="utf-8").read()


def extract_after(index):
    open_marker = src.index('"""', index) + 3
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
    text = re.sub(r"\\\(([^)]*)\)", '"/tmp/okproxy-embedded-dummy"', text)
    text = text.replace("\\\\", "\\").replace('\\"', '"')
    return text


functions = {
    "clone-repo": "func cloneRepo",
    "update-repo": "func updateRepo",
    "install-latest-node": "private func installLatestNode",
}
for name, marker in functions.items():
    start = src.index(marker)
    script = extract_after(src.index('let script = """', start))
    with open(os.path.join(out_dir, name + ".sh"), "w", encoding="utf-8") as handle:
        handle.write(script + "\n")
PY
  then
    for embedded in "$embedded_dir"/*.sh; do
      [[ -f "$embedded" ]] || continue
      if bash -n "$embedded"; then
        pass "embedded bash script syntax: $(basename "$embedded")"
      else
        fail "embedded bash script syntax: $(basename "$embedded")"
      fi
    done
  else
    fail "could not extract embedded bash scripts from AppModel.swift"
  fi
  rm -rf "$embedded_dir"
else
  skip "embedded bash script syntax (python3 not available)"
fi

# --- Documentation -----------------------------------------------------------
DOC="$ROOT/../docs/macos-fixes.md"
if [[ -f "$DOC" ]]; then
  pass "docs/macos-fixes.md exists"
else
  fail "docs/macos-fixes.md exists"
fi
if [[ -f "$DOC" ]] && grep -q 'Limitations stated honestly' "$DOC" && grep -q 'macos-client/scripts/build.sh' "$DOC"; then
  pass "docs/macos-fixes.md states limitations and Mac validation commands"
else
  fail "docs/macos-fixes.md states limitations and Mac validation commands"
fi

# --- Optional Swift build (only on a macOS/Swift host) ----------------------
if [[ "$(uname -s)" == Darwin ]] && command -v swift >/dev/null 2>&1; then
  build_log="$(mktemp)"
  if (cd "$ROOT" && swift build) >"$build_log" 2>&1; then
    pass "swift build"
  elif grep -q 'sandbox_apply: Operation not permitted' "$build_log" &&
       (cd "$ROOT" && swift build --disable-sandbox) >"$build_log" 2>&1; then
    # SwiftPM applies its own sandbox, which cannot nest inside a harness sandbox.
    pass "swift build (retried with --disable-sandbox: nested sandbox unavailable)"
  else
    fail "swift build"
    sed -n '1,40p' "$build_log"
  fi
  rm -f "$build_log"
else
  skip "swift build (no Swift toolchain on this host; run on macOS or with Swift installed)"
fi

echo
echo "== summary: $PASS passed, $FAIL failed, $SKIP skipped =="
[[ "$FAIL" -eq 0 ]]
