#!/bin/bash
#
# Sign the Firefox extension using Mozilla's API.
#
# Reads credentials from .env file (WEB_EXT_API_KEY and WEB_EXT_API_SECRET).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill in your credentials."
  echo "  cp .env.example .env"
  exit 1
fi

# Read .env, strip quotes and whitespace
while IFS='=' read -r key value; do
  # Skip comments and empty lines
  [[ "$key" =~ ^#.*$ ]] && continue
  [[ -z "$key" ]] && continue
  # Strip surrounding quotes
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  # Trim whitespace
  key="$(echo "$key" | xargs)"
  value="$(echo "$value" | xargs)"
  export "$key=$value"
done < "$ENV_FILE"

if [ -z "$WEB_EXT_API_KEY" ] || [ -z "$WEB_EXT_API_SECRET" ]; then
  echo "Error: WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set in .env"
  echo ""
  echo "Get your credentials at: https://addons.mozilla.org/developers/addon/api/key/"
  exit 1
fi

echo "Building Firefox extension..."
"$SCRIPT_DIR/build.sh" firefox

echo "Signing with Mozilla..."
npx web-ext sign \
  --source-dir "$SCRIPT_DIR/dist/firefox" \
  --artifacts-dir "$SCRIPT_DIR/dist/firefox-signed" \
  --channel unlisted \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET"

echo ""
echo "Done! Install the .xpi file from dist/firefox-signed/"
echo "Drag it into Firefox or use File → Open File."
