#!/usr/bin/env bash
# Ensure /etc/netplan/90-wisp-bridge.yaml declares the link-local stub IP
# 169.254.53.53/32 on br0. The stub IP is the bind address for Wisp's
# in-process DNS forwarder (backend/src/lib/mdns/linux/forwarder.js) and must
# survive 'netplan apply' calls (e.g. wisp-bridge invoking netplan apply when
# adding/removing managed VLAN bridges).
#
# Idempotent. Safe to re-run on every install and update. No-op when:
#   - netplan is not in use (NetworkManager / systemd-networkd installs are
#     unaffected by the wisp-bridge bug because they don't run 'netplan apply')
#   - 90-wisp-bridge.yaml does not exist (bridge.sh has not run yet)
#   - the stub IP is already declared in br0's addresses
#
# Runs 'netplan apply' only when it actually changes the YAML.
#
# Must run as root.
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: bridge-config.sh must be run as root."
  exit 1
fi

if ! command -v netplan >/dev/null 2>&1; then
  echo "  netplan not present — skipping (NM/networkd installs are unaffected)."
  exit 0
fi

YAML="/etc/netplan/90-wisp-bridge.yaml"
if [[ ! -f "$YAML" ]]; then
  echo "  $YAML not present — skipping (bridge.sh has not run yet)."
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "  python3 not available — cannot safely patch YAML. Skipping."
  exit 0
fi

# Patch the YAML in-place via Python. Result file holds 'yes' (changed),
# 'no' (already correct), or is empty on a structural problem.
RESULT_FILE="$(mktemp)"
trap 'rm -f "$RESULT_FILE"' EXIT

python3 "$(dirname "$0")/bridge-config-patch.py" "$YAML" "$RESULT_FILE"
PY_RC=$?

if [[ "$PY_RC" -ne 0 ]]; then
  echo "  YAML patch failed (exit $PY_RC) — skipping netplan apply. Inspect $YAML manually."
  exit 0
fi

RESULT="$(cat "$RESULT_FILE")"

if [[ "$RESULT" == "yes" ]]; then
  echo "  Added 169.254.53.53/32 to bridges.br0.addresses in $YAML"
  if ! netplan apply; then
    echo "  WARNING: netplan apply failed after patching $YAML."
    exit 0
  fi
  echo "  netplan apply succeeded."
else
  echo "  $YAML already declares 169.254.53.53/32 on br0 — no change."
fi

exit 0
