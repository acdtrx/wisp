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

# Root package.json is the canonical version source — wispUpdate.js reads it
# first; absence triggers a silent fallback to backend/package.json. Refuse to
# install a tree that's missing it instead of leaving the install in a state
# that lies about its version.
if [[ ! -f "$SOURCE_DIR/package.json" ]]; then
  echo "ERROR: Missing root package.json in source tree: $SOURCE_DIR"
  exit 1
fi

rm -rf "$INSTALL_DIR/frontend" "$INSTALL_DIR/backend" "$INSTALL_DIR/scripts" "$INSTALL_DIR/systemd" "$INSTALL_DIR/docs"

mkdir -p "$INSTALL_DIR"
cp -a "$SOURCE_DIR/frontend" "$SOURCE_DIR/backend" "$SOURCE_DIR/scripts" "$SOURCE_DIR/systemd" "$INSTALL_DIR/"

if [[ -d "$SOURCE_DIR/docs" ]]; then
  cp -a "$SOURCE_DIR/docs" "$INSTALL_DIR/"
fi

# Top-level files. Mirrors the release tarball; package.json is required, the
# rest are bundled for parity (self-update overwrites them on every release).
for f in package.json CHANGELOG.md LICENSE README.md CLAUDE.md; do
  if [[ -f "$SOURCE_DIR/$f" ]]; then
    cp -a "$SOURCE_DIR/$f" "$INSTALL_DIR/$f"
  fi
done

if [[ -d "$SOURCE_DIR/config" ]]; then
  mkdir -p "$INSTALL_DIR/config"
  shopt -s nullglob
  for f in "$SOURCE_DIR/config"/*.example; do
    cp -a "$f" "$INSTALL_DIR/config/"
  done
  shopt -u nullglob
  echo "  Updated config examples under $INSTALL_DIR/config/"
fi

echo "  Installed frontend, backend, scripts, systemd, docs, top-level files under $INSTALL_DIR"
