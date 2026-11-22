#!/usr/bin/env bash
# Install a release-shaped tree into the install folder: the one sequence of an
# install and an update (docs/specs/DEPLOYMENT.md, docs/specs/UPDATES.md). The
# installer runs the copy of this file in the tree it installs; the updater runs
# the copy in the staged tree, and on its way back the one in the restored tree.
#
# Contract — release N's updater runs release N+1's copy, so it stays stable:
#   install-tree.sh <source-dir> <install-dir> <deploy-user> <deploy-group>, as root.
#   The caller holds /run/wisp.lock on fd 8, or this takes it. <source-dir> is a
#   release-shaped tree; the same folder as <install-dir> installs nothing anew
#   (the copy is skipped). WISP_CONFIRMED_BRIDGE and WISP_INSTALL_ANSWERS pass
#   through to setup. It prints `phase: stop|copy|setup|start` lines and exits
#   0 installed and Wisp ready; 1 Wisp did not stop (nothing changed); 2 the copy
#   failed; 3 setup failed; 4 Wisp did not start. A TERM ends it within setup's
#   stop bound (SETUP_STOP_SEC, scripts/linux/setup/bounds.sh), and any other
#   phase at once. A later release
#   may add phases or exit codes, never change the path, the arguments, what 0
#   means, or lengthen that stop.
set -uo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <source-dir> <install-dir> <deploy-user> <deploy-group>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: install-tree.sh must run as root." >&2
  exit 1
fi
SOURCE_DIR="$1" INSTALL_DIR="$2" DEPLOY_USER="$3" DEPLOY_GROUP="$4"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=setup/lib.sh
source "$SCRIPT_DIR/setup/lib.sh"
# shellcheck source=setup/bounds.sh
source "$SCRIPT_DIR/setup/bounds.sh"
# shellcheck source=setup/service.sh
source "$SCRIPT_DIR/setup/service.sh"

if [[ ! /proc/self/fd/8 -ef "$WISP_LOCK" ]]; then
  exec 8> "$WISP_LOCK"
fi
if ! flock -w "$LOCK_WAIT_SEC" 8; then
  echo "ERROR: another install, update or setup holds $WISP_LOCK; gave up after ${LOCK_WAIT_SEC} s." >&2
  exit 1
fi

# Each phase runs in the background and is waited for, so a TERM reaches this
# script at once, and is passed on: setup, which stops itself in order within
# its stop bound, gets it on its leader alone; any other phase (a function: a
# systemctl, the copy) gets it in its whole process group — job control (set -m)
# gives each phase one of its own — so the command it runs ends with it. The
# phase is waited out and the run exits 143.
set -m
PHASE_PID=""
PHASE_OWN_STOP=0
STOPPING=0
stop_phase() {
  [[ -n "$PHASE_PID" ]] || return 0
  if (( PHASE_OWN_STOP )); then
    kill -TERM "$PHASE_PID" 2>/dev/null
  else
    kill -TERM -- "-$PHASE_PID" 2>/dev/null
  fi
}
on_stop() {
  STOPPING=1
  stop_phase
}
trap on_stop TERM INT

# phase <name> <exit on failure> <own-stop|group> <cmd...>
phase() {
  local name="$1" code="$2" rc=0
  PHASE_OWN_STOP=0
  [[ "$3" != own-stop ]] || PHASE_OWN_STOP=1
  shift 3
  (( STOPPING )) && exit 143
  echo "phase: $name"
  "$@" &
  PHASE_PID=$!
  # A stop that came before the pid was known is passed on now.
  (( STOPPING )) && stop_phase
  while :; do
    wait "$PHASE_PID" && rc=0 || rc=$?
    kill -0 "$PHASE_PID" 2>/dev/null || break
  done
  PHASE_PID=""
  (( STOPPING )) && exit 143
  (( rc == 0 )) && return 0
  echo "ERROR: the install's $name phase failed (exit $rc)." >&2
  exit "$code"
}

stop_wisp() {
  wisp_service_installed || return 0
  wisp_service_stop
}
copy_tree() {
  "$SCRIPT_DIR/setup/copy.sh" "$SOURCE_DIR" "$INSTALL_DIR" && chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"
}

phase stop 1 group stop_wisp
phase copy 2 group copy_tree
phase setup 3 own-stop "$INSTALL_DIR/scripts/linux/setup/common-steps.sh" "$INSTALL_DIR" "$DEPLOY_USER"
phase start 4 group wisp_service start
exit 0
