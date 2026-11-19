#!/usr/bin/env bash
# The installer's root process (scripts/linux/install.sh runs it with sudo).
#
# First, in the foreground, changing nothing: one install at a time (a lock),
# the release, the host refused or accepted (distro, network plan — the bridge
# worked out and checked), then the questions. Then the work runs to the end in
# a process of its own, in a session of its own, ignoring the hangup and
# writing only to a log: copy the tree, run setup (whose last change applies
# the bridge, after the backend's dependencies and the answers), and start
# Wisp, waiting until it is ready. This process follows the log until the work
# ends; a dropped connection or Ctrl-C stops only the following. The log is
# removed once the install has succeeded, and kept, and named, when it fails.
# A directory push.sh made for the tree is removed when the install ends,
# however it ends: by the work once it has started, else by this process.
#
# Usage: install-root.sh <source-dir> <install-dir> <user> <group> <server-name or ""> <push-dir or "">
#   (with no terminal on stdin, the password, when the install has none yet, is
#   its first line)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run by scripts/linux/install.sh, as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SETUP_SRC="$SCRIPT_DIR/setup"

# --- The work, in its own session ---
if [[ "${1:-}" == --work ]]; then
  shift
  SOURCE_DIR="$1" INSTALL_DIR="$2" DEPLOY_USER="$3" DEPLOY_GROUP="$4" LOG="$5" REMOVE_DIR="$6"
  trap '' HUP
  trap 'rm -rf "$WISP_INSTALL_ANSWERS" ${REMOVE_DIR:+"$REMOVE_DIR"}' EXIT

  echo "--- Installing the tree ---"
  "$SETUP_SRC/copy.sh" "$SOURCE_DIR" "$INSTALL_DIR"
  chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"
  SETUP_DIR="$INSTALL_DIR/scripts/linux/setup"

  echo ""
  # Setup works the plan out again, under the lock this process holds (fd 8),
  # and stops before any change if it would bridge otherwise than the operator
  # confirmed (WISP_CONFIRMED_BRIDGE); it writes the answers
  # (WISP_INSTALL_ANSWERS); its last change is the bridge.
  "$SETUP_DIR/common-steps.sh" "$INSTALL_DIR" "$DEPLOY_USER"

  echo ""
  echo "--- Starting Wisp ---"
  # shellcheck source=setup/service.sh
  source "$SETUP_DIR/service.sh"
  wisp_service restart

  # shellcheck source=../../backend/scripts/wisp-port.sh
  source "$INSTALL_DIR/backend/scripts/wisp-port.sh"
  WISP_PORT="$(wisp_port "$INSTALL_DIR/config/runtime.env")"
  echo ""
  echo "=== Install complete ==="
  echo ""
  echo "  Install path: $INSTALL_DIR"
  echo "  Access:       http://$(hostname -f 2>/dev/null || hostname):${WISP_PORT}"
  echo ""
  # Whoever follows the log still reads it to the end.
  rm -f "$LOG"
  exit 0
fi

