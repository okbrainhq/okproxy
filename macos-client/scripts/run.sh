#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV="dev"
for arg in "$@"; do
  case "$arg" in
    --prod) ENV="prod" ;;
    --dev) ENV="dev" ;;
  esac
done
if [[ "$ENV" == "prod" ]]; then
  APP="$ROOT/OkProxy Client.app"
else
  APP="$ROOT/OkProxy Client-Dev.app"
fi
if [[ ! -d "$APP" ]]; then
  "$ROOT/scripts/build.sh" "--$ENV"
fi
# Use plain `open` (never `open -n`) so LaunchServices activates an existing
# instance instead of launching a second copy that would share the same state
# directory, config and log. The app also holds an flock on
# <state-dir>/app.lock as a backstop against duplicate instances.
open "$APP"
