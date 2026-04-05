#!/usr/bin/env bash
# Vendor noVNC (core + pako) into the given directory.
# Usage: ./scripts/vendor-novnc.sh <dest_dir>
#   dest_dir = path to .../vendor/novnc (e.g. PROJECT_DIR/frontend/public/vendor/novnc)
set -euo pipefail

DEST="${1:?Usage: $0 <dest_dir>}"
NOVNC_CORE="${DEST}/core/rfb.js"
NOVNC_VENDOR_PAKO="${DEST}/vendor/pako"

if [[ -f "$NOVNC_CORE" ]] && [[ -d "$NOVNC_VENDOR_PAKO" ]]; then
  echo "  noVNC core and vendor already present"
  exit 0
fi

mkdir -p "$DEST"
TMP_NOVNC="$(mktemp -d)"
if git clone --depth 1 --config core.hooksPath=/dev/null https://github.com/novnc/noVNC.git "$TMP_NOVNC/novnc" 2>/dev/null && [[ -d "$TMP_NOVNC/novnc/core" ]]; then
  cp -R "$TMP_NOVNC/novnc/core" "$DEST/"
  echo "  Copied noVNC core"
  if [[ -d "$TMP_NOVNC/novnc/vendor" ]]; then
    cp -R "$TMP_NOVNC/novnc/vendor" "$DEST/"
    echo "  Copied noVNC vendor (pako)"
  fi
else
  echo "  WARN: Could not fetch noVNC (check network/git) — VNC console will not work"
fi
rm -rf "$TMP_NOVNC"
