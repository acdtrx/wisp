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

# One lock for anything that changes the installation (WISP_LOCK, lib.sh): the
# installer's root process and the updater take it at their start and hand it
# on (fd 8); setup run alone takes it here, waiting up to LOCK_WAIT_SEC. Setup
# holds it; the steps do not need it and run without the descriptor, so
# nothing a step starts (dpkg's maintainer scripts, npm) can hold the lock.
if [[ ! /proc/self/fd/8 -ef "$WISP_LOCK" ]]; then
  exec 8> "$WISP_LOCK"
fi
if ! flock -w "$LOCK_WAIT_SEC" 8; then
  echo "ERROR: another install, update or setup holds $WISP_LOCK; gave up after ${LOCK_WAIT_SEC} s." >&2
  exit 1
fi

# Before any step runs: a distro Wisp does not support is refused.
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"

# The network plan's directory, the steps' to share (NET_PLAN_DIR), this
# script's to remove.
NET_PLAN_DIR=""
trap 'rm -rf ${NET_PLAN_DIR:+"$NET_PLAN_DIR"}' EXIT
NET_PLAN_DIR="$(mktemp -d -t wisp-net-plan.XXXXXX)" || { echo "ERROR: cannot create a temp directory" >&2; exit 1; }
export NET_PLAN_DIR

# A stop (TERM, INT) goes to the running step's leader alone: the step knows
# which of what it runs may be cut short, ends it, and exits (step.sh,
# step_stop). Setup waits until the step's session is empty, and at
# STEP_STOP_SEC (bounds.sh) KILLs what is left of it: it ends within
# SETUP_STOP_SEC of a stop, whoever sent it. The handler does the whole stop
# and exits, so it never returns into a wait; the step is found as setup's one
# background job, which holds even when the stop comes as the step starts.
STEP_NAME=""
# session_end <sid> <secs>: until the session <sid> leads is empty — no event
# says so: checked once a second — with KILL to what is left of it after
# <secs>; past NET_KILL_SEC more, what outlived the KILL is named.
session_end() {
  local deadline=$(( SECONDS + $2 ))
  while kill -0 "$1" 2>/dev/null || pgrep -s "$1" >/dev/null; do
    if (( SECONDS >= deadline + NET_KILL_SEC )); then
      echo "ERROR: step $STEP_NAME left processes that outlived KILL: $(pgrep -d ' ' -s "$1")" >&2
      return 1
    fi
    if (( SECONDS >= deadline )); then pkill -KILL -s "$1" 2>/dev/null; fi
    sleep 1
  done
}
setup_stop() {
  local pid
  trap '' TERM INT
  pid="$(jobs -p)"
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null
    session_end "$pid" "$STEP_STOP_SEC" || true
    echo "setup stopped at step: $STEP_NAME" >&2
  else
    echo "setup stopped${STEP_NAME:+ after step: $STEP_NAME}" >&2
  fi
  exit 143
}
trap setup_stop TERM INT

STEP_COUNT=0

# run_step <name> <script> [args...]: one step, by name, as the leader of a
# session of its own; the first failure ends the run.
run_step() {
  local name="$1" script="$2" rc=0 left
  shift 2
  STEP_COUNT=$((STEP_COUNT + 1))
  echo ""
  echo "step: $name"
  STEP_NAME="$name"
  setsid "$SETUP_DIR/$script" "$@" 8>&- &
  # A stop never returns here (setup_stop exits): wait ends with the step.
  wait "$!" || rc=$?
  # What the step started ends with it: a process it left behind is ended.
  left="$(pgrep -d ' ' -s "$!" || true)"
  if [[ -n "$left" ]]; then
    echo "  ended what step $name left running: $(ps -o comm= -p "${left// /,}" | tr '\n' ' ')" >&2
    pkill -TERM -s "$!" 2>/dev/null
    session_end "$!" "$NET_KILL_SEC" || exit 1
  fi
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
run_step container-dns container-dns.sh "$NET_TOOL" "$BRIDGE"
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
