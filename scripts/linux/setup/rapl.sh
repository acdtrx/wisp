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
step_begin

echo "--- Intel RAPL (CPU power read access) ---"

RAPL_ENERGY="/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"
RAPL_GROUP="wisp-power"
RAPL_RULES="/etc/udev/rules.d/99-wisp-rapl.rules"

if [[ ! -e "$RAPL_ENERGY" ]]; then
  echo "  not present (normal on VMs or non-Intel)"
  step_done
  exit 0
fi

if ! getent group "$RAPL_GROUP" >/dev/null; then
  groupadd "$RAPL_GROUP"
  changed "group $RAPL_GROUP created"
fi
if ! in_group "$DEPLOY_USER" "$RAPL_GROUP"; then
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
rule_new=0
if write_if_changed "$RAPL_RULES" 0644 "$RULE"; then
  rule_new=1
  changed "$RAPL_RULES"
fi

# The outcome, the file's group and its group read bit, is what is checked:
# udev applies the rule whenever it is new or the outcome is not there, so a
# rule written by a run whose udevadm call failed is applied by the next.
rapl_readable() {
  [[ "$(stat -c %G "$RAPL_ENERGY")" == "$RAPL_GROUP" ]] && (( ( 0$(stat -c %a "$RAPL_ENERGY") & 040 ) != 0 ))
}
was_readable=1
rapl_readable || was_readable=0
if (( rule_new || ! was_readable )); then
  timeout -k "$NET_KILL_SEC" "$UDEV_CALL_SEC" udevadm control --reload-rules || fail "udevadm cannot reload its rules"
  rc=0
  timeout -k "$NET_KILL_SEC" "$UDEV_CALL_SEC" udevadm trigger --settle --action=add --subsystem-match=powercap || rc=$?
  (( rc != 124 && rc != 137 )) || fail "udev did not finish handling the powercap devices' events within ${UDEV_CALL_SEC} s"
  (( rc == 0 )) || fail "udevadm cannot trigger the powercap devices"
  rapl_readable || fail "udev reloaded its rules and applied them to the powercap devices, but $RAPL_ENERGY is not readable by group $RAPL_GROUP (group $(stat -c %G "$RAPL_ENERGY"), mode $(stat -c %a "$RAPL_ENERGY")): see $RAPL_RULES"
  (( was_readable )) || changed "$RAPL_ENERGY readable by $RAPL_GROUP"
fi
step_done
