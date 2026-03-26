#!/bin/bash
#
# Sign the Firefox extension using Mozilla's API.
# Tries the current version first. Only bumps if that version
# already exists at Mozilla. Handles rate limiting with backoff.
#
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

# --- Read current version (don't bump yet — try current first) ---
CURRENT_VERSION=$(grep -o '"version": "[^"]*"' "$MANIFEST" | head -1 | grep -o '[0-9.]*')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_VERSION="$CURRENT_VERSION"

echo "Current version: $CURRENT_VERSION"

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

# --- Sign with retry ---
MAX_ATTEMPTS=5
WAIT_TIME=10

for attempt in $(seq 1 $MAX_ATTEMPTS); do
  echo ""
  echo "=== Attempt $attempt: signing v$NEW_VERSION ==="

  # Capture output to check for specific errors
  OUTPUT=$(npx web-ext sign \
    --no-config-discovery \
    --source-dir "$SCRIPT_DIR/dist/firefox" \
    --artifacts-dir "$SCRIPT_DIR/dist/firefox-signed" \
    --channel unlisted \
    --api-key "$API_KEY" \
    --api-secret "$API_SECRET" 2>&1) && {
    echo "$OUTPUT"
    echo ""
    echo "Success! v$NEW_VERSION signed."
    echo "Install: dist/firefox-signed/"

    # Update source files to match the signed version
    sed -i "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$NEW_VERSION\"/" "$MANIFEST"
    sed -i "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$NEW_VERSION\"/" "$MANIFEST_CHROME"
    sed -i "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$NEW_VERSION\"/" "$PACKAGE_JSON"

    cd "$SCRIPT_DIR"
    git add manifest.json manifest.firefox.json package.json 2>/dev/null
    git commit -m "chore: release v$NEW_VERSION (Firefox signed)" --allow-empty 2>/dev/null || true

    exit 0
  }

  echo "$OUTPUT"

  # Check if rate limited
  if echo "$OUTPUT" | grep -q "throttled"; then
    # Extract wait time from error message
    THROTTLE_SECS=$(echo "$OUTPUT" | grep -oP 'available in \K\d+' || echo "60")
    echo ""
    echo "Rate limited by Mozilla. Waiting ${THROTTLE_SECS}s..."
    sleep "$THROTTLE_SECS"
    # Don't bump version — retry the same version after cooldown
    continue
  fi

  # Check if version already exists
  if echo "$OUTPUT" | grep -qi "already exists\|version.*conflict\|could not be uploaded"; then
    PATCH=$((PATCH + 1))
    NEW_VERSION="$MAJOR.$MINOR.$PATCH"
    echo ""
    echo "Version conflict. Bumping to $NEW_VERSION..."

    # Update only the built manifest (not source — we'll update source on success)
    sed -i "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$NEW_VERSION\"/" "$SCRIPT_DIR/dist/firefox/manifest.json"

    sleep "$WAIT_TIME"
    continue
  fi

  # Unknown error — wait and retry
  echo ""
  echo "Unknown error. Waiting ${WAIT_TIME}s before retry..."
  sleep "$WAIT_TIME"
done

echo ""
echo "Error: Failed after $MAX_ATTEMPTS attempts."
echo "If rate limited, wait a few minutes and try again."
exit 1
