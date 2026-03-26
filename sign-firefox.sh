#!/bin/bash
#
# Sign the Firefox extension using Mozilla's API.
# Auto-bumps the patch version to avoid "version already exists" conflicts.
# Reads credentials from .env file.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
MANIFEST="$SCRIPT_DIR/manifest.firefox.json"
MANIFEST_CHROME="$SCRIPT_DIR/manifest.json"
PACKAGE_JSON="$SCRIPT_DIR/package.json"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found."
  echo "  cp .env.example .env"
  echo "  Then edit .env with your Mozilla API credentials."
  exit 1
fi

# --- Auto-bump version — always unique ---
# Format: MAJOR.YMMDD.HHMM (e.g., 1.60326.1542)
# Each part stays under 65535, guaranteed unique per minute
MAJOR=1
MINOR=$(date +%-m%d)    # e.g., 326 for March 26, 1225 for Dec 25
PATCH=$(date +%-H%M)    # e.g., 1542 for 3:42 PM
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

echo "Version: $CURRENT_VERSION → $NEW_VERSION"

# Update all version references
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST"
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST_CHROME"
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" "$PACKAGE_JSON"

# Commit the version bump
cd "$SCRIPT_DIR"
git add manifest.json manifest.firefox.json package.json 2>/dev/null
git commit -m "chore: auto-bump version to $NEW_VERSION for Firefox signing" --allow-empty 2>/dev/null || true

# --- Parse .env ---
API_KEY=""
API_SECRET=""

while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$line" ]] && continue

  key="${line%%=*}"
  value="${line#*=}"

  key="$(echo "$key" | tr -d '[:space:]')"

  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

  case "$key" in
    WEB_EXT_API_KEY)  API_KEY="$value" ;;
    WEB_EXT_API_SECRET) API_SECRET="$value" ;;
  esac
done < "$ENV_FILE"

if [ -z "$API_KEY" ]; then
  echo "Error: WEB_EXT_API_KEY not found in .env"
  echo ""
  echo "Your .env should look like:"
  echo '  WEB_EXT_API_KEY=user:12345:678'
  echo '  WEB_EXT_API_SECRET=your-secret-here'
  echo ""
  echo "Get credentials at: https://addons.mozilla.org/developers/addon/api/key/"
  exit 1
fi

if [ -z "$API_SECRET" ]; then
  echo "Error: WEB_EXT_API_SECRET not found in .env"
  exit 1
fi

echo "API Key: ${API_KEY:0:10}..."
echo ""

# Build
echo "Building Firefox extension..."
"$SCRIPT_DIR/build.sh" firefox

# Sign
echo "Signing v$NEW_VERSION with Mozilla..."
npx web-ext sign \
  --no-config-discovery \
  --source-dir "$SCRIPT_DIR/dist/firefox" \
  --artifacts-dir "$SCRIPT_DIR/dist/firefox-signed" \
  --channel unlisted \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET"

echo ""
echo "Done! v$NEW_VERSION signed."
echo "Install the .xpi file from dist/firefox-signed/"
echo "Drag it into Firefox or use File → Open File."
