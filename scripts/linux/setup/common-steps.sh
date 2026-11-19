#!/usr/bin/env bash
# Wisp setup: the one list of steps that brings a host to what Wisp needs. The
# installer runs it after copying the tree, the updater after swapping it, both
# by this path from the install tree, so a step added here reaches new installs
# and updated hosts alike, at their next run.
#
# Every step checks first and changes only what is missing, so a second run
# reports every step in place. The run stops at the first step that fails,
# naming it, with a non-zero exit: the installer stops there, the updater rolls
# back.
#
# Usage: common-steps.sh <project-root> <deploy-user>   (as root)
set -uo pipefail

PROJECT_ROOT="${1:-}"
DEPLOY_USER="${2:-}"

if [[ -z "$PROJECT_ROOT" || -z "$DEPLOY_USER" ]]; then
  echo "Usage: $0 <project-root> <deploy-user>" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: setup must run as root (use sudo)." >&2
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SETUP_DIR/lib.sh"
# shellcheck source=bounds.sh
source "$SETUP_DIR/bounds.sh"
# shellcheck source=plan-record.sh
source "$SETUP_DIR/plan-record.sh"

# One lock for anything that changes the installation (/run/wisp.lock): the
# installer's root process and the updater take it at their start and hand it
# on (fd 8); setup run alone takes it here. The second waits, then gives up.
WISP_LOCK=/run/wisp.lock
WISP_LOCK_WAIT_SEC=600
if [[ ! /proc/self/fd/8 -ef "$WISP_LOCK" ]]; then
  exec 8> "$WISP_LOCK"
fi
if ! flock -w "$WISP_LOCK_WAIT_SEC" 8; then
  echo "ERROR: another install, update or setup holds $WISP_LOCK; gave up after ${WISP_LOCK_WAIT_SEC} s." >&2
  exit 1
fi

# Before any step runs: a distro Wisp does not support is refused.
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"

# The network plan's directory, the steps' to share (NET_PLAN_DIR), this
# script's to remove.
NET_PLAN_DIR="$(mktemp -d -t wisp-net-plan.XXXXXX)" || { echo "ERROR: cannot create a temp directory" >&2; exit 1; }
export NET_PLAN_DIR
trap 'rm -rf "$NET_PLAN_DIR"' EXIT

# A stop (TERM, INT) is passed to the step running, which ends — the bridge
# step undoing itself — and then the run ends. Each step runs as the leader of
# a session of its own (lib.sh), in the background, so the stop reaches this
# script at once and goes to every process of the step's session. The step gets
# STEP_STOP_SEC to end (bounds.sh), and its session is then killed: setup ends
# within SETUP_STOP_SEC of a stop, whoever sent it. The handler only records the
# stop when no step is known yet; the step started next is stopped as soon as
# its pid is.
STOPPING=0
STEP_PID=""
STEP_KILLER=""
stop_step() {
  [[ -n "$STEP_PID" && -z "$STEP_KILLER" ]] || return 0
  session_signal TERM "$STEP_PID"
  kill_later "$STEP_STOP_SEC" "$STEP_PID"
  STEP_KILLER="$KILLER"
}
trap 'STOPPING=1; stop_step' TERM INT

STEP_COUNT=0

# run_step <name> <script> [args...]: one step, by name; the first failure ends the run.
run_step() {
  local name="$1" script="$2" rc
  shift 2
  STEP_COUNT=$((STEP_COUNT + 1))
  (( STOPPING )) && { echo "setup stopped before step: $name" >&2; exit 143; }
  echo ""
  echo "step: $name"
  setsid "$SETUP_DIR/$script" "$@" &
  STEP_PID=$!
  (( STOPPING )) && stop_step
  # wait returns early for a stop; the step is gone once kill -0 fails.
  while :; do
    rc=0
    wait "$STEP_PID" || rc=$?
    kill -0 "$STEP_PID" 2>/dev/null || break
  done
  if (( STOPPING )); then
    # What the step started ends with it, within its bound.
    session_wait "$STEP_PID"
    [[ -z "$STEP_KILLER" ]] || { KILLER="$STEP_KILLER"; kill_later_cancel; }
    echo "setup stopped at step: $name" >&2
    exit 143
  fi
  STEP_PID="" STEP_KILLER=""
  (( rc == 0 )) && return 0
  echo ""
  echo "setup failed at step: $name (exit $rc)" >&2
  exit 1
}

echo "=== Wisp setup (deploy user: $DEPLOY_USER) ==="
run_step bridge-journal bridge-recover.sh
run_step network-plan network-plan.sh "$NET_PLAN_DIR"
plan_record_read "$NET_PLAN_DIR/plan" || exit 1
# The installer asked the operator about the bridge from its own plan
# (WISP_CONFIRMED_BRIDGE, plan_confirmation's): this run's plan, made under the
# lock, must be the same, or nothing more is changed.
if [[ -n "${WISP_CONFIRMED_BRIDGE:-}" && "$(plan_confirmation)" != "$WISP_CONFIRMED_BRIDGE" ]]; then
  _planned="$(plan_confirmation)"
  refuse NETWORK_CHANGED_SINCE_ASKED "the network changed since the install asked: it would now make ${_planned/#none/no bridge}, not ${WISP_CONFIRMED_BRIDGE/#none/no bridge}. Setup changed nothing after the bridge-journal step above. Run the install again."
fi

run_step packages packages.sh
run_step groups groups.sh "$DEPLOY_USER"
run_step dirs dirs.sh "$DEPLOY_USER"
run_step libvirt libvirt.sh
run_step containerd containerd.sh "$DEPLOY_USER"
run_step cni cni.sh "$BRIDGE"
run_step container-dns container-dns.sh "$NET_TOOL"
run_step avahi avahi.sh
run_step helpers install-helpers.sh "$PROJECT_ROOT" "$DEPLOY_USER"
run_step rapl rapl.sh "$DEPLOY_USER"
run_step service-unit service-unit.sh "$PROJECT_ROOT" "$DEPLOY_USER"
run_step backend-deps backend-deps.sh "$PROJECT_ROOT" "$DEPLOY_USER"
run_step answers answers.sh "$PROJECT_ROOT" "$DEPLOY_USER"
run_step sanity sanity.sh
run_step bridge bridge.sh
echo ""
echo "=== Wisp setup done ($STEP_COUNT steps) ==="
