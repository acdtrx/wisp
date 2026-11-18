#!/usr/bin/env bash
# Setup step: Wisp's state directories under /var/lib/wisp and the mount root
# /mnt/wisp, owned by the deploy user and group libvirt, mode 0775. Run as root.
# Usage: dirs.sh <username>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

DEPLOY_USER="${1:-}"
if [[ -z "$DEPLOY_USER" ]]; then
  echo "Usage: $0 <username>"
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

echo "--- Directories ---"

# images/vms/backups/containers: the backend's stores; updates: self-update
# staging; /mnt/wisp: parent of the mount points wisp-mount creates on demand.
for dir in /var/lib/wisp/images /var/lib/wisp/vms /var/lib/wisp/backups /var/lib/wisp/containers \
  /var/lib/wisp/updates /mnt/wisp; do
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir"
    changed "$dir created"
  fi
  if [[ "$(stat -c %U:%G "$dir")" != "$DEPLOY_USER:libvirt" ]]; then
    chown "$DEPLOY_USER:libvirt" "$dir"
    changed "$dir owned by $DEPLOY_USER:libvirt"
  fi
  if [[ "$(stat -c %a "$dir")" != 775 ]]; then
    chmod 0775 "$dir"
    changed "$dir mode 0775"
  fi
done
step_done
