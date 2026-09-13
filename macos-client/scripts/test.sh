#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CLANG_MODULE_CACHE_PATH="$ROOT/.build/clang-module-cache"
export SWIFTPM_HOME="$ROOT/.build/swiftpm-home"
mkdir -p "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_HOME"
build_log="$(mktemp)"
if ! (cd "$ROOT" && swift build) >"$build_log" 2>&1; then
  # SwiftPM applies its own sandbox, which cannot nest inside a harness sandbox
  # (macOS agent hosts). The outer sandbox still confines the build either way.
  if grep -q 'sandbox_apply: Operation not permitted' "$build_log"; then
    (cd "$ROOT" && swift build --disable-sandbox)
  else
    cat "$build_log"
    exit 1
  fi
fi
rm -f "$build_log"
python3 "$ROOT/tests/reviewer3-swift-checks.py"
bash "$ROOT/tests/macos-stop-guarantees.sh"
printf '\nSwift build and focused regression checks passed.\n'
