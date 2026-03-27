#!/bin/bash
#
# Convert Silent Send for Safari using Apple's safari-web-extension-converter.
#
# Prerequisites:
#   - macOS with Xcode installed (free from Mac App Store)
#   - Apple Developer account ($99/year) for App Store distribution
#   - Xcode Command Line Tools: xcode-select --install
#
# This script:
#   1. Builds the Firefox variant (Safari uses browser.* API like Firefox)
#   2. Runs safari-web-extension-converter to generate an Xcode project
#   3. The Xcode project can then be built, tested, and submitted to App Store
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/safari-build"

# Check for Xcode
if ! command -v xcrun &> /dev/null; then
  echo "Error: Xcode is required. Install from the Mac App Store."
  echo "Then run: xcode-select --install"
  exit 1
fi

if ! xcrun --find safari-web-extension-converter &> /dev/null; then
  echo "Error: safari-web-extension-converter not found."
  echo "Make sure Xcode is installed and up to date."
  exit 1
fi

# Build the Firefox variant (Safari uses browser.* API)
echo "Building extension..."
"$SCRIPT_DIR/build.sh" firefox

echo ""
echo "Converting for Safari..."

# Remove previous build
rm -rf "$OUT_DIR"

# Convert — generates an Xcode project
xcrun safari-web-extension-converter \
  "$SCRIPT_DIR/dist/firefox" \
  --project-location "$OUT_DIR" \
  --app-name "Silent Send" \
  --bundle-identifier "com.silentsend.extension" \
  --swift \
  --macos-only \
  --no-open

echo ""
echo "Safari project created at: $OUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Open $OUT_DIR/Silent Send.xcodeproj in Xcode"
echo "  2. Select your Apple Developer Team in Signing & Capabilities"
echo "  3. Build and run (Cmd+R) to test in Safari"
echo "  4. To distribute: Product → Archive → Distribute App"
echo ""
echo "For App Store submission, you'll also need:"
echo "  - App Store screenshots (1280x800 for Mac)"
echo "  - Privacy policy URL"
echo "  - App description and keywords"
