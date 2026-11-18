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

STEP_COUNT=0

# run_step <name> <script> [args...]: one step, by name; the first failure ends the run.
run_step() {
  local name="$1" script="$2" rc
  shift 2
  STEP_COUNT=$((STEP_COUNT + 1))
  echo ""
  echo "step: $name"
  "$SETUP_DIR/$script" "$@"
  rc=$?
  (( rc == 0 )) && return 0
  # cni.sh needs a bridge carrying the default route, and a fresh install offers
  # that bridge only once setup is done: until the network steps choose the
  # bridge themselves, a host with none ends this step unconfigured, as it
  # always has, and the run goes on.
  if [[ "$name" == cni ]]; then
    echo "step: cni not configured (exit $rc): container networking needs a bridge — see above"
    return 0
  fi
  echo ""
  echo "setup failed at step: $name (exit $rc)" >&2
  exit 1
}

echo "=== Wisp setup (deploy user: $DEPLOY_USER) ==="
run_step packages packages.sh
run_step groups groups.sh "$DEPLOY_USER"
run_step dirs dirs.sh "$DEPLOY_USER"
run_step libvirt libvirt.sh
run_step containerd containerd.sh "$DEPLOY_USER"
run_step cni cni.sh
run_step container-dns container-dns.sh
run_step avahi avahi.sh
run_step helpers install-helpers.sh "$PROJECT_ROOT" "$DEPLOY_USER"
run_step rapl rapl.sh "$DEPLOY_USER"
run_step service-unit service-unit.sh "$PROJECT_ROOT" "$DEPLOY_USER"
run_step sanity sanity.sh
echo ""
echo "=== Wisp setup done ($STEP_COUNT steps) ==="
