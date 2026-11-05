#!/bin/zsh
# Builds a self-contained dist/Mozaic.app and dist/Mozaic-<version>.dmg.
#
# The app carries the backend source, the web UI and the uv installer. On first launch it creates its
# own Python environment, then installs its own ComfyUI and fetches the Qwen Image 2.1 models, all under
# ~/Library/Application Support/Mozaic. Nothing on the build machine is referenced at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
UV_VERSION="0.12.17"
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' pyproject.toml | head -1)
BUILD_ID="$VERSION-$(date +%Y%m%d%H%M%S)"

echo "• Lock and web UI"
uv lock -q
npm --prefix web install --silent
npm --prefix web run build --silent

APP="$ROOT/dist/Mozaic.app"
RES="$APP/Contents/Resources"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" "$RES/backend"

echo "• Backend source"
cp pyproject.toml uv.lock .python-version "$RES/backend/"
rsync -a --exclude '__pycache__' --exclude '*.pyc' src "$RES/backend/"
rm -rf "$RES/backend/src/mozaic/web"
cp -R web/dist "$RES/backend/src/mozaic/web"
echo "$BUILD_ID" > "$RES/build-id.txt"

echo "• uv $UV_VERSION"
UV_CACHE="$ROOT/build/uv-$UV_VERSION"
if [[ ! -x "$UV_CACHE/uv" ]]; then
  mkdir -p "$UV_CACHE"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-apple-darwin.tar.gz" \
    | tar -xz -C "$UV_CACHE" --strip-components 1
fi
cp "$UV_CACHE/uv" "$RES/bin/uv"

echo "• Native shell"
swiftc -O -o "$APP/Contents/MacOS/Mozaic" macos/main.swift -framework Cocoa -framework WebKit

echo "• Icon"
ICONSET="$ROOT/build/Mozaic.iconset"
rm -rf "$ICONSET"
uv run python scripts/make_icon.py "$ICONSET"
iconutil -c icns "$ICONSET" -o "$RES/Mozaic.icns"
cp web/public/mark.png "$RES/mark.png"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Mozaic</string>
  <key>CFBundleDisplayName</key><string>Mozaic</string>
  <key>CFBundleIdentifier</key><string>studio.mozaic.app</string>
  <key>CFBundleVersion</key><string>$BUILD_ID</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>Mozaic</string>
  <key>CFBundleIconFile</key><string>Mozaic</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "• Signing"
if [[ -n "${MOZAIC_SIGN_ID:-}" ]]; then
  # Developer ID build: sign nested binaries first, then the app, with the hardened runtime.
  codesign --force --options runtime --timestamp --sign "$MOZAIC_SIGN_ID" "$RES/bin/uv"
  codesign --force --options runtime --timestamp --sign "$MOZAIC_SIGN_ID" "$APP"
else
  codesign --force --deep --sign - "$APP" >/dev/null
fi

echo "• Disk image"
DMG="$ROOT/dist/Mozaic-$VERSION.dmg"
STAGE="$ROOT/build/dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Mozaic" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"

if [[ -n "${MOZAIC_SIGN_ID:-}" && -n "${MOZAIC_NOTARY_PROFILE:-}" ]]; then
  echo "• Notarizing"
  codesign --force --timestamp --sign "$MOZAIC_SIGN_ID" "$DMG"
  xcrun notarytool submit "$DMG" --keychain-profile "$MOZAIC_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo "Built $APP"
echo "Built $DMG ($(du -h "$DMG" | cut -f1))"
