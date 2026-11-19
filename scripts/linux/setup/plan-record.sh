# Sourced by setup, its network steps and the installer; do not execute it.
# The network plan's record: what network-plan.sh found, one `KEY<TAB>value`
# line each, in the plan's directory (NET_PLAN_DIR/plan). The bridge step
# applies from it, and copies it into its journal before its first change, as
# the reference its check compares against. Data: read, never sourced.
#
#   NET_TOOL          netplan | networkd | networkmanager
#   UPLINK            the default route's interface
#   UPLINK_ADDR       its IPv4 address with prefix
#   BRIDGE            the bridge Wisp uses
#   BRIDGE_CREATE     yes when the bridge step must create BRIDGE on UPLINK
# and, when it must:
#   UPLINK_MAC        the uplink's hardware address, which the bridge takes
#   UPLINK_MTU        the uplink's MTU, which the bridge's definition sets
#   UPLINK_MODE       dhcp (DHCPv4, with or without static addresses) | static
#   UPLINK_CLIENT_ID  on DHCP, its DHCPv4 client identifier (hex bytes,
#                     colon-separated), which the bridge sends too
#   UPLINK_NETPLAN_ID     netplan: the uplink's definition id
#   NETPLAN_ORIGIN        netplan: the file that defines it
#   NETWORKD_PORT_FILE    networkd: the uplink's own file under /etc (in place,
#                         or overriding a vendor file), which becomes the port's
#   UPLINK_CONNECTION     networkmanager: the uplink's connection (UUID), which
#                         the bridge step deletes last
#   NM_PROFILE_FILE       networkmanager: the file that stores it, when it is
#                         stored (kept as the original)
#   NM_BRIDGE_UUID, NM_PORT_UUID, NM_BRIDGE_FILE, NM_PORT_FILE
#                         networkmanager: the connections to add, and their keyfiles
#   NET_PLAN_JOURNAL  network-plan.sh --ask: what an earlier bridge step's
#                     journal was found to be (bridge-journal.sh)
# Beside it in the plan's directory, when the bridge is to be made: uplink.state
# (what the uplink holds, net-state.sh), sources (what the plan read), and the
# tool's files for the bridge (net-<tool>.sh).
PLAN_RECORD_VARS=(NET_TOOL UPLINK UPLINK_ADDR BRIDGE BRIDGE_CREATE UPLINK_MAC UPLINK_MTU UPLINK_MODE
  UPLINK_CLIENT_ID UPLINK_NETPLAN_ID NETPLAN_ORIGIN NETWORKD_PORT_FILE UPLINK_CONNECTION NM_PROFILE_FILE
  NM_BRIDGE_UUID NM_PORT_UUID NM_BRIDGE_FILE NM_PORT_FILE NET_PLAN_JOURNAL)

# plan_record_write <file>: the record of the variables set now, synced.
plan_record_write() {
  local v
  for v in "${PLAN_RECORD_VARS[@]}"; do
    [[ -n "${!v:-}" ]] || continue
    [[ "${!v}" != *[$'\t\n']* ]] || { echo "ERROR: $v holds a tab or a line break: '${!v}'" >&2; return 1; }
    printf '%s\t%s\n' "$v" "${!v}" || return 1
  done > "$1" && sync "$1"
}

# plan_record_read <file>: the record's variables set (and every other one of
# them unset). Fails, naming the line, on a key it does not know.
plan_record_read() {
  local key value v n=0
  for v in "${PLAN_RECORD_VARS[@]}"; do unset "$v"; done
  [[ -s "$1" ]] || { echo "ERROR: no network plan in $1" >&2; return 1; }
  while IFS=$'\t' read -r key value; do
    n=$((n + 1))
    case " ${PLAN_RECORD_VARS[*]} " in
      *" $key "*) printf -v "$key" '%s' "$value" ;;
      *) echo "ERROR: $1, line $n: not a network plan" >&2; return 1 ;;
    esac
  done < "$1"
  [[ -n "${NET_TOOL:-}" && -n "${UPLINK:-}" && -n "${BRIDGE:-}" && -n "${BRIDGE_CREATE:-}" ]] \
    || { echo "ERROR: $1 is not a complete network plan" >&2; return 1; }
}

# plan_confirmation: what the installer asks the operator to confirm, from the
# record read: "<bridge> on <uplink> (<address>), through <tool>", or "none"
# when no bridge is to be made. Setup's plan must say the same, or it changes
# nothing more.
plan_confirmation() {
  if [[ "$BRIDGE_CREATE" == yes ]]; then
    printf '%s on %s (%s), through %s' "$BRIDGE" "$UPLINK" "$UPLINK_ADDR" "$NET_TOOL"
  else
    printf none
  fi
}
