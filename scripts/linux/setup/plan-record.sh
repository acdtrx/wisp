# Sourced by network-plan.sh; do not execute it. The plan's record: what the
# plan found, kept in NET_PLAN_DIR/plan.env, which a step sourcing
# network-plan.sh reads instead of working it out again.
PLAN_RECORD_VARS=(NET_TOOL UPLINK UPLINK_ADDR BRIDGE BRIDGE_CREATE UPLINK_MAC UPLINK_MODE UPLINK_CLIENT_ID
  UPLINK_MTU UPLINK_NETPLAN_ID NETPLAN_ORIGIN NETWORKD_PORT_FILE UPLINK_CONNECTION NM_PROFILE_FILE
  NM_BRIDGE_UUID NM_PORT_UUID NM_BRIDGE_FILE NM_PORT_FILE NET_PLAN_JOURNAL)

# plan_record_write <file>
plan_record_write() {
  local v
  for v in "${PLAN_RECORD_VARS[@]}"; do
    [[ -z "${!v:-}" ]] || printf '%s=%q\n' "$v" "${!v}"
  done > "$1"
}
