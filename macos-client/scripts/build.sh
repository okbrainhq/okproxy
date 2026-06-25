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
  ICON_NAME="OkProxyClient"
else
  APP_NAME="$APP_BASENAME-Dev"
  PLIST="$ROOT/Info-Dev.plist"
  ICON_NAME="OkProxyClientDev"
fi
APP="$ROOT/$APP_NAME.app"
BINARY="$ROOT/.build/release/$EXECUTABLE_NAME"
ICON_BUILD_DIR="$ROOT/.build/icons/$ICON_NAME.iconset"
ICON_FILE="$ROOT/.build/icons/$ICON_NAME.icns"
cd "$ROOT"
export CODE_SIGNING_ALLOWED=NO
export CODE_SIGN_IDENTITY="-"
swift build -c release

rm -rf "$ICON_BUILD_DIR"
mkdir -p "$ICON_BUILD_DIR"
swift - "$ICON_BUILD_DIR" "$ENV" <<'SWIFT'
import AppKit
import Foundation

let outDir = URL(fileURLWithPath: CommandLine.arguments[1])
let env = CommandLine.arguments[2]
let isDev = env == "dev"
let symbolName = isDev ? "network.badge.shield.half.filled" : "network"
let accent = isDev ? NSColor.systemOrange : NSColor.systemBlue
let sizes: [(String, CGFloat)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

func savePNG(_ image: NSImage, to url: URL) throws {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "OkProxyIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to encode PNG"])
    }
    try png.write(to: url)
}

func drawSymbol(_ symbol: NSImage, in rect: NSRect) {
    symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: true, hints: nil)
}

for (name, side) in sizes {
    let image = NSImage(size: NSSize(width: side, height: side))
    image.lockFocus()

    let bounds = NSRect(x: 0, y: 0, width: side, height: side)
    NSColor.clear.setFill()
    bounds.fill()

    let inset = side * 0.035
    let tile = bounds.insetBy(dx: inset, dy: inset)
    let radius = side * 0.20
    let bg = NSBezierPath(roundedRect: tile, xRadius: radius, yRadius: radius)
    NSGradient(colors: [
        NSColor(calibratedRed: 0.08, green: 0.12, blue: 0.22, alpha: 1),
        NSColor(calibratedRed: 0.02, green: 0.04, blue: 0.08, alpha: 1),
    ])?.draw(in: bg, angle: -90)

    accent.withAlphaComponent(0.28).setFill()
    NSBezierPath(ovalIn: tile.insetBy(dx: side * 0.10, dy: side * 0.10)).fill()

    let pointSize = side * (isDev ? 0.56 : 0.60)
    let baseConfig = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
    let colorConfig = NSImage.SymbolConfiguration(hierarchicalColor: .white)
    let config = baseConfig.applying(colorConfig)
    guard let baseSymbol = NSImage(systemSymbolName: symbolName, accessibilityDescription: "OkProxy"),
          let configuredSymbol = baseSymbol.withSymbolConfiguration(config) else {
        throw NSError(domain: "OkProxyIcon", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing SF Symbol: \(symbolName)"])
    }

    let symbolSide = side * 0.66
    let symbolRect = NSRect(x: (side - symbolSide) / 2, y: (side - symbolSide) / 2, width: symbolSide, height: symbolSide)
    drawSymbol(configuredSymbol, in: symbolRect)

    if isDev {
        let badgeSize = side * 0.24
        let badgeRect = NSRect(x: side * 0.64, y: side * 0.64, width: badgeSize, height: badgeSize)
        accent.setFill()
        NSBezierPath(ovalIn: badgeRect).fill()
        NSColor.white.setFill()
        let dotRect = badgeRect.insetBy(dx: badgeSize * 0.32, dy: badgeSize * 0.32)
        NSBezierPath(ovalIn: dotRect).fill()
    }

    image.unlockFocus()
    try savePNG(image, to: outDir.appendingPathComponent(name))
}
SWIFT
iconutil -c icns "$ICON_BUILD_DIR" -o "$ICON_FILE"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/$EXECUTABLE_NAME"
cp "$PLIST" "$APP/Contents/Info.plist"
cp "$ICON_FILE" "$APP/Contents/Resources/$ICON_NAME.icns"
codesign --force --sign - --timestamp=none "$APP"
plutil -lint "$APP/Contents/Info.plist"
echo "Built $APP"
