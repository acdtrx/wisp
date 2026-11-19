#!/usr/bin/env bash
# Setup step: wisp.service rendered from the install tree's template (the deploy
# user and the install dir substituted) and enabled, so the host starts Wisp at
# boot. Starting it is the installer's and the updater's last step. Run as root.
# Usage: service-unit.sh <project-root> <deploy-user>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <project-root> <deploy-user>"
  exit 1
fi

PROJECT_ROOT="$(cd "$1" && pwd)"
DEPLOY_USER="$2"
SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin

UNIT=/etc/systemd/system/wisp.service

echo "--- wisp.service ---"

RENDERED="$(staged_file)"
sed -e "s|WISP_USER|$DEPLOY_USER|g" -e "s|WISP_PATH|$PROJECT_ROOT|g" "$PROJECT_ROOT/systemd/linux/wisp.service" > "$RENDERED"
if write_if_changed "$UNIT" 0644 "$RENDERED"; then
  systemd_call daemon-reload
  changed "$UNIT"
fi
if ! systemctl is-enabled --quiet wisp.service; then
  systemd_call enable --quiet wisp.service
  changed "wisp.service enabled"
fi
step_done
