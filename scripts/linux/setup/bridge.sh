#!/usr/bin/env bash
# Setup step, the last: the bridge Wisp's VMs and containers join. When the
# uplink already is a bridge there is nothing to do; otherwise `br0`, worked out
# and checked by network-plan.sh before setup changed anything, is written
# through the tool that runs the uplink — netplan, systemd-networkd or
# NetworkManager — and applied through it. Run as root.
#
# The bridge keeps the host's address: it takes the uplink's hardware address,
# its layer-3 settings and its DHCP identity, so the DHCP server hands it the
# same lease. The uplink becomes its port, and what ran it before no longer
# comes up by itself. After the apply the bridge must hold the uplink's former
# IPv4 address, hardware address and client identifier within the wait; if the
# apply fails or any of them differs, what the step wrote is removed and the
# host's configuration applied again, so the host is back as it was, and the
# step fails saying so. A later run starts clean.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
# shellcheck source=network-plan.sh
source "$SETUP_DIR/network-plan.sh"

echo "--- Bridge ---"

if [[ "$BRIDGE_CREATE" == no ]]; then
  echo "  $BRIDGE carries the uplink"
  step_done
  exit 0
fi

APPLY_WAIT_SEC=90   # the apply, and the bridge holding the uplink's address
CMD_SEC=30          # any other call of a network tool

NETPLAN_FILE=/etc/netplan/90-wisp-bridge.yaml
NETPLAN_DROPIN=/etc/systemd/network/10-netplan-${BRIDGE}.network.d/50-wisp-dhcp-identity.conf
NETWORKD_NETDEV=/etc/systemd/network/10-wisp-${BRIDGE}.netdev
NETWORKD_NETWORK=/etc/systemd/network/10-wisp-${BRIDGE}.network
NM_PORT="${BRIDGE}-port-${UPLINK}"

