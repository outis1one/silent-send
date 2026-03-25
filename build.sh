#!/bin/bash
#
# Build Silent Send for Chrome or Firefox.
#
# Usage:
#   ./build.sh chrome   → dist/chrome/  (load unpacked)
#   ./build.sh firefox  → dist/firefox/ (load as temporary add-on)
#   ./build.sh both     → builds both
#

set -e

TARGET="${1:-both}"

build() {
  local browser="$1"
  local out="dist/$browser"

  echo "Building for $browser..."
  rm -rf "$out"
  mkdir -p "$out"

  # Copy all source files
  cp -r src icons "$out/"

  # Copy the correct manifest
  if [ "$browser" = "firefox" ]; then
    cp manifest.firefox.json "$out/manifest.json"
  else
    cp manifest.json "$out/manifest.json"
  fi

  # Copy other root files
  cp README.md "$out/" 2>/dev/null || true

  echo "  → $out/ ready"
}

case "$TARGET" in
  chrome)  build chrome ;;
  firefox) build firefox ;;
  both)    build chrome; build firefox ;;
  *)
    echo "Usage: $0 {chrome|firefox|both}"
    exit 1
    ;;
esac

echo ""
echo "Done! Load the extension:"
echo "  Chrome:  chrome://extensions → Load unpacked → dist/chrome/"
echo "  Firefox: about:debugging → This Firefox → Load Temporary Add-on → dist/firefox/manifest.json"
