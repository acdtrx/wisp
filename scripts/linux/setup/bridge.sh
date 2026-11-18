#!/usr/bin/env bash
# Setup step, the last: the bridge Wisp's VMs and containers join. When the
# uplink already is a bridge there is nothing to do; otherwise `br0`, worked out
# and checked by network-plan.sh before setup changed anything, goes live
# through the tool that runs the uplink — netplan, systemd-networkd or
# NetworkManager — in as few steps as the tool allows, and is applied through
# it. Run as root.
#
# The bridge keeps the host's address: it takes the uplink's hardware address
# and its whole layer 3, static or DHCP, with its DHCP identity, so the DHCP
# server hands it the same lease; link-level settings stay with the uplink,
# which becomes its port with no addressing of its own. After the apply,
# within the wait, the bridge must hold the uplink's former hardware address,
# IPv4 addresses and default route — and on DHCP its client identifier and
# name servers, on a static address all its routes, name servers and search
# domains — and the uplink none of it. Otherwise, or when the step is stopped,
# the files it changed come back from the copies it saved first
# (bridge-undo.sh), the host's configuration is applied again, and the step
# fails saying so. The operator's original files are kept after a success.
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
# shellcheck source=net-state.sh
source "$SETUP_DIR/net-state.sh"
# shellcheck source=bridge-undo.sh
source "$SETUP_DIR/bridge-undo.sh"

echo "--- Bridge ---"

if [[ "$BRIDGE_CREATE" == no ]]; then
  echo "  $BRIDGE carries the uplink"
  step_done
  exit 0
fi

APPLY_WAIT_SEC=90   # the apply, and the bridge holding the uplink's address

NETPLAN_DROPIN=/etc/systemd/network/10-netplan-${BRIDGE}.network.d/50-wisp-dhcp-identity.conf
NETWORKD_NETDEV=/etc/systemd/network/00-wisp-${BRIDGE}.netdev
NETWORKD_NETWORK=/etc/systemd/network/00-wisp-${BRIDGE}.network
NM_PORT="${BRIDGE}-port-${UPLINK}"

# install_file <dest> <src> <mode>: <src> in place as <dest> by one rename.
install_file() {
  local tmp="$1.wisp-new"
  { cp "$2" "$tmp" && chmod "$3" "$tmp" && chown root:root "$tmp" && mv -f "$tmp" "$1"; } || { rm -f "$tmp"; return 1; }
}

# applied: within APPLY_WAIT_SEC the bridge holds what the uplink held (see
# the header) and the uplink holds nothing; there is no one event to wait on.
# Sets WHY to what differs.
applied() {
  local waited=0 mac cid want have port facts
  facts='^(addr4|route4 default|dns) '
  [[ "$UPLINK_MODE" == static ]] && facts='^(addr[46]|route[46]|dns|domain) '
  want="$(grep -E "$facts" "$NET_PLAN_DIR/uplink.state" || true)"
  while :; do
    mac="$(cat "/sys/class/net/$BRIDGE/address" 2>/dev/null || true)"
    have="$(l3_state "$BRIDGE" "$NET_TOOL" 2>/dev/null | grep -E "$facts" || true)"
    port="$(l3_state "$UPLINK" "$NET_TOOL" 2>/dev/null | grep -E '^(addr[46]|route[46]) ' || true)"
    cid=""
    [[ "$UPLINK_MODE" == dhcp ]] && cid="$(client_id "$BRIDGE" "$NET_TOOL")"
    if [[ "$mac" == "$UPLINK_MAC" && "$have" == "$want" && -z "$port" && "$cid" == "${UPLINK_CLIENT_ID:-}" ]]; then
      return 0
    fi
    if (( waited++ >= APPLY_WAIT_SEC )); then
      WHY="after ${APPLY_WAIT_SEC} s"
      [[ "$mac" == "$UPLINK_MAC" ]] || WHY+=", $BRIDGE has hardware address '${mac}' (was $UPLINK_MAC)"
      [[ "$cid" == "${UPLINK_CLIENT_ID:-}" ]] || WHY+=", $BRIDGE sends client identifier '${cid}' (was $UPLINK_CLIENT_ID)"
      [[ "$have" == "$want" ]] || WHY+=", $BRIDGE holds [$(echo $have)], $UPLINK held [$(echo $want)]"
      [[ -z "$port" ]] || WHY+=", $UPLINK still holds [$(echo $port)]"
      return 1
    fi
    sleep 1
  done
}

apply_notice() {
  echo "  applying: $BRIDGE on $UPLINK (was $UPLINK_ADDR); an ssh session may pause"
}

# --- netplan: the operator's file as the plan edited and checked it in its
# stage, put in place by one rename; for a DUID identity, before it, networkd's
# drop-in on netplan's unit for the bridge (netplan has no IAID key). Applied
# with `netplan apply`. ---
apply_netplan() {
  undo_save "$NETPLAN_ORIGIN" && undo_save "$NETPLAN_DROPIN" || { WHY="cannot save the files it changes"; return 1; }
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" ]]; then
    mkdir -p "$(dirname "$NETPLAN_DROPIN")"
    install_file "$NETPLAN_DROPIN" "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" 0644 || { WHY="cannot write $NETPLAN_DROPIN"; return 1; }
    changed "$NETPLAN_DROPIN"
  fi
  install_file "$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" 0600 || { WHY="cannot write $NETPLAN_ORIGIN"; return 1; }
  changed "$NETPLAN_ORIGIN: ${UPLINK}'s layer 3 moved to $BRIDGE (as checked by netplan in the plan)"
  apply_notice
  timeout "$APPLY_WAIT_SEC" netplan apply
}
verify_netplan() { :; }

