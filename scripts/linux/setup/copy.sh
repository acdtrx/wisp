#!/usr/bin/env bash
# Ensure the install dir exists and put the release-shaped tree's entries in place of the installed ones.
# Usage: copy.sh <source-dir> <install-dir>
# Does not remove config/ (live config and optional runtime.env stay).
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <source-dir> <install-dir>"
  exit 1
fi

SOURCE_DIR="$1"
INSTALL_DIR="$2"
INSTALL_DIR="${INSTALL_DIR%"${INSTALL_DIR##*[!/]}"}"

if [[ -z "$INSTALL_DIR" ]]; then
  echo "ERROR: Install directory cannot be empty."
  exit 1
fi

echo "--- Installing app directories ---"

mkdir -p "$INSTALL_DIR"

SOURCE_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
INSTALL_REAL="$(cd "$INSTALL_DIR" && pwd -P)"

if [[ "$SOURCE_REAL" == "$INSTALL_REAL" ]]; then
  echo "  Source and install directory are the same. Skipping."
  exit 0
fi

# The root package.json is the version's one source (wispUpdate.js reads the
# running release's, and a staged tree's, there only): refuse a tree without it
# rather than install one that has no version.
if [[ ! -f "$SOURCE_DIR/package.json" ]]; then
  echo "ERROR: Missing root package.json in source tree: $SOURCE_DIR"
  exit 1
fi

# What the release-shaped tree holds is what is installed: scripts/stage-release.sh
# decides it, and this copies each of its top-level entries in place of the one
# installed, naming none. config/ is the exception, below: the live config stays.
shopt -s dotglob nullglob
for entry in "$SOURCE_DIR"/*; do
  name="$(basename "$entry")"
  [[ "$name" == config ]] && continue
  rm -rf "${INSTALL_DIR:?}/$name"
  cp -a "$entry" "$INSTALL_DIR/"
done
shopt -u dotglob nullglob

if [[ -d "$SOURCE_DIR/config" ]]; then
  mkdir -p "$INSTALL_DIR/config"
  shopt -s nullglob
  for f in "$SOURCE_DIR/config"/*.example; do
    cp -a "$f" "$INSTALL_DIR/config/"
  done
  shopt -u nullglob
  echo "  Updated config examples under $INSTALL_DIR/config/"
fi

echo "  Installed the tree under $INSTALL_DIR"
