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
#
# Why no `set -e`: a single helper's failure (commonly: dpkg lock contention
# from unattended-upgrades) must not abort the rest. Each block tracks its
# own outcome; the script exits non-zero only at the end if any helper
# actually failed, so setup-server.sh's run_step still surfaces it.
set -uo pipefail

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

FAILED_HELPERS=()

# Run helper.sh for one privileged helper; on failure record and continue.
# $1 = helper basename (for tracking + log), remaining args = full helper.sh argv.
run_helper() {
  local label="$1"; shift
  if "$@"; then
    echo "  Installed /usr/local/bin/$label."
  else
    local rc=$?
    echo "  WARNING: $label install failed (exit $rc). Continuing with remaining helpers."
    FAILED_HELPERS+=("$label")
  fi
}

echo "=== Wisp privileged helpers → /usr/local/bin ==="
echo "Project: $PROJECT_ROOT"
echo "Deploy user: $DEPLOY_USER"
echo ""

echo "--- wisp-os-update (OS update check/upgrade, Debian/Ubuntu and Arch) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-os-update" ]]; then
  run_helper wisp-os-update "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-os-update" wisp-os-update "$DEPLOY_USER"
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-os-update)"
fi
echo ""

echo "--- wisp-dmidecode (RAM module info) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-dmidecode" ]]; then
  run_helper wisp-dmidecode "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-dmidecode" wisp-dmidecode "$DEPLOY_USER" dmidecode
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-dmidecode)"
fi
echo ""

echo "--- wisp-smartctl (disk SMART health) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-smartctl" ]]; then
  run_helper wisp-smartctl "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-smartctl" wisp-smartctl "$DEPLOY_USER" smartmontools
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-smartctl)"
fi
echo ""

echo "--- wisp-mount (SMB + removable disk mount helper) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-mount" ]]; then
  run_helper wisp-mount "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-mount" wisp-mount "$DEPLOY_USER" cifs-utils
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
  run_helper wisp-power "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-power" wisp-power "$DEPLOY_USER"
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-power)"
fi
echo ""

echo "--- wisp-netns (container network namespaces) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-netns" ]]; then
  run_helper wisp-netns "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-netns" wisp-netns "$DEPLOY_USER"
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-netns)"
fi
echo ""

echo "--- wisp-cni (privileged CNI plugin exec for containers) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-cni" ]]; then
  run_helper wisp-cni "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-cni" wisp-cni "$DEPLOY_USER"
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-cni)"
fi
echo ""

echo "--- wisp-bridge (host VLAN bridge netplan helper) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-bridge" ]]; then
  run_helper wisp-bridge "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-bridge" wisp-bridge "$DEPLOY_USER"
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-bridge)"
fi
echo ""

echo "--- wisp-nvram (UEFI NVRAM file copy for clone/backup/restore) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-nvram" ]]; then
  run_helper wisp-nvram "$SETUP_DIR/helper.sh" "$PROJECT_ROOT/backend/scripts/wisp-nvram" wisp-nvram "$DEPLOY_USER"
else
  echo "  Skipped (not found: $PROJECT_ROOT/backend/scripts/wisp-nvram)"
fi
echo ""

# wisp-updater install: doesn't fit the helper.sh pattern (templates a unit
# file, custom sudoers entry restricted to the systemctl start verb). Wrapped
# in a function so a visudo failure returns instead of exiting the whole
# script — same isolation other helpers get from run_helper.
install_wisp_updater() {
  # rsync is needed by the updater script itself.
  # shellcheck source=distro.sh
  source "$SETUP_DIR/distro.sh"
  pkg_install rsync || true

  # Install the script via atomic rename. wisp-updater itself runs install-helpers
  # mid-update, so the running inode must persist across the in-place refresh.
  local TMP_DEST="/usr/local/bin/wisp-updater.new.$$"
  cp "$PROJECT_ROOT/backend/scripts/wisp-updater" "$TMP_DEST" || return 1
  chmod 755 "$TMP_DEST" || return 1
  mv -f "$TMP_DEST" /usr/local/bin/wisp-updater || return 1
  echo "  Installed /usr/local/bin/wisp-updater."

  # Template + install the unit file. WISP_PATH → install dir, used by the
  # script as $WISP_INSTALL_DIR. Idempotent.
  sed -e "s|WISP_PATH|$PROJECT_ROOT|g" \
    "$PROJECT_ROOT/systemd/linux/wisp-updater.service" \
    > /etc/systemd/system/wisp-updater.service || return 1
  chmod 644 /etc/systemd/system/wisp-updater.service || return 1
  echo "  Installed /etc/systemd/system/wisp-updater.service."

  # Sudoers: deploy user may trigger the unit, and only that. argv must match
  # the backend's invocation exactly:
  #   sudo -n /usr/bin/systemctl start --no-block wisp-updater.service
  local SUDOERS_FILE=/etc/sudoers.d/wisp-updater
  echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service" > "$SUDOERS_FILE" || return 1
  chmod 440 "$SUDOERS_FILE" || return 1
  if ! visudo -c -f "$SUDOERS_FILE"; then
    echo "  ERROR: Invalid sudoers file"
    rm -f "$SUDOERS_FILE"
    return 1
  fi
  echo "  Configured sudo: $DEPLOY_USER may trigger wisp-updater.service."

  # Drop obsolete wisp-update (superseded by wisp-updater + systemd unit).
  if [[ -f /usr/local/bin/wisp-update ]]; then
    rm -f /usr/local/bin/wisp-update
    echo "  Removed obsolete /usr/local/bin/wisp-update."
  fi
  if [[ -f /etc/sudoers.d/wisp-update ]]; then
    rm -f /etc/sudoers.d/wisp-update
    echo "  Removed obsolete /etc/sudoers.d/wisp-update."
  fi

  systemctl daemon-reload || true
}

echo "--- wisp-updater (self-update applier, runs as wisp-updater.service) ---"
if [[ -f "$PROJECT_ROOT/backend/scripts/wisp-updater" && -f "$PROJECT_ROOT/systemd/linux/wisp-updater.service" ]]; then
  if install_wisp_updater; then
    : # success messages emitted inline above
  else
    echo "  WARNING: wisp-updater install failed. Continuing."
    FAILED_HELPERS+=("wisp-updater")
  fi
else
  echo "  Skipped (script or unit file missing)"
fi
echo ""

if [[ ${#FAILED_HELPERS[@]} -gt 0 ]]; then
  echo "=== Helpers step complete (with failures) ==="
  echo ""
  echo "  Failed: ${FAILED_HELPERS[*]}"
  echo ""
  echo "  Common cause: dpkg/apt lock contention from unattended-upgrades."
  echo "  Wait for apt to finish (\`ps -ef | grep apt\`), then re-run:"
  echo "    ./scripts/wispctl.sh helpers"
  echo "  or:"
  echo "    sudo $SETUP_DIR/install-helpers.sh $PROJECT_ROOT $DEPLOY_USER"
  exit 1
else
  echo "=== Helpers step complete ==="
fi
