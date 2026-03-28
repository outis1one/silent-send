#!/bin/bash
#
# bump-version.sh — Universal version bump tool
#
# Finds version strings in any project, shows what will change,
# asks for confirmation, and updates them. Supports undo.
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
#   ./bump-version.sh              # interactive
#   ./bump-version.sh patch        # bump patch: 0.9.0 → 0.9.1
#   ./bump-version.sh minor        # bump minor: 0.9.0 → 0.10.0
#   ./bump-version.sh major        # bump major: 0.9.0 → 1.0.0
#   ./bump-version.sh 1.2.3        # set all to 1.2.3
#   ./bump-version.sh undo         # revert last bump
#   ./bump-version.sh --help       # show help
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

UNDO_FILE="$SCRIPT_DIR/.version-bump-undo"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# Directories to skip
SKIP_DIRS="node_modules|dist|build|\.git|__pycache__|\.venv|venv|\.egg-info|vendor"

# --- Help ---
show_help() {
  cat << 'HELPEOF'
bump-version.sh — Universal version bump tool

USAGE:
  ./bump-version.sh              Interactive mode
  ./bump-version.sh patch        Bump patch:  0.9.0 → 0.9.1
  ./bump-version.sh minor        Bump minor:  0.9.0 → 0.10.0
  ./bump-version.sh major        Bump major:  0.9.0 → 1.0.0
  ./bump-version.sh 1.2.3        Set to exact version
  ./bump-version.sh undo         Revert last version bump
  ./bump-version.sh --help       Show this help

HOW IT WORKS:
  1. Scans all text files for version-like patterns
  2. Groups files by version number (the "version profile")
  3. Only updates files matching the most common version
  4. Shows a preview of all changes before applying
  5. Asks for confirmation (unless --yes flag is used)
  6. Saves undo information for easy rollback

SUPPORTED PATTERNS:
  "version": "1.2.3"          JSON (package.json, manifest.json, etc.)
  version = "1.2.3"           TOML, Python (pyproject.toml, setup.py)
  version: 1.2.3              YAML (helm charts, GitHub Actions)
  __version__ = "1.2.3"       Python packages
  Version: 1.2.3              PHP/WordPress plugin/theme headers
  VERSION="1.2.3"             Shell scripts
  v1.2.3                      HTML footers, display strings

SAFETY:
  - Only updates files matching the current version (ignores unrelated X.Y.Z)
  - Shows all changes before applying and asks for confirmation
  - Saves undo info so you can revert with ./bump-version.sh undo
  - Skips node_modules, dist, build, .git, __pycache__, venv, vendor
  - Skips binary files and files over 500KB
  - Skips itself (won't match examples in this help text)

EXAMPLES:
  ./bump-version.sh              # shows versions, pick what to do
  ./bump-version.sh patch        # quick patch bump, still confirms
  ./bump-version.sh 1.0.0 --yes  # set to 1.0.0 without confirmation
  ./bump-version.sh undo         # oops, go back
HELPEOF
  exit 0
}

# --- Find version files ---
find_version_files() {
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    [ ! -f "$file" ] && continue
    local size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
    [ "$size" -gt 500000 ] && continue
    echo "$file"
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
}

# --- Extract version from file ---
# Only matches version DECLARATIONS, not arbitrary X.Y.Z in text.
# Each pattern requires a keyword context (version, VERSION, __version__, etc.)
get_version_from_file() {
  local file="$1"
  local ver=""

  # JSON: "version": "X.Y.Z"
  ver=$(grep -oP '"version"\s*:\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # TOML/Python: version = "X.Y.Z" or __version__ = "X.Y.Z"
  ver=$(grep -oP '(?:__)?version\s*=\s*["\x27]\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # YAML: version: X.Y.Z (must be at start of line)
  ver=$(grep -oP '^version:\s*["\x27]?\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # PHP/WordPress: Version: X.Y.Z
  ver=$(grep -oP 'Version:\s*\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # Shell: VERSION="X.Y.Z"
  ver=$(grep -oP 'VERSION\s*=\s*["\x27]?\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return

  # HTML display: " vX.Y.Z" or ">vX.Y.Z" (requires v prefix — not bare numbers)
  ver=$(grep -oP '[ >]v\K[0-9]+\.[0-9]+\.[0-9]+' "$file" 2>/dev/null | head -1)
  [ -n "$ver" ] && echo "$ver" && return
}

# --- Get current version (most common across files) ---
get_current_version() {
  local versions=""
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    [ -n "$ver" ] && versions="$versions $ver"
  done <<< "$(find_version_files)"

  echo "$versions" | tr ' ' '\n' | grep -v '^$' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}'
}

# --- Show all version occurrences grouped by version ---
show_versions() {
  local current="$1"
  local files_list=""

  echo -e "${CYAN}Version profile:${NC}"
  echo ""

  # Collect all versions
  declare -A version_files
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ -n "$ver" ]; then
      local rel="${file#./}"
      if [ -z "${version_files[$ver]+x}" ]; then
        version_files[$ver]="$rel"
      else
        version_files[$ver]="${version_files[$ver]}|$rel"
      fi
    fi
  done <<< "$(find_version_files)"

  # Show grouped by version
  for ver in $(echo "${!version_files[@]}" | tr ' ' '\n' | sort -V); do
    if [ "$ver" = "$current" ]; then
      echo -e "  ${GREEN}$ver${NC} ${BOLD}(current — will be updated)${NC}"
    else
      echo -e "  ${DIM}$ver (different — will NOT be changed)${NC}"
    fi
    IFS='|' read -ra files <<< "${version_files[$ver]}"
    for f in "${files[@]}"; do
      if [ "$ver" = "$current" ]; then
        echo -e "    ${GREEN}✓${NC} $f"
      else
        echo -e "    ${DIM}· $f${NC}"
      fi
    done
  done
  echo ""
}

# --- Preview changes ---
preview_changes() {
  local old="$1"
  local new="$2"

  echo -e "${YELLOW}Changes to be made:${NC}"
  echo ""

  local count=0
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ "$ver" = "$old" ]; then
      local rel="${file#./}"
      # Show the actual line that will change
      local line=$(grep -n "$old" "$file" 2>/dev/null | head -1)
      local linenum=$(echo "$line" | cut -d: -f1)
      local content=$(echo "$line" | cut -d: -f2-)
      local newcontent=$(echo "$content" | sed "s/$old/$new/g")
      echo -e "  ${BOLD}$rel${NC} (line $linenum)"
      echo -e "    ${RED}- $content${NC}"
      echo -e "    ${GREEN}+ $newcontent${NC}"
      echo ""
      count=$((count + 1))
    fi
  done <<< "$(find_version_files)"

  echo -e "  ${CYAN}$count file(s) will be modified${NC}"
  echo ""
}

# --- Apply changes ---
replace_version() {
  local old="$1"
  local new="$2"
  local escaped_old=$(echo "$old" | sed 's/\./\\./g')

  # Save undo info
  echo "$new $old" > "$UNDO_FILE"
  local undo_files=""

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ "$ver" = "$old" ]; then
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
      undo_files="$undo_files $rel"
    fi
  done <<< "$(find_version_files)"

  # Append file list to undo
  echo "$undo_files" >> "$UNDO_FILE"

  echo ""
  echo -e "${GREEN}Done! $old → $new${NC}"
  echo -e "${DIM}Run ./bump-version.sh undo to revert${NC}"
}

# --- Undo ---
do_undo() {
  if [ ! -f "$UNDO_FILE" ]; then
    echo -e "${RED}No undo information found. Nothing to revert.${NC}"
    exit 1
  fi

  local versions=$(head -1 "$UNDO_FILE")
  local current=$(echo "$versions" | awk '{print $1}')
  local previous=$(echo "$versions" | awk '{print $2}')

  echo -e "${YELLOW}Undo: $current → $previous${NC}"
  echo ""

  # Just do a version replace in the other direction
  local escaped_current=$(echo "$current" | sed 's/\./\\./g')

  while IFS= read -r file; do
    [ -z "$file" ] && continue
    local ver=$(get_version_from_file "$file")
    if [ "$ver" = "$current" ]; then
      sed -i "s/\(\"version\"\s*:\s*\"\)$escaped_current\"/\1$previous\"/g" "$file" 2>/dev/null
      sed -i "s/\(\(__\)\?version\s*=\s*[\"']\)$escaped_current/\1$previous/g" "$file" 2>/dev/null
      sed -i "s/\(^version:\s*[\"']\?\)$escaped_current/\1$previous/g" "$file" 2>/dev/null
      sed -i "s/\(Version:\s*\)$escaped_current/\1$previous/g" "$file" 2>/dev/null
      sed -i "s/\(VERSION\s*=\s*[\"']\?\)$escaped_current/\1$previous/g" "$file" 2>/dev/null
      sed -i "s/\([ >]v\)$escaped_current/\1$previous/g" "$file" 2>/dev/null

      local rel="${file#./}"
      echo -e "  ${GREEN}✓${NC} $rel"
    fi
  done <<< "$(find_version_files)"

  rm -f "$UNDO_FILE"
  echo ""
  echo -e "${GREEN}Reverted to $previous${NC}"
}

# --- Bump version component ---
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

# --- Confirm ---
confirm() {
  local msg="$1"
  read -p "$msg [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# --- Main ---

# Parse flags
YES_FLAG=false
for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help ;;
    --yes|-y) YES_FLAG=true ;;
    undo) do_undo; exit 0 ;;
  esac
done

# Get first non-flag argument
ACTION=""
for arg in "$@"; do
  case "$arg" in
    --*|-*) continue ;;
    undo) continue ;;
    *) ACTION="$arg"; break ;;
  esac
