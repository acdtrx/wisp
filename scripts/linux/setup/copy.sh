#!/usr/bin/env bash
# The release-shaped tree into the install folder, by the one rule of what an
# install keeps (docs/specs/DEPLOYMENT.md), for an install and an update alike:
# config/ holds the host's own files, which an install never deletes or
# overwrites, and the tree's *.example files; everything else in the install
# folder is the tree's, replaced, and removed when the tree no longer has it.
# Usage: copy.sh <source-dir> <install-dir>
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
# decides it, and this puts each of its top-level entries in place of the one
# installed, naming none, then removes the entries it no longer has.
shopt -s dotglob nullglob
for entry in "$SOURCE_DIR"/*; do
  name="$(basename "$entry")"
  [[ "$name" == config ]] && continue
  rm -rf "${INSTALL_DIR:?}/$name"
  cp -a "$entry" "$INSTALL_DIR/"
done
for entry in "$INSTALL_DIR"/*; do
  name="$(basename "$entry")"
  [[ "$name" == config || -e "$SOURCE_DIR/$name" || -L "$SOURCE_DIR/$name" ]] && continue
  rm -rf "${INSTALL_DIR:?}/$name"
  echo "  Removed $INSTALL_DIR/$name: the tree no longer has it"
done

# config/: the tree's examples replaced, and one the tree dropped removed; every
# other file there is the host's and stays.
mkdir -p "$INSTALL_DIR/config"
for f in "$INSTALL_DIR/config"/*.example; do
  [[ -e "$SOURCE_DIR/config/${f##*/}" ]] && continue
  rm -f "$f"
  echo "  Removed $f: the tree no longer has it"
done
for f in "$SOURCE_DIR/config"/*.example; do
  cp -a "$f" "$INSTALL_DIR/config/"
done
shopt -u dotglob nullglob

echo "  Installed the tree under $INSTALL_DIR"
