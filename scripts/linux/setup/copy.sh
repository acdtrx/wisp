#!/usr/bin/env bash
# Ensure install dir exists, remove app payload dirs, copy frontend/backend/scripts/systemd from source.
# Usage: copy.sh <source-dir> <install-dir>
# Does not remove config/ (live config and optional runtime.env stay).
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <source-dir> <install-dir>"
  exit 1
fi

SOURCE_DIR="$1"
INSTALL_DIR="$2"
INSTALL_DIR="$(echo "$INSTALL_DIR" | sed 's:/*$::')"

if [[ -z "$INSTALL_DIR" ]]; then
  echo "ERROR: Install directory cannot be empty."
  exit 1
fi

echo "--- Installing app directories ---"

INSTALL_PARENT="$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_PARENT" ]] && [[ ! -w "$INSTALL_PARENT" ]]; then
  echo "Creating $INSTALL_DIR (requires sudo)..."
  sudo mkdir -p "$INSTALL_DIR"
  sudo chown "$(whoami):$(id -gn)" "$INSTALL_DIR"
else
  mkdir -p "$INSTALL_DIR"
fi

SOURCE_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
INSTALL_REAL="$(cd "$INSTALL_DIR" && pwd -P)"

if [[ "$SOURCE_REAL" == "$INSTALL_REAL" ]]; then
  echo "  Source and install directory are the same. Skipping."
  exit 0
fi

for name in frontend backend scripts systemd; do
  if [[ ! -d "$SOURCE_DIR/$name" ]]; then
    echo "ERROR: Missing $name/ in source tree: $SOURCE_DIR"
    exit 1
  fi
done

rm -rf "$INSTALL_DIR/frontend" "$INSTALL_DIR/backend" "$INSTALL_DIR/scripts" "$INSTALL_DIR/systemd"

mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR/frontend" "$SOURCE_DIR/backend" "$SOURCE_DIR/scripts" "$SOURCE_DIR/systemd" "$INSTALL_DIR/"

if [[ -d "$SOURCE_DIR/config" ]]; then
  mkdir -p "$INSTALL_DIR/config"
  shopt -s nullglob
  for f in "$SOURCE_DIR/config"/*.example; do
    cp -a "$f" "$INSTALL_DIR/config/"
  done
  shopt -u nullglob
  echo "  Updated config examples under $INSTALL_DIR/config/"
fi

echo "  Installed frontend, backend, scripts, systemd under $INSTALL_DIR"
