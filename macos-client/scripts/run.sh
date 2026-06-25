#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
if [[ "$ENV" == "prod" ]]; then
  open "$APP"
else
  open -n "$APP"
fi
