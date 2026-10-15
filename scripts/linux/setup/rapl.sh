#!/usr/bin/env bash
# Intel RAPL read access for CPU power in Host Overview (udev rule). Run as root.
#
# Always a udev rule, never a one-off setfacl/chmod on the file: sysfs attributes
# are recreated on every boot, so permissions set on them directly do not survive
# a reboot (and sysfs typically rejects POSIX ACLs outright). The rule re-applies
# the group read bit each time the powercap device appears.
# Usage: rapl.sh <username>
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

echo "--- Optional: Intel RAPL (CPU power read access) ---"

RAPL_ENERGY="/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
RAPL_GROUP="wisp-power"

if [[ ! -e "$RAPL_ENERGY" ]]; then
  echo "  Skipped (Intel RAPL not present — normal on VMs or non-Intel)"
  exit 0
fi

getent group "$RAPL_GROUP" &>/dev/null || groupadd "$RAPL_GROUP"
usermod -aG "$RAPL_GROUP" "$DEPLOY_USER"
echo "  Added $DEPLOY_USER to group $RAPL_GROUP"

RAPL_RULES="/etc/udev/rules.d/99-wisp-rapl.rules"
cat > "$RAPL_RULES" << RAPL_EOF
# Allow group $RAPL_GROUP to read Intel RAPL energy_uj (CPU power for Wisp Host Overview)
# MODE/GROUP do not apply to sysfs files; use RUN to chgrp/chmod the file
SUBSYSTEM=="powercap", KERNEL=="intel-rapl:0", \\
  RUN+="/usr/bin/chgrp $RAPL_GROUP /sys/%p/energy_uj", \\
  RUN+="/usr/bin/chmod g+r /sys/%p/energy_uj"
RAPL_EOF
echo "  Installed udev rule: $RAPL_RULES"
udevadm control --reload-rules
udevadm trigger --action=add --subsystem-match=powercap

if [[ -e "$RAPL_ENERGY" ]]; then
  chgrp "$RAPL_GROUP" "$RAPL_ENERGY" 2>/dev/null && chmod g+r "$RAPL_ENERGY" 2>/dev/null && echo "  Applied group to existing $RAPL_ENERGY" || echo "  Reboot or unload/reload powercap module for udev to apply (log out and back in for group)."
fi
echo "  CPU power shows in Host Overview once wisp.service restarts (it picks up the $RAPL_GROUP group at start)."