# --- systemd-networkd: the bridge's .netdev and .network, and the port file,
# each by a rename, all sorting before the uplink's own file; applied with
# `networkctl reload`. ---
apply_networkd() {
  undo_save "$NETWORKD_NETDEV" && undo_save "$NETWORKD_NETWORK" && undo_save "$NETWORKD_PORT_FILE" \
    || { WHY="cannot save the files it changes"; return 1; }
  local f
  for f in "$NETWORKD_NETDEV:bridge.netdev" "$NETWORKD_NETWORK:bridge.network" "$NETWORKD_PORT_FILE:port.network"; do
    install_file "${f%%:*}" "$NET_PLAN_DIR/${f#*:}" 0644 || { WHY="cannot write ${f%%:*}"; return 1; }
    changed "${f%%:*}"
  done
  apply_notice
  timeout "$NET_CMD_SEC" networkctl reload
}
# Which file networkd now runs each link from: the bridge's and the port's.
verify_networkd() {
  local link want got
  for link in "$BRIDGE" "$UPLINK"; do
    want="$NETWORKD_NETWORK"
    [[ "$link" == "$UPLINK" ]] && want="$NETWORKD_PORT_FILE"
    got="$(json_string "$(timeout "$NET_CMD_SEC" networkctl status "$link" --json=short 2>/dev/null)" NetworkFile || true)"
    if [[ "$got" != "$want" ]]; then
      WHY="systemd-networkd runs $link from '${got}', not $want"
      return 1
    fi
  done
}

# --- NetworkManager: the bridge and port connections, checked by nmcli in the
# plan, added not connecting by themselves and brought up; only once the
# bridge holds the address do they connect by themselves and the uplink's own
# connection stop doing so — so there is no moment without a connection that
# comes up by itself. ---
nm_add() { local args; mapfile -t args < "$1"; timeout "$NET_CMD_SEC" nmcli connection add "${args[@]}" >/dev/null; }
apply_networkmanager() {
  undo_save "$NM_PROFILE_FILE" || { WHY="cannot save $NM_PROFILE_FILE"; return 1; }
  undo_connection "$BRIDGE" && undo_connection "$NM_PORT" || { WHY="cannot note the connections it adds"; return 1; }
  nm_add "$NET_PLAN_DIR/bridge.args" || { WHY="NetworkManager refused the bridge connection"; return 1; }
  changed "NetworkManager connection $BRIDGE (bridge, ${UPLINK}'s layer 3 and DHCP identity)"
  nm_add "$NET_PLAN_DIR/port.args" || { WHY="NetworkManager refused the port connection"; return 1; }
  changed "NetworkManager connection $NM_PORT ($UPLINK as ${BRIDGE}'s port, with its link settings)"
  apply_notice
  timeout "$APPLY_WAIT_SEC" nmcli --wait "$APPLY_WAIT_SEC" connection up "$BRIDGE" >/dev/null
}
verify_networkmanager() {
  timeout "$NET_CMD_SEC" nmcli connection modify "$BRIDGE" connection.autoconnect yes \
    && timeout "$NET_CMD_SEC" nmcli connection modify "$NM_PORT" connection.autoconnect yes \
    && timeout "$NET_CMD_SEC" nmcli connection modify "$UPLINK_CONNECTION" connection.autoconnect no \
    || { WHY="NetworkManager refused to make $BRIDGE connect by itself"; return 1; }
  changed "NetworkManager: $BRIDGE and its port connect by themselves, ${UPLINK}'s own connection no longer does"
}

# undo: from the saved copies; the step fails either way.
undo() {
  trap '' TERM INT
  echo "  not applied: ${WHY:-stopped}; restoring the network's files" >&2
  if undo_restore && [[ "$(first_ipv4 "$UPLINK")" == "$UPLINK_ADDR" ]]; then
    fail "$BRIDGE was not applied (${WHY:-the step was stopped}). The network's files are as they were, and $UPLINK holds $UPLINK_ADDR again"
  fi
  fail "$BRIDGE was not applied (${WHY:-the step was stopped}). Restoring the network did not complete: the saved copies stay in $UNDO_DIR, and the next run of setup restores from them first"
}

WHY=""
undo_begin "$NET_TOOL" "$UPLINK" "$BRIDGE" "${UPLINK_CONNECTION:-}" || fail "cannot keep copies in $UNDO_DIR"
trap 'WHY="the step was stopped"; undo' TERM INT
if "apply_$NET_TOOL" && applied && "verify_$NET_TOOL"; then
  trap - TERM INT
  undo_done
  changed "$BRIDGE created on $UPLINK"
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    echo "  $BRIDGE holds $UPLINK_ADDR, its default route and name servers, hardware address $UPLINK_MAC, client identifier $UPLINK_CLIENT_ID; $UPLINK holds no address"
  else
    echo "  $BRIDGE holds ${UPLINK}'s static addresses, routes and name servers, hardware address $UPLINK_MAC; $UPLINK holds none"
  fi
  echo "  The original network files are kept in $KEPT_DIR."
  step_done
  exit 0
fi
WHY="${WHY:-the $NET_TOOL apply failed}"
undo
