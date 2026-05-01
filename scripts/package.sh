#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"

VERSION="$(node -e "console.log(require('$PROJECT_DIR/frontend/package.json').version)")"
ZIP_NAME="wisp-${VERSION}.zip"
ZIP_PATH="$BUILD_DIR/$ZIP_NAME"

echo "=== Wisp Package ==="
echo "Project: $PROJECT_DIR"
echo "Version: $VERSION"
echo "Output:  $ZIP_PATH"
echo ""

mkdir -p "$BUILD_DIR"
cd "$PROJECT_DIR"
rm -f "$ZIP_PATH"

CONFIG_EXAMPLES=()
if [[ -d "$PROJECT_DIR/config" ]]; then
  shopt -s nullglob
  for f in "$PROJECT_DIR/config"/*.example; do
    CONFIG_EXAMPLES+=( "${f#$PROJECT_DIR/}" )
  done
  shopt -u nullglob
fi

if [[ ${#CONFIG_EXAMPLES[@]} -eq 0 ]]; then
  echo "ERROR: No config/*.example files found."
  exit 1
fi

# Top-level single-file payload. Mirrors what .github/workflows/release.yml
# bundles into the GitHub release tarball — keep these in sync so push.sh and
# self-update install the same files.
TOP_FILES=()
for f in package.json CHANGELOG.md LICENSE README.md CLAUDE.md; do
  [[ -f "$PROJECT_DIR/$f" ]] && TOP_FILES+=( "$f" )
done

# package.json is the most important: backend/src/lib/wispUpdate.js reads
# <install>/package.json as the primary source of the running version. Without
# it, getCurrentVersion() falls back to backend/package.json (a quieter bug).
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo "ERROR: root package.json missing."
  exit 1
fi

zip -r "$ZIP_PATH" \
  frontend \
  backend \
  scripts \
  systemd \
  docs \
  "${CONFIG_EXAMPLES[@]}" \
  "${TOP_FILES[@]}" \
  -x "*.git*" \
  -x "*/node_modules/*" \
  -x "frontend/node_modules/*" \
  -x "backend/node_modules/*" \
  -x "frontend/dist/*" \
  -x "*.DS_Store"

echo ""
echo "=== Package complete ==="
echo "Created: $ZIP_PATH"
echo "Size:   $(du -h "$ZIP_PATH" | cut -f1)"
echo ""
echo "To deploy: copy $ZIP_NAME to the server, unzip, cd into the folder, then run:"
echo "  ./scripts/install.sh"
echo ""