done

CURRENT=$(get_current_version)

if [ -z "$CURRENT" ]; then
  echo -e "${RED}No version declarations found in the project.${NC}"
  echo -e "${DIM}Looking for patterns like \"version\": \"X.Y.Z\" or VERSION=\"X.Y.Z\"${NC}"
  echo -e "${DIM}Run ./bump-version.sh --help for supported formats${NC}"
  exit 1
fi

# Handle command-line argument
if [ -n "$ACTION" ]; then
  case "$ACTION" in
    patch|minor|major)
      NEW=$(bump_version "$CURRENT" "$ACTION")
      ;;
    [0-9]*)
      if ! [[ "$ACTION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo -e "${RED}Invalid version format. Use X.Y.Z (e.g. 1.0.0)${NC}"
        exit 1
      fi
      NEW="$ACTION"
      ;;
    *)
      echo -e "${RED}Unknown action: $ACTION${NC}"
      echo "Usage: $0 [patch|minor|major|X.Y.Z|undo|--help]"
      exit 1
      ;;
  esac

  show_versions "$CURRENT"
  preview_changes "$CURRENT" "$NEW"

  if [ "$YES_FLAG" = false ]; then
    if ! confirm "Apply these changes?"; then
      echo "Cancelled."
      exit 0
    fi
  fi

  replace_version "$CURRENT" "$NEW"
  exit 0
fi

# Interactive mode
show_versions "$CURRENT"

echo -e "Current version: ${GREEN}${BOLD}$CURRENT${NC}"
echo ""
echo "  [1] Bump patch: $CURRENT → $(bump_version "$CURRENT" patch)"
echo "  [2] Bump minor: $CURRENT → $(bump_version "$CURRENT" minor)"
echo "  [3] Bump major: $CURRENT → $(bump_version "$CURRENT" major)"
echo "  [4] Enter custom version"
if [ -f "$UNDO_FILE" ]; then
  prev=$(head -1 "$UNDO_FILE" | awk '{print $2}')
  echo "  [u] Undo last bump (revert to $prev)"
fi
echo "  [q] Quit"
echo ""
read -p "Choice: " choice

case "$choice" in
  1) NEW=$(bump_version "$CURRENT" patch) ;;
  2) NEW=$(bump_version "$CURRENT" minor) ;;
  3) NEW=$(bump_version "$CURRENT" major) ;;
  4)
    read -p "Enter version (X.Y.Z): " NEW
    if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo -e "${RED}Invalid version format. Use X.Y.Z${NC}"
      exit 1
    fi
    ;;
  u|U) do_undo; exit 0 ;;
  q|Q|"") echo "Cancelled."; exit 0 ;;
  *) echo -e "${RED}Invalid choice.${NC}"; exit 1 ;;
esac

echo ""
preview_changes "$CURRENT" "$NEW"

if ! confirm "Apply these changes?"; then
  echo "Cancelled."
  exit 0
fi

replace_version "$CURRENT" "$NEW"
