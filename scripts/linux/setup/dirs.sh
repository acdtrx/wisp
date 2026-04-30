#!/usr/bin/env bash
# Create /var/lib/wisp/{images,vms,backups,containers}, /mnt/wisp; set ownership. Run as root.
# Usage: dirs.sh <username>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

DEPLOY_USER="${1:-${SUDO_USER:-}}"
if [[ -z "$DEPLOY_USER" ]]; then
  echo "Usage: $0 <username>"
  echo "  Or run with sudo so SUDO_USER is set."
  exit 1
fi

echo "--- Setting permissions ---"

IMAGE_DIR="/var/lib/wisp/images"
VMS_DIR="/var/lib/wisp/vms"
BACKUPS_DIR="/var/lib/wisp/backups"
CONTAINERS_DIR="/var/lib/wisp/containers"
UPDATES_DIR="/var/lib/wisp/updates"
WISP_MOUNT_ROOT="/mnt/wisp"
mkdir -p "$IMAGE_DIR" "$VMS_DIR" "$BACKUPS_DIR" "$CONTAINERS_DIR" "$UPDATES_DIR" "$WISP_MOUNT_ROOT"
chown "$DEPLOY_USER:libvirt" "$IMAGE_DIR" "$VMS_DIR" "$BACKUPS_DIR" "$CONTAINERS_DIR" "$UPDATES_DIR" "$WISP_MOUNT_ROOT"
chmod 0775 "$IMAGE_DIR" "$VMS_DIR" "$BACKUPS_DIR" "$CONTAINERS_DIR" "$UPDATES_DIR" "$WISP_MOUNT_ROOT"
echo "  $IMAGE_DIR: created, owned by $DEPLOY_USER:libvirt"
echo "  $VMS_DIR: created, owned by $DEPLOY_USER:libvirt"
echo "  $BACKUPS_DIR: created, owned by $DEPLOY_USER:libvirt"
echo "  $CONTAINERS_DIR: created, owned by $DEPLOY_USER:libvirt"
echo "  $UPDATES_DIR: created, owned by $DEPLOY_USER:libvirt (self-update staging tarballs)"
echo "  $WISP_MOUNT_ROOT: created, owned by $DEPLOY_USER:libvirt (child mount points are created on demand by wisp-mount)"
