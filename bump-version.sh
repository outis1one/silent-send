#!/bin/bash
#
# Version Bump Script
#
# Finds all version numbers in the project, shows them, and lets you
# bump the patch/minor/major or enter a custom version.
#
# Works with any project that has version strings in JSON files,
# HTML files, or other text files.
#
# Usage:
#   ./bump-version.sh          # interactive — shows versions, asks what to do
#   ./bump-version.sh 1.2.3    # set all versions to 1.2.3
#   ./bump-version.sh patch    # bump patch: 0.9.0 → 0.9.1
#   ./bump-version.sh minor    # bump minor: 0.9.0 → 0.10.0
#   ./bump-version.sh major    # bump major: 0.9.0 → 1.0.0
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Find all files containing version-like strings
# Looks for patterns like "version": "X.Y.Z" or "v X.Y.Z" or "Version X.Y.Z"
find_version_files() {
  # JSON files with "version": "X.Y.Z"
  grep -rlE '"version":\s*"[0-9]+\.[0-9]+\.[0-9]+"' --include='*.json' . 2>/dev/null | grep -v node_modules | grep -v dist || true
  # HTML/JS files with version display strings like "v1.2.3" or "v 1.2.3"
  grep -rlE ' v[0-9]+\.[0-9]+\.[0-9]+' --include='*.html' --include='*.js' . 2>/dev/null | grep -v node_modules | grep -v dist || true
}

# Extract version from a file
get_version_from_file() {
  local file="$1"
  # Try JSON "version": "X.Y.Z" first
  local ver=$(grep -oP '"version":\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  if [ -n "$ver" ]; then
    echo "$ver"
    return
  fi
  # Try "vX.Y.Z" or "Version X.Y.Z" pattern
  ver=$(grep -oP '[vV]ersion[" ]*\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  if [ -n "$ver" ]; then
    echo "$ver"
    return
  fi
  # Try " vX.Y.Z" (e.g. "Silent Send v0.9.0")
  ver=$(grep -oP ' v\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  if [ -n "$ver" ]; then
    echo "$ver"
    return
  fi
}

# Get the most common version across all files (the "current" version)
get_current_version() {
  local versions=""
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ -n "$ver" ]; then
      versions="$versions $ver"
    fi
  done <<< "$(find_version_files)"

  # Return the most common version
  echo "$versions" | tr ' ' '\n' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}'
}

# Show all version occurrences
show_versions() {
  echo -e "${CYAN}Files with version strings:${NC}"
  echo ""
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ -n "$ver" ]; then
      local rel="${file#./}"
      echo -e "  ${GREEN}$ver${NC}  $rel"
    fi
  done <<< "$(find_version_files)"
  echo ""
}

# Replace version in all files
replace_version() {
  local old="$1"
  local new="$2"

  echo -e "${YELLOW}Replacing $old → $new${NC}"
  echo ""

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ "$ver" = "$old" ]; then
      # Replace in JSON files: "version": "X.Y.Z"
      sed -i "s/\"version\": \"$old\"/\"version\": \"$new\"/" "$file" 2>/dev/null
      # Replace display strings: vX.Y.Z or Version X.Y.Z
      sed -i "s/\(ersion[\" ]*\)$old/\1$new/g" "$file" 2>/dev/null
      # Replace vX.Y.Z standalone
      sed -i "s/v$old/v$new/g" "$file" 2>/dev/null

      local rel="${file#./}"
      echo -e "  ${GREEN}✓${NC} $rel"
    fi
  done <<< "$(find_version_files)"

  echo ""
  echo -e "${GREEN}Done! All versions set to $new${NC}"
}

# Bump a version component
bump_version() {
  local ver="$1"
  local part="$2"

  IFS='.' read -r major minor patch <<< "$ver"

  case "$part" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

# --- Main ---

CURRENT=$(get_current_version)

if [ -z "$CURRENT" ]; then
  echo -e "${RED}No version strings found in the project.${NC}"
  exit 1
fi

# Handle command-line argument
if [ -n "$1" ]; then
  case "$1" in
    patch|minor|major)
      NEW=$(bump_version "$CURRENT" "$1")
      show_versions
      replace_version "$CURRENT" "$NEW"
      exit 0
      ;;
    [0-9]*)
      show_versions
      replace_version "$CURRENT" "$1"
      exit 0
      ;;
    *)
      echo "Usage: $0 [patch|minor|major|X.Y.Z]"
      exit 1
      ;;
  esac
fi

# Interactive mode
show_versions

echo -e "Current version: ${GREEN}$CURRENT${NC}"
echo ""
echo "  [1] Bump patch: $CURRENT → $(bump_version "$CURRENT" patch)"
echo "  [2] Bump minor: $CURRENT → $(bump_version "$CURRENT" minor)"
echo "  [3] Bump major: $CURRENT → $(bump_version "$CURRENT" major)"
echo "  [4] Enter custom version"
echo "  [q] Quit"
echo ""
read -p "Choice: " choice

case "$choice" in
  1) NEW=$(bump_version "$CURRENT" patch) ;;
  2) NEW=$(bump_version "$CURRENT" minor) ;;
  3) NEW=$(bump_version "$CURRENT" major) ;;
  4)
    read -p "Enter version: " NEW
    if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo -e "${RED}Invalid version format. Use X.Y.Z${NC}"
      exit 1
    fi
    ;;
  q|Q|"") echo "Cancelled."; exit 0 ;;
  *) echo -e "${RED}Invalid choice.${NC}"; exit 1 ;;
esac

replace_version "$CURRENT" "$NEW"
