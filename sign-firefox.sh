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

# --- Auto-bump version — always unique, no metadata ---
# Reads current version, increments patch. If already signed,
# keeps incrementing until it works.
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' "$MANIFEST" | head -1 | grep -o '[0-9.]*')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
PATCH=$((PATCH + 1))
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

echo "Version: $CURRENT_VERSION → $NEW_VERSION"

# Update all version references (only top-level "version", not "manifest_version")
sed -i "s/^  \"version\": \"$CURRENT_VERSION\"/  \"version\": \"$NEW_VERSION\"/" "$MANIFEST"
sed -i "s/^  \"version\": \"$CURRENT_VERSION\"/  \"version\": \"$NEW_VERSION\"/" "$MANIFEST_CHROME"
sed -i "s/^  \"version\": \"$CURRENT_VERSION\"/  \"version\": \"$NEW_VERSION\"/" "$PACKAGE_JSON"

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

# Sign — retry with incremented patch if version conflict
MAX_ATTEMPTS=10
for attempt in $(seq 1 $MAX_ATTEMPTS); do
  echo "Signing v$NEW_VERSION with Mozilla (attempt $attempt)..."

  if npx web-ext sign \
    --no-config-discovery \
    --source-dir "$SCRIPT_DIR/dist/firefox" \
    --artifacts-dir "$SCRIPT_DIR/dist/firefox-signed" \
    --channel unlisted \
    --api-key "$API_KEY" \
    --api-secret "$API_SECRET" 2>&1; then

    echo ""
    echo "Done! v$NEW_VERSION signed."
    echo "Install the .xpi file from dist/firefox-signed/"
    echo "Drag it into Firefox or use File → Open File."
    exit 0
  fi

  # If it failed due to version conflict, bump and rebuild
  echo "Version $NEW_VERSION already exists, trying next..."
  PATCH=$((PATCH + 1))
  NEW_VERSION="$MAJOR.$MINOR.$PATCH"

  # Only replace the top-level "version" field, not "manifest_version"
  sed -i "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$NEW_VERSION\"/" "$SCRIPT_DIR/dist/firefox/manifest.json"

  # Wait before retrying to avoid Mozilla rate limiting
  echo "Waiting 8 seconds before retry..."
  sleep 8
done

echo "Error: Failed after $MAX_ATTEMPTS attempts."
exit 1
