#!/usr/bin/env bash
# Wisp install, from a release-shaped tree (a release tarball, or what push.sh
# ships — scripts/stage-release.sh builds both). Hosts never build. Run as a
# normal user (not root), with sudo. Linux only.
#
# It asks everything first, changing nothing: the server name and the password
# when the install has none yet, and — only when the host's uplink is not
# bridged yet — one confirmation naming the interface and address it will
# bridge; then sudo's own password. Then one root process works to the end:
# copy, setup (its last change applies the bridge), config, backend
# dependencies, and Wisp started and ready. It runs in a session of its own,
# writing to a log this script follows, so a connection that drops while the
# bridge is applied loses nothing.
#
# Usage: ./scripts/install.sh [install-dir] [--server-name NAME]
#   install-dir         default /opt/wisp
#   --server-name NAME  the server name when the install has none yet; with no
#                       terminal it defaults to the host name
# With no terminal on stdin: the password, when the install has none yet, is
# read as one line from stdin, and the bridge is created without asking.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
SOURCE_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

INSTALL_DIR=""
SERVER_NAME=""
while (( $# > 0 )); do
  case "$1" in
    --server-name) SERVER_NAME="${2:-}"; shift 2 ;;
    -*) echo "ERROR: Unknown flag: $1"; exit 1 ;;
    *) INSTALL_DIR="$1"; shift ;;
  esac
done
INSTALL_DIR="${INSTALL_DIR:-/opt/wisp}"
INSTALL_DIR="${INSTALL_DIR%/}"
[[ "$INSTALL_DIR" == /* ]] || { echo "ERROR: the install directory must be an absolute path: $INSTALL_DIR"; exit 1; }

# --- Pre-flight: nothing has changed yet ---
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: This script is for Linux only. Build a release-shaped tree with scripts/stage-release.sh (push.sh does), then run its install.sh on the target server."
  exit 1
fi
if [[ $EUID -eq 0 ]]; then
  echo "ERROR: Do not run this script as root. Run it as the user Wisp will run as; it uses sudo itself."
  exit 1
fi
# scripts/stage-release.sh writes RELEASE into every tree it stages.
if [[ ! -f "$SOURCE_DIR/RELEASE" ]]; then
  echo "ERROR: $SOURCE_DIR is not a release-shaped tree (no RELEASE file). Install from a release tarball, or push one with scripts/push.sh."
  exit 1
fi
REL_VERSION="" REL_COMMIT="" REL_UNCOMMITTED=""
while IFS='=' read -r key value; do
  case "$key" in
    version) REL_VERSION="$value" ;;
    commit) REL_COMMIT="$value" ;;
    uncommitted) REL_UNCOMMITTED="$value" ;;
  esac
done < "$SOURCE_DIR/RELEASE"

# Refuse an unsupported distro, a network tool setup cannot configure or an
# uplink that cannot be bridged; and know the bridge plan for the question.
# shellcheck source=setup/distro.sh
source "$SCRIPT_DIR/setup/distro.sh"
# shellcheck source=setup/network-plan.sh
source "$SCRIPT_DIR/setup/network-plan.sh"

echo "=== Wisp Install ==="
echo "Release: ${REL_VERSION:-unknown} (commit ${REL_COMMIT:0:12}$([[ "$REL_UNCOMMITTED" == yes ]] && echo ', staged with uncommitted changes'))"
echo "Into:    $INSTALL_DIR"
echo ""

TERMINAL=0
[[ -t 0 ]] && TERMINAL=1

# --- The questions ---
CONFIG_FILE="$INSTALL_DIR/config/wisp-config.json"
NEED_NAME=1
if [[ -f "$CONFIG_FILE" ]] && python3 -c 'import json, sys; sys.exit(0 if json.load(open(sys.argv[1])).get("serverName") else 1)' "$CONFIG_FILE" 2>/dev/null; then
  NEED_NAME=0
fi
if (( NEED_NAME )); then
  DEFAULT_NAME="$(hostname 2>/dev/null || echo 'My Server')"
  if [[ -z "$SERVER_NAME" ]]; then
    if (( TERMINAL )); then
      read -r -p "Server name [$DEFAULT_NAME]: " SERVER_NAME
    fi
    SERVER_NAME="${SERVER_NAME:-$DEFAULT_NAME}"
  fi
fi

PASSWORD=""
if [[ ! -s "$INSTALL_DIR/config/wisp-password" ]]; then
  if (( TERMINAL )); then
    while :; do
      read -r -s -p "Wisp password: " PASSWORD; echo ""
      if [[ "${#PASSWORD}" -lt 6 || "$PASSWORD" == changeme ]]; then
        echo "  At least 6 characters, and not 'changeme'. Try again."; continue
      fi
      read -r -s -p "Confirm password: " PASSWORD2; echo ""
      [[ "$PASSWORD" == "$PASSWORD2" ]] && break
      echo "  The passwords do not match. Try again."
    done
  else
    IFS= read -r PASSWORD || true
    if [[ -z "$PASSWORD" ]]; then
      echo "ERROR: no password: with no terminal, give Wisp's password as one line on stdin. Nothing was changed." >&2
      exit 1
    fi
    if [[ "${#PASSWORD}" -lt 6 || "$PASSWORD" == changeme ]]; then
      echo "ERROR: the password must have at least 6 characters and not be 'changeme'. Nothing was changed." >&2
      exit 1
    fi
  fi
fi

if [[ "$BRIDGE_CREATE" == yes ]]; then
  if (( TERMINAL )); then
    echo ""
    echo "Wisp's VMs and containers join the network through a bridge, and this host has none on its uplink."
    read -r -p "Create $BRIDGE on $UPLINK (${UPLINK_ADDR:-no IPv4 address}), keeping its address? The connection may pause while it is applied. [Y/n] " ans || ans=n
    if [[ "${ans:-Y}" =~ ^[nN] ]]; then
      echo "Wisp needs a bridge: make one on $UPLINK with the host's network tool, or let setup make it. Nothing was changed."
      exit 1
    fi
  else
    echo "Creating $BRIDGE on $UPLINK (${UPLINK_ADDR:-no IPv4 address}) during setup: no terminal to ask."
  fi
fi

# sudo's own password, now, when the host's sudoers asks for one: the root
# process below runs to the end unasked. A command, not `sudo -v`, which asks
# for a password whenever any of the user's sudoers entries would.
sudo true

# --- One root process to the end ---
LOG="$(mktemp -t wisp-install.XXXXXX.log)"
echo ""
echo "Installing. The log is $LOG; the install goes on if this connection drops."
echo ""
(( NEED_NAME )) || SERVER_NAME=""
printf '%s\n' "$PASSWORD" \
  | sudo setsid --wait "$SCRIPT_DIR/install-root.sh" "$SOURCE_DIR" "$INSTALL_DIR" "$(id -un)" "$(id -gn)" "$SERVER_NAME" \
    >> "$LOG" 2>&1 &
ROOT_PID=$!
# Follows the log until the root process ends, then prints what is left.
tail -n +1 -f --pid="$ROOT_PID" "$LOG"
rc=0
wait "$ROOT_PID" || rc=$?
exit "$rc"
