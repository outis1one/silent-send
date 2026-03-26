#!/bin/bash
#
# Sign the Firefox extension using Mozilla's API.
# Reads credentials from .env file.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found."
  echo "  cp .env.example .env"
  echo "  Then edit .env with your Mozilla API credentials."
  exit 1
fi

# Parse .env — handle quotes, spaces, comments
API_KEY=""
API_SECRET=""

while IFS= read -r line || [ -n "$line" ]; do
  # Skip comments and empty lines
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$line" ]] && continue

  # Split on first =
  key="${line%%=*}"
  value="${line#*=}"

  # Trim whitespace from key
  key="$(echo "$key" | tr -d '[:space:]')"

  # Strip surrounding quotes from value
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  # Trim whitespace
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
echo "API Secret: ${API_SECRET:0:5}..."
echo ""

# Build
echo "Building Firefox extension..."
"$SCRIPT_DIR/build.sh" firefox

# Sign — disable config discovery to avoid conflicts
echo "Signing with Mozilla..."
npx web-ext sign \
  --no-config-discovery \
  --source-dir "$SCRIPT_DIR/dist/firefox" \
  --artifacts-dir "$SCRIPT_DIR/dist/firefox-signed" \
  --channel unlisted \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET"

echo ""
echo "Done! Install the .xpi file from dist/firefox-signed/"
echo "Drag it into Firefox or use File → Open File."