# The bridge's DHCPv4 client identifier, as hex bytes like the plan's.
client_id_now() {
  local json bytes b out=""
  case "$NET_TOOL" in
    networkmanager)
      timeout "$CMD_SEC" nmcli -t -f DHCP4.OPTION device show "$BRIDGE" 2>/dev/null \
        | sed -n 's/^DHCP4\.OPTION\[[0-9]*\]:dhcp_client_identifier = //p'
      ;;
    *)
      json="$(timeout "$CMD_SEC" networkctl status "$BRIDGE" --json=short 2>/dev/null)" || return 0
      [[ "$json" =~ \"ClientIdentifier\":\[([^]]*)\] ]] || return 0
      bytes="${BASH_REMATCH[1]}"
      for b in ${bytes//,/ }; do out+="$(printf '%02x:' "$b")"; done
      printf '%s' "${out%:}"
      ;;
  esac
}

# applied: the bridge holds the uplink's address, hardware address and client
# identifier; waits for them up to APPLY_WAIT_SEC (no one event says all
# three). Sets WHY to what differs.
applied() {
  local waited=0 addr mac cid
  while :; do
    addr="$(ip -4 -o addr show dev "$BRIDGE" scope global 2>/dev/null | awk '!done { print $4; done = 1 }')"
    mac="$(cat "/sys/class/net/$BRIDGE/address" 2>/dev/null || true)"
    cid="$(client_id_now)"
    [[ "$addr" == "$UPLINK_ADDR" && "$mac" == "$UPLINK_MAC" && "$cid" == "$UPLINK_CLIENT_ID" ]] && return 0
    if (( waited++ >= APPLY_WAIT_SEC )); then
      WHY="after ${APPLY_WAIT_SEC} s $BRIDGE has address '${addr}' (was $UPLINK_ADDR), hardware address '${mac}' (was $UPLINK_MAC), client identifier '${cid}' (was $UPLINK_CLIENT_ID)"
      return 1
    fi
    sleep 1
  done
}

# uplink_back: after a rollback, the uplink holds its address again.
uplink_back() {
  local waited=0
  until [[ "$(ip -4 -o addr show dev "$UPLINK" scope global 2>/dev/null | awk '!done { print $4; done = 1 }')" == "$UPLINK_ADDR" ]]; do
    (( waited++ < APPLY_WAIT_SEC )) || return 1
    sleep 1
  done
}

apply_notice() {
  echo "  applying: $BRIDGE on $UPLINK (was $UPLINK_ADDR); an ssh session may pause"
}

# --- netplan: Wisp's file (and for a DUID identity networkd's drop-in on
# netplan's unit for the bridge), applied with `netplan apply` ---
apply_netplan() {
  local dropin_src="$NET_PLAN_DIR/50-wisp-dhcp-identity.conf"
  if [[ -s "$dropin_src" ]]; then
    mkdir -p "$(dirname "$NETPLAN_DROPIN")"
    if write_if_changed "$NETPLAN_DROPIN" 0644 "$dropin_src"; then changed "$NETPLAN_DROPIN"; fi
  fi
  if write_if_changed "$NETPLAN_FILE" 0600 "$NET_PLAN_DIR/90-wisp-bridge.yaml"; then changed "$NETPLAN_FILE"; fi
  apply_notice
  timeout "$APPLY_WAIT_SEC" netplan apply
}
verify_netplan() { :; }
rollback_netplan() {
  rm -f "$NETPLAN_FILE" "$NETPLAN_DROPIN"
  rmdir "$(dirname "$NETPLAN_DROPIN")" 2>/dev/null || true
  [[ ! -e "/sys/class/net/$BRIDGE" ]] || ip link delete "$BRIDGE" || true
  timeout "$APPLY_WAIT_SEC" netplan apply || true
}

# --- systemd-networkd: the bridge's .netdev and .network, and the port file,
# applied with `networkctl reload` ---
apply_networkd() {
  if write_if_changed "$NETWORKD_NETDEV" 0644 "$NET_PLAN_DIR/bridge.netdev"; then changed "$NETWORKD_NETDEV"; fi
  if write_if_changed "$NETWORKD_NETWORK" 0644 "$NET_PLAN_DIR/bridge.network"; then changed "$NETWORKD_NETWORK"; fi
  if write_if_changed "$NETWORKD_PORT_FILE" 0644 "$NET_PLAN_DIR/port.network"; then changed "$NETWORKD_PORT_FILE"; fi
  apply_notice
  timeout "$CMD_SEC" networkctl reload
}
# Which file networkd runs each link from: the bridge's and the port's.
verify_networkd() {
  local link want got status
  for link in "$BRIDGE" "$UPLINK"; do
    want="$NETWORKD_NETWORK"
    [[ "$link" == "$UPLINK" ]] && want="$NETWORKD_PORT_FILE"
    status="$(timeout "$CMD_SEC" networkctl status "$link" --no-pager 2>/dev/null || true)"
    got="$(awk '$1 == "Network" && $2 == "File:" && !done { print $3; done = 1 }' <<<"$status")"
    if [[ "$got" != "$want" ]]; then
      WHY="systemd-networkd runs $link from '${got}', not $want"
      return 1
    fi
  done
}
rollback_networkd() {
  rm -f "$NETWORKD_NETDEV" "$NETWORKD_NETWORK" "$NETWORKD_PORT_FILE"
  [[ ! -e "/sys/class/net/$BRIDGE" ]] || timeout "$CMD_SEC" networkctl delete "$BRIDGE" || true
  timeout "$CMD_SEC" networkctl reload || true
  timeout "$CMD_SEC" networkctl reconfigure "$UPLINK" || true
}

# --- NetworkManager: the bridge connection and the port connection, applied
# with `nmcli connection up` ---
# nmcli connection add, with the arguments of a plan file (one per line).
nm_add() { local args; mapfile -t args < "$1"; timeout "$CMD_SEC" nmcli connection add "${args[@]}" >/dev/null; }
apply_networkmanager() {
  # NetworkManager checks each connection as it is added; neither connects by
  # itself until both are there.
  nm_add "$NET_PLAN_DIR/bridge.args" || { WHY="NetworkManager refused the bridge connection"; return 1; }
  changed "NetworkManager connection $BRIDGE (bridge, ${UPLINK}'s layer 3 and DHCP identity)"
  nm_add "$NET_PLAN_DIR/port.args" || { WHY="NetworkManager refused the port connection"; return 1; }
  changed "NetworkManager connection $NM_PORT ($UPLINK as ${BRIDGE}'s port)"
  timeout "$CMD_SEC" nmcli connection modify "$UPLINK_CONNECTION" connection.autoconnect no || return 1
  timeout "$CMD_SEC" nmcli connection modify "$BRIDGE" connection.autoconnect yes || return 1
  timeout "$CMD_SEC" nmcli connection modify "$NM_PORT" connection.autoconnect yes || return 1
  changed "NetworkManager: $BRIDGE and its port connect by themselves, ${UPLINK}'s own connection no longer does"
  apply_notice
  timeout "$APPLY_WAIT_SEC" nmcli --wait "$APPLY_WAIT_SEC" connection up "$BRIDGE" >/dev/null
}
verify_networkmanager() { :; }
rollback_networkmanager() {
  local con
  for con in "$BRIDGE" "$NM_PORT"; do
    if timeout "$CMD_SEC" nmcli -t -f connection.id connection show "$con" >/dev/null 2>&1; then
      timeout "$CMD_SEC" nmcli connection delete "$con" >/dev/null || true
    fi
  done
  timeout "$CMD_SEC" nmcli connection modify "$UPLINK_CONNECTION" connection.autoconnect yes || true
  timeout "$APPLY_WAIT_SEC" nmcli --wait "$APPLY_WAIT_SEC" connection up "$UPLINK_CONNECTION" >/dev/null || true
}

WHY=""
if "apply_$NET_TOOL" && applied && "verify_$NET_TOOL"; then
  changed "$BRIDGE created on $UPLINK"
  echo "  $BRIDGE holds $UPLINK_ADDR, hardware address $UPLINK_MAC, client identifier $UPLINK_CLIENT_ID"
  step_done
  exit 0
fi

WHY="${WHY:-the $NET_TOOL apply failed}"
echo "  not applied: $WHY; rolling back" >&2
"rollback_$NET_TOOL"
if uplink_back; then
  fail "$BRIDGE was not applied ($WHY). What this step wrote is removed, and $UPLINK holds $UPLINK_ADDR again"
fi
fail "$BRIDGE was not applied ($WHY). What this step wrote is removed, but $UPLINK did not get $UPLINK_ADDR back within ${APPLY_WAIT_SEC} s"
