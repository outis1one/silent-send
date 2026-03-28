#!/bin/bash
#
# Version Bump Script — works with any project
#
# Finds version strings in any file format and updates them together.
#
# Supported patterns:
#   JSON:       "version": "1.2.3"
#   TOML:       version = "1.2.3"
#   YAML:       version: 1.2.3
#   Python:     __version__ = "1.2.3"  or  version = "1.2.3"
#   PHP:        Version: 1.2.3  (WordPress plugin/theme headers)
#   Shell:      VERSION="1.2.3"
#   HTML/JS:    v1.2.3
#   setup.cfg:  version = 1.2.3
#
# Usage:
#   ./bump-version.sh          # interactive
#   ./bump-version.sh 1.2.3    # set all to 1.2.3
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
DIM='\033[2m'
NC='\033[0m'

# Directories to skip
SKIP_DIRS="node_modules|dist|build|\.git|__pycache__|\.venv|venv|\.egg-info|vendor"

# File extensions to search
SEARCH_EXTS="json|toml|yaml|yml|py|php|sh|bash|html|js|css|cfg|ini|txt|md|xml|plist|gradle|gemspec|podspec|csproj|props"

# Find all files that might contain version strings
find_version_files() {
  local files=""

  # Use find + grep for maximum compatibility
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    # Skip binary files and large files
    [ ! -f "$file" ] && continue
    local size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
    [ "$size" -gt 500000 ] && continue

    files="$files
$file"
  done < <(find . -type f \( \
    -name "*.json" -o -name "*.toml" -o -name "*.yaml" -o -name "*.yml" \
    -o -name "*.py" -o -name "*.php" -o -name "*.sh" -o -name "*.bash" \
    -o -name "*.html" -o -name "*.js" -o -name "*.css" -o -name "*.cfg" \
    -o -name "*.ini" -o -name "*.txt" -o -name "*.xml" -o -name "*.plist" \
    -o -name "*.gradle" -o -name "*.gemspec" -o -name "*.podspec" \
    -o -name "*.csproj" -o -name "*.props" -o -name "*.md" \
    -o -name "Makefile" -o -name "Dockerfile" -o -name "Cargo.toml" \
    -o -name "setup.py" -o -name "setup.cfg" -o -name "pyproject.toml" \
    -o -name "package.json" -o -name "composer.json" -o -name "Gemfile" \
    \) 2>/dev/null | grep -Ev "$SKIP_DIRS" | grep -v "bump-version")

  echo "$files"
}

# Extract version from a file — tries all known patterns
get_version_from_file() {
  local file="$1"
  local ver=""

  # JSON: "version": "X.Y.Z"
  ver=$(grep -oP '"version"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # TOML/Python: version = "X.Y.Z" or __version__ = "X.Y.Z"
  ver=$(grep -oP '(?:__)?version\s*=\s*["\x27]\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # YAML: version: X.Y.Z or version: "X.Y.Z"
  ver=$(grep -oP '^version:\s*["\x27]?\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # PHP/WordPress: Version: X.Y.Z (in comment header)
  ver=$(grep -oP 'Version:\s*\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # Shell: VERSION="X.Y.Z" or VERSION='X.Y.Z'
  ver=$(grep -oP 'VERSION\s*=\s*["\x27]?\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # HTML/display: " vX.Y.Z" or ">vX.Y.Z"
  ver=$(grep -oP '[ >]v\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # XML/plist: <string>X.Y.Z</string> near version key
  ver=$(grep -A1 -i 'version' "$file" 2>/dev/null | grep -oP '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [ -n "$ver" ] && echo "$ver" && return
}

# Get the most common version (the "current" version)
get_current_version() {
  local versions=""
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    [ -n "$ver" ] && versions="$versions $ver"
  done <<< "$(find_version_files)"

  echo "$versions" | tr ' ' '\n' | grep -v '^$' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}'
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
  local escaped_old=$(echo "$old" | sed 's/\./\\./g')

  echo -e "${YELLOW}Replacing $old → $new${NC}"
  echo ""

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ "$ver" = "$old" ]; then
      # Replace all known version patterns
      # JSON: "version": "X.Y.Z"
      sed -i "s/\(\"version\"\s*:\s*\"\)$escaped_old\"/\1$new\"/g" "$file" 2>/dev/null
      # TOML/Python: version = "X.Y.Z" or __version__ = "X.Y.Z"
      sed -i "s/\(\(__\)\?version\s*=\s*[\"']\)$escaped_old/\1$new/g" "$file" 2>/dev/null
      # YAML: version: X.Y.Z
      sed -i "s/\(^version:\s*[\"']\?\)$escaped_old/\1$new/g" "$file" 2>/dev/null
      # PHP/WordPress: Version: X.Y.Z
      sed -i "s/\(Version:\s*\)$escaped_old/\1$new/g" "$file" 2>/dev/null
      # Shell: VERSION="X.Y.Z"
      sed -i "s/\(VERSION\s*=\s*[\"']\?\)$escaped_old/\1$new/g" "$file" 2>/dev/null
      # HTML display: vX.Y.Z
      sed -i "s/\([ >]v\)$escaped_old/\1$new/g" "$file" 2>/dev/null

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
