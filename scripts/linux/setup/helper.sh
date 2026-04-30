#!/usr/bin/env bash
# Install a helper script to /usr/local/bin/<name> and add sudoers entry. Run as root.
# Usage: helper.sh <src-script> <basename> <username> [extra-package ...]
# Example: helper.sh /opt/wisp/backend/scripts/wisp-mount wisp-mount myuser cifs-utils
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <src-script> <basename> <username> [extra-package ...]"
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"

SCRIPT_SRC="$1"
SCRIPT_BASENAME="$2"
DEPLOY_USER="$3"
shift 3
EXTRA_PACKAGES=("$@")

DEST_PATH="/usr/local/bin/$SCRIPT_BASENAME"
SCRIPT_NAME="$SCRIPT_BASENAME"
SUDOERS_NAME="${SCRIPT_NAME//[^a-z0-9-]/}"
SUDOERS_FILE="/etc/sudoers.d/$SUDOERS_NAME"

if [[ ! -f "$SCRIPT_SRC" ]]; then
  echo "  Skipped ($SCRIPT_NAME): script not found at $SCRIPT_SRC"
  exit 0
fi

if [[ ${#EXTRA_PACKAGES[@]} -gt 0 ]]; then
  pkg_install "${EXTRA_PACKAGES[@]}"
  echo "  Installed packages: ${EXTRA_PACKAGES[*]}"
fi

# Write to a temp file then atomic-rename into place. `cp src dst` keeps
# dst's inode and rewrites contents under any process that's currently
# executing dst — that's exactly the case for wisp-update self-update,
# where the running helper triggers install-helpers.sh, which then loops
# back and `cp`s itself. Bash reads scripts line-by-line, so corrupting
# the file mid-execution led to a silent non-zero exit (syntax error /
# command-not-found) several lines later, with no `fail` message and no
# obvious clue. `mv -f` over the same filesystem is rename(2) — the old
# inode stays open for the running process; new invocations get the new
# file.
TMP_DEST="${DEST_PATH}.new.$$"
cp "$SCRIPT_SRC" "$TMP_DEST"
chmod 755 "$TMP_DEST"
mv -f "$TMP_DEST" "$DEST_PATH"
echo "  Installed $SCRIPT_NAME to $DEST_PATH"

echo "$DEPLOY_USER ALL=(root) NOPASSWD: $DEST_PATH" > "$SUDOERS_FILE"
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" || { echo "  ERROR: Invalid sudoers file"; rm -f "$SUDOERS_FILE"; exit 1; }
echo "  Configured sudo: $DEPLOY_USER may run $DEST_PATH without password"
