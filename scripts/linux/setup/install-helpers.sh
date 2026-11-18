#!/usr/bin/env bash
# Setup step: Wisp's privileged helpers in /usr/local/bin, each with the sudoers
# rule that lets the deploy user run it, and wisp-updater with its unit and its
# one sudoers rule. Run as root. Copies only what differs from the install tree;
# the packages the helpers run (dmidecode, smartmontools, cifs-utils, rsync)
# come from the packages step.
#
# Maintainer: when adding a new backend/scripts/wisp-* privileged helper, add it
# to HELPERS below, wire the backend to prefer /usr/local/bin (see existing
# patterns), and update docs/specs/DEPLOYMENT.md — "Privileged helpers checklist".
#
# Usage: install-helpers.sh <project-root> <deploy-user>
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
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

HELPERS=(wisp-os-update wisp-dmidecode wisp-smartctl wisp-mount wisp-power wisp-netns wisp-cni wisp-bridge wisp-nvram)

echo "--- Privileged helpers (/usr/local/bin) ---"

# install_sudoers <file> <line>: the rule written and checked by visudo only when
# it differs; a rule visudo rejects is removed again and fails the step.
install_sudoers() {
  local file="$1" line="$2"
  if printf '%s\n' "$line" | write_if_changed "$file" 0440; then
    if ! visudo -cq -f "$file"; then
      rm -f "$file"
      echo "ERROR: $file is not valid sudoers syntax — removed." >&2
      exit 1
    fi
    changed "$file"
  fi
}

# Written by atomic rename (write_if_changed): wisp-updater runs this step
# mid-update, and the running updater must keep its inode to finish.
for name in "${HELPERS[@]}"; do
  src="$PROJECT_ROOT/backend/scripts/$name"
  dest="/usr/local/bin/$name"
  if [[ ! -f "$src" ]]; then
    echo "ERROR: $src missing from the install tree." >&2
    exit 1
  fi
  if write_if_changed "$dest" 0755 < "$src"; then changed "$dest"; fi
  install_sudoers "/etc/sudoers.d/${name//[^a-z0-9-]/}" "$DEPLOY_USER ALL=(root) NOPASSWD: $dest"
done

# Helpers an earlier release installed under other names.
for obsolete in wisp-smb wisp-update; do
  if [[ -f "/usr/local/bin/$obsolete" ]]; then
    rm -f "/usr/local/bin/$obsolete"
    changed "removed obsolete /usr/local/bin/$obsolete"
  fi
  if [[ -f "/etc/sudoers.d/$obsolete" ]]; then
    rm -f "/etc/sudoers.d/$obsolete"
    changed "removed obsolete /etc/sudoers.d/$obsolete"
  fi
done

echo "--- wisp-updater (self-update applier, run as wisp-updater.service) ---"

if write_if_changed /usr/local/bin/wisp-updater 0755 < "$PROJECT_ROOT/backend/scripts/wisp-updater"; then
  changed /usr/local/bin/wisp-updater
fi

# WISP_PATH → the install dir, which the updater reads as $WISP_INSTALL_DIR.
if sed -e "s|WISP_PATH|$PROJECT_ROOT|g" "$PROJECT_ROOT/systemd/linux/wisp-updater.service" \
  | write_if_changed /etc/systemd/system/wisp-updater.service 0644; then
  systemctl daemon-reload
  changed /etc/systemd/system/wisp-updater.service
fi

# The deploy user may trigger the unit, and only that: argv must match the
# backend's invocation exactly (sudo -n /usr/bin/systemctl start --no-block wisp-updater.service).
install_sudoers /etc/sudoers.d/wisp-updater \
  "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service"

step_done