# --- In the foreground: refuse or ask, changing nothing ---
# A hangup ends only the following of the log; this process still waits for
# the work, so whoever waits for it (push.sh's shell) waits for the work too.
trap '' HUP
if [[ $# -ne 6 ]]; then
  echo "Usage (as root, from install.sh): $0 <source-dir> <install-dir> <user> <group> <server-name or \"\"> <push-dir or \"\">" >&2
  exit 1
fi
SOURCE_DIR="$1" INSTALL_DIR="$2" DEPLOY_USER="$3" DEPLOY_GROUP="$4" SERVER_NAME="$5" REMOVE_DIR="$6"

# The push's directory: the one above the tree, as push.sh names it; marked,
# so push.sh leaves it to the install from here.
if [[ -n "$REMOVE_DIR" ]]; then
  [[ "$REMOVE_DIR" == "$(dirname "$SOURCE_DIR")" && "$REMOVE_DIR" =~ ^/tmp/wisp-push\.[A-Za-z0-9]+$ && ! -L "$REMOVE_DIR" ]] \
    || { echo "ERROR: --remove-source is for a tree push.sh unpacked in /tmp/wisp-push.*; this one is $SOURCE_DIR." >&2; exit 1; }
  touch "$REMOVE_DIR/.install-started"
  trap 'rm -rf "$REMOVE_DIR"' EXIT
fi

# The install path, before anything is written there or owned by the deploy
# user: absolute, and missing, empty, or a Wisp install already.
[[ "$INSTALL_DIR" == /?* && "$INSTALL_DIR" != *//* && "$INSTALL_DIR" != */../* && "$INSTALL_DIR" != */.. ]] \
  || { echo "ERROR: the install directory must be a plain absolute path: $INSTALL_DIR" >&2; exit 1; }
if [[ -e "$INSTALL_DIR" ]]; then
  if [[ ! -d "$INSTALL_DIR" ]]; then
    echo "ERROR: $INSTALL_DIR exists and is not a directory." >&2; exit 1
  elif [[ -n "$(ls -A "$INSTALL_DIR")" ]] \
    && ! grep -qs '"name": *"wisp-backend"' "$INSTALL_DIR/backend/package.json"; then
    echo "ERROR: $INSTALL_DIR holds something that is not a Wisp install; install into an empty or new directory." >&2; exit 1
  fi
fi

# One lock for anything that changes the installation, held to the end and
# handed to the work and its setup (fd 8).
LOCK=/run/wisp.lock
exec 8> "$LOCK"
flock -n 8 || { echo "ERROR: another install, update or setup is running on this host (it holds $LOCK)." >&2; exit 1; }

# scripts/stage-release.sh writes RELEASE into every tree it stages.
if [[ ! -f "$SOURCE_DIR/RELEASE" ]]; then
  echo "ERROR: $SOURCE_DIR is not a release-shaped tree (no RELEASE file). Install from a release tarball, or push one with scripts/push.sh." >&2
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

echo "=== Wisp Install ==="
echo "Release: ${REL_VERSION:-unknown} (commit ${REL_COMMIT:0:12}$([[ "$REL_UNCOMMITTED" == yes ]] && echo ', staged with uncommitted changes'))"
echo "Into:    $INSTALL_DIR"
echo ""

# shellcheck source=setup/distro.sh
source "$SETUP_SRC/distro.sh"
# The asking phase changes nothing: the plan only classifies a journal an
# earlier bridge step left (NET_PLAN_ASK).
NET_PLAN_ASK=1
# shellcheck source=setup/network-plan.sh
source "$SETUP_SRC/network-plan.sh"
# shellcheck source=setup/install-state.sh
source "$SETUP_SRC/install-state.sh"

TERMINAL=0
[[ -t 0 ]] && TERMINAL=1
WISP_INSTALL_ANSWERS="$(mktemp -d -t wisp-install-answers.XXXXXX)"
export WISP_INSTALL_ANSWERS
trap 'rm -rf "$NET_PLAN_DIR" "$WISP_INSTALL_ANSWERS" ${REMOVE_DIR:+"$REMOVE_DIR"}' EXIT

case "$NET_PLAN_JOURNAL" in
  restore) echo "A bridge step that did not finish left its journal in $JOURNAL_DIR: the install undoes it first."; echo "" ;;
  finished) echo "A bridge step that did not record its end had finished: the install records it."; echo "" ;;
esac

if ! has_server_name "$INSTALL_DIR"; then
  DEFAULT_NAME="$(hostname)"
  if [[ -z "$SERVER_NAME" ]] && (( TERMINAL )); then
    read -r -p "Server name [$DEFAULT_NAME]: " SERVER_NAME
  fi
  printf '%s\n' "${SERVER_NAME:-$DEFAULT_NAME}" > "$WISP_INSTALL_ANSWERS/server-name"
fi

if ! has_password "$INSTALL_DIR"; then
  if (( TERMINAL )); then
    while :; do
      read -r -s -p "Wisp password: " PASSWORD; echo ""
      password_ok "$PASSWORD" || { echo "  The password needs $PASSWORD_RULE. Try again."; continue; }
      read -r -s -p "Confirm password: " PASSWORD2; echo ""
      [[ "$PASSWORD" == "$PASSWORD2" ]] && break
      echo "  The passwords do not match. Try again."
    done
  else
    IFS= read -r PASSWORD || true
    [[ -n "$PASSWORD" ]] || { echo "ERROR: no password: with no terminal, give Wisp's password as one line on stdin. Nothing was changed." >&2; exit 1; }
    password_ok "$PASSWORD" || { echo "ERROR: the password needs $PASSWORD_RULE. Nothing was changed." >&2; exit 1; }
  fi
  ( umask 077; printf '%s\n' "$PASSWORD" > "$WISP_INSTALL_ANSWERS/password" )
  unset PASSWORD PASSWORD2
fi

WISP_CONFIRMED_BRIDGE=none
[[ "$BRIDGE_CREATE" == yes ]] && WISP_CONFIRMED_BRIDGE="$BRIDGE on $UPLINK ($UPLINK_ADDR), through $NET_TOOL"
export WISP_CONFIRMED_BRIDGE
if [[ "$BRIDGE_CREATE" == yes ]]; then
  if (( TERMINAL )); then
    echo ""
    echo "Wisp's VMs and containers join the network through a bridge, and this host has none on its uplink."
    read -r -p "Create $BRIDGE on $UPLINK ($UPLINK_ADDR), keeping its address? The connection may pause while it is applied. [Y/n] " ans || ans=n
    if [[ "${ans:-Y}" =~ ^[nN] ]]; then
      echo "Wisp needs a bridge: make one on $UPLINK with the host's network tool, or let setup make it. Nothing was changed."
      exit 1
    fi
  else
    echo "Creating $BRIDGE on $UPLINK ($UPLINK_ADDR) during setup: no terminal to ask."
  fi
fi

# --- The work, handed on ---
# root's, readable by the deploy user's group: root may not write to a file of
# another user's in /tmp (fs.protected_regular).
LOG="$(mktemp -t wisp-install.XXXXXX.log)"
chgrp "$DEPLOY_GROUP" "$LOG"
chmod 0640 "$LOG"
echo ""
echo "Installing. The log is $LOG; the install goes on if this connection drops."
echo ""
# The work owns the answers from here, and the lock (fd 8); it plans again.
rm -rf "$NET_PLAN_DIR"
trap - EXIT
NET_PLAN_DIR="" setsid "$0" --work "$SOURCE_DIR" "$INSTALL_DIR" "$DEPLOY_USER" "$DEPLOY_GROUP" "$LOG" "$REMOVE_DIR" \
  < /dev/null >> "$LOG" 2>&1 &
WORK_PID=$!
# Ctrl-C: the following stops, by the signal, so a caller's shell stops too;
# the work goes on, with the tree it copies from, which it removes when push.sh
# made it.
trap 'echo ""; echo "Stopped following. The install goes on; its log is $LOG"; trap - INT; kill -INT $$' INT
tail -n +1 -f --pid="$WORK_PID" "$LOG"
rc=0
wait "$WORK_PID" || rc=$?
# The work removes these when it ends; and so does this, for a work that did
# not get to start.
rm -rf "$WISP_INSTALL_ANSWERS"
if (( rc != 0 )); then
  echo "" >&2
  echo "ERROR: the install failed; its log is $LOG" >&2
fi
exit "$rc"
