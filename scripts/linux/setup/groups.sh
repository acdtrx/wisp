#!/usr/bin/env bash
# Setup step: the deploy user in the libvirt, kvm and input groups. Run as root.
# Usage: groups.sh <username>
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

echo "--- Groups ---"

for group in libvirt kvm input; do
  if ! getent group "$group" >/dev/null; then
    echo "ERROR: group $group does not exist (the packages step installs what creates it)." >&2
    exit 1
  fi
  if ! in_group "$DEPLOY_USER" "$group"; then
    usermod -aG "$group" "$DEPLOY_USER"
    changed "$DEPLOY_USER added to $group"
  fi
done
step_done
