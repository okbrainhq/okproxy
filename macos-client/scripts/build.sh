#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BASENAME="OkProxy Client"
EXECUTABLE_NAME="OkProxyClient"
ENV="dev"
for arg in "$@"; do
  case "$arg" in
    --prod) ENV="prod" ;;
    --dev) ENV="dev" ;;
  esac
done
if [[ "$ENV" == "prod" ]]; then
  APP_NAME="$APP_BASENAME"
  PLIST="$ROOT/Info.plist"
else
  APP_NAME="$APP_BASENAME-Dev"
  PLIST="$ROOT/Info-Dev.plist"
fi
APP="$ROOT/$APP_NAME.app"
BINARY="$ROOT/.build/release/$EXECUTABLE_NAME"
cd "$ROOT"
export CODE_SIGNING_ALLOWED=NO
export CODE_SIGN_IDENTITY="-"
swift build -c release
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/$EXECUTABLE_NAME"
cp "$PLIST" "$APP/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP"
plutil -lint "$APP/Contents/Info.plist"
echo "Built $APP"
