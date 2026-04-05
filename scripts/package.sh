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

zip -r "$ZIP_PATH" \
  frontend \
  backend \
  scripts \
  systemd \
  "${CONFIG_EXAMPLES[@]}" \
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
