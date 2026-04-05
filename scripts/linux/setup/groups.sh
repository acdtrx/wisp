#!/usr/bin/env bash
# Add deploy user to libvirt, kvm, input groups; chmod /dev/kvm. Run as root.
# Usage: groups.sh <username>
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

echo "--- Configuring groups ---"

for group in libvirt kvm input; do
  if getent group "$group" &>/dev/null; then
    usermod -aG "$group" "$DEPLOY_USER"
    echo "  Added $DEPLOY_USER to $group"
  else
    echo "  WARN: Group $group does not exist, skipping"
  fi
done

chmod 0660 /dev/kvm 2>/dev/null && echo "  /dev/kvm: mode 0660" || echo "  WARN: Could not chmod /dev/kvm"
