#!/usr/bin/env bash
# Install or refresh Wisp privileged helpers under /usr/local/bin + sudoers.
# Idempotent: re-copy from the project tree so upgrades pick up script changes.
#
# Run as root.
# Usage: install-helpers.sh <project-root> <deploy-user>
#
# Called from: setup-server.sh, wispctl helpers, push.sh (remote).
#
# Maintainer: when adding a new backend/scripts/wisp-* privileged helper, add a block
# below, wire the backend to prefer /usr/local/bin (see existing patterns), and update
# docs/spec/DEPLOYMENT.md — "Privileged helpers checklist".
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: install-helpers.sh must run as root (e.g. sudo $0 ...)."
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <project-root> <deploy-user>"
  exit 1
fi

PROJECT_ROOT="$(cd "$1" && pwd)"
DEPLOY_USER="$2"
SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Wisp privileged helpers → /usr/local/bin ==="
echo "Project: $PROJECT_ROOT"
echo "Deploy user: $DEPLOY_USER"
echo ""

echo "--- wisp-os-update (OS update check/upgrade, Debian/Ubuntu and Arch) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-os-update" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-os-update" wisp-os-update "$DEPLOY_USER"
  echo "  Installed /usr/local/bin/wisp-os-update."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-os-update)"
fi
echo ""

echo "--- wisp-dmidecode (RAM module info) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-dmidecode" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-dmidecode" wisp-dmidecode "$DEPLOY_USER" dmidecode
  echo "  Installed /usr/local/bin/wisp-dmidecode."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-dmidecode)"
fi
echo ""

echo "--- wisp-smartctl (disk SMART health) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-smartctl" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-smartctl" wisp-smartctl "$DEPLOY_USER" smartmontools
  echo "  Installed /usr/local/bin/wisp-smartctl."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-smartctl)"
fi
echo ""

echo "--- wisp-mount (SMB + removable disk mount helper) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-mount" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-mount" wisp-mount "$DEPLOY_USER" cifs-utils
  echo "  Installed /usr/local/bin/wisp-mount."
  # Remove obsolete wisp-smb (superseded by wisp-mount smb ...).
  if [[ -f /usr/local/bin/wisp-smb ]]; then
    rm -f /usr/local/bin/wisp-smb
    echo "  Removed obsolete /usr/local/bin/wisp-smb."
  fi
  if [[ -f /etc/sudoers.d/wisp-smb ]]; then
    rm -f /etc/sudoers.d/wisp-smb
    echo "  Removed obsolete /etc/sudoers.d/wisp-smb."
  fi
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-mount)"
fi
echo ""

echo "--- wisp-power (host shutdown / reboot) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-power" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-power" wisp-power "$DEPLOY_USER"
  echo "  Installed /usr/local/bin/wisp-power."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-power)"
fi
echo ""

echo "--- wisp-netns (container network namespaces) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-netns" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-netns" wisp-netns "$DEPLOY_USER"
  echo "  Installed /usr/local/bin/wisp-netns."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-netns)"
fi
echo ""

echo "--- wisp-cni (privileged CNI plugin exec for containers) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-cni" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-cni" wisp-cni "$DEPLOY_USER"
  echo "  Installed /usr/local/bin/wisp-cni."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-cni)"
fi
echo ""

echo "--- wisp-bridge (host VLAN bridge netplan helper) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-bridge" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-bridge" wisp-bridge "$DEPLOY_USER"
  echo "  Installed /usr/local/bin/wisp-bridge."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-bridge)"
fi
echo ""

echo "--- wisp-update (self-update atomic swap + service restart) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-update" ]]; then
  "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-update" wisp-update "$DEPLOY_USER" rsync
  echo "  Installed /usr/local/bin/wisp-update."
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-update)"
fi
echo ""

echo "=== Helpers step complete ==="
