#!/usr/bin/env bash
# Wisp install, from a release-shaped tree (a release tarball, or what push.sh
# ships — scripts/stage-release.sh builds both). Hosts never build. Run as the
# user Wisp will run as (not root), with sudo. Linux only.
#
# One sudo, for the root process that does the rest (scripts/linux/install-root.sh):
# it refuses an unsupported host, asks its questions — the server name and the
# password when the install has none yet, and, only when the host's uplink is
# not bridged yet, one confirmation naming the interface and address it will
# bridge — and then installs to the end unattended, in a process of its own
# whose output goes to a log it follows here.
#
# Usage: ./scripts/install.sh [install-dir] [--server-name NAME] [--remove-source]
#   install-dir         default /opt/wisp
#   --server-name NAME  the server name when the install has none yet; with no
#                       terminal it defaults to the host name
#   --remove-source     the directory push.sh made for this tree (/tmp/wisp-push.*,
#                       the one above it) is removed by the install once it is
#                       done with it
# With no terminal on stdin: the password, when the install has none yet, is
# read as one line from stdin, and the bridge is created without asking.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
SOURCE_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

INSTALL_DIR=""
SERVER_NAME=""
REMOVE_DIR=""
while (( $# > 0 )); do
  case "$1" in
    --remove-source) REMOVE_DIR="$(dirname "$SOURCE_DIR")"; shift ;;
    --server-name)
      [[ $# -ge 2 && -n "$2" ]] || { echo "ERROR: --server-name needs a name" >&2; exit 1; }
      SERVER_NAME="$2"
      shift 2
      ;;
    -*) echo "ERROR: Unknown flag: $1" >&2; exit 1 ;;
    *) INSTALL_DIR="$1"; shift ;;
  esac
done
INSTALL_DIR="${INSTALL_DIR:-/opt/wisp}"
INSTALL_DIR="${INSTALL_DIR%/}"
[[ "$INSTALL_DIR" == /* ]] || { echo "ERROR: the install directory must be an absolute path: $INSTALL_DIR" >&2; exit 1; }

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: This script is for Linux only. Build a release-shaped tree with scripts/stage-release.sh (push.sh does), then run its install.sh on the target server." >&2
  exit 1
fi
if [[ $EUID -eq 0 ]]; then
  echo "ERROR: Do not run this script as root. Run it as the user Wisp will run as; it uses sudo itself." >&2
  exit 1
fi

exec sudo "$SCRIPT_DIR/install-root.sh" "$SOURCE_DIR" "$INSTALL_DIR" "$(id -un)" "$(id -gn)" "$SERVER_NAME" "$REMOVE_DIR"
