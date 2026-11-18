#!/usr/bin/env bash
# Setup step: Intel RAPL read access for CPU power in Host Overview. Run as root.
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

DEPLOY_USER="${1:-}"
if [[ -z "$DEPLOY_USER" ]]; then
  echo "Usage: $0 <username>"
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

echo "--- Intel RAPL (CPU power read access) ---"

RAPL_ENERGY="/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
RAPL_GROUP="wisp-power"
RAPL_RULES="/etc/udev/rules.d/99-wisp-rapl.rules"

if [[ ! -e "$RAPL_ENERGY" ]]; then
  echo "  not present (normal on VMs or non-Intel) — nothing to do"
  exit 0
fi

if ! getent group "$RAPL_GROUP" >/dev/null; then
  groupadd "$RAPL_GROUP"
  changed "group $RAPL_GROUP created"
fi
if ! id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx "$RAPL_GROUP"; then
  usermod -aG "$RAPL_GROUP" "$DEPLOY_USER"
  changed "$DEPLOY_USER added to $RAPL_GROUP (wisp.service picks it up at its next start)"
fi

# MODE/GROUP do not apply to sysfs files; RUN chgrp/chmods the file.
RULE="$(staged_file)"
cat > "$RULE" <<RAPL_EOF
# Allow group $RAPL_GROUP to read Intel RAPL energy_uj (CPU power for Wisp Host Overview)
# MODE/GROUP do not apply to sysfs files; use RUN to chgrp/chmod the file
SUBSYSTEM=="powercap", KERNEL=="intel-rapl:0", \\
  RUN+="/usr/bin/chgrp $RAPL_GROUP /sys/%p/energy_uj", \\
  RUN+="/usr/bin/chmod g+r /sys/%p/energy_uj"
RAPL_EOF
if write_if_changed "$RAPL_RULES" 0644 "$RULE"; then
  udevadm control --reload-rules
  udevadm trigger --action=add --subsystem-match=powercap
  changed "$RAPL_RULES"
fi

if [[ "$(stat -c %G "$RAPL_ENERGY")" != "$RAPL_GROUP" ]] || (( ( 0$(stat -c %a "$RAPL_ENERGY") & 040 ) == 0 )); then
  chgrp "$RAPL_GROUP" "$RAPL_ENERGY"
  chmod g+r "$RAPL_ENERGY"
  changed "$RAPL_ENERGY readable by $RAPL_GROUP"
fi
step_done
