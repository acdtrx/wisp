#!/usr/bin/env bash
# Setup step, the last: the bridge Wisp's VMs and containers join. When the
# uplink already is a bridge there is nothing to do; otherwise `br0`, worked out
# and checked by network-plan.sh in this run, goes live through the tool that
# runs the uplink — netplan, systemd-networkd or NetworkManager — in as few
# steps as the tool allows, each one leaving a network that boots, old or new.
# Run as root.
#
# The bridge keeps the host's address: it takes the uplink's hardware address
# and its whole layer 3, static or DHCP, with its DHCP identity, so the DHCP
# server hands it the same lease; link settings stay with the uplink, which
# becomes its port with no addressing of its own. After the apply, within the
# wait, the bridge must hold the uplink's former hardware address, IPv4
# addresses and default route — and on DHCP its client identifier and name
# servers, on a static address all its routes, name servers and search domains
# — and the uplink none of it. Otherwise, or when the step is stopped, it undoes
# what it did from its journal (bridge-journal.sh) and fails saying so.
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
# shellcheck source=bridge-journal.sh
source "$SETUP_DIR/bridge-journal.sh"

echo "--- Bridge ---"

if [[ "$BRIDGE_CREATE" == no ]]; then
  echo "  $BRIDGE carries the uplink"
  step_done
  exit 0
fi

APPLY_WAIT_SEC=90   # the apply, and the bridge holding the uplink's address

NETPLAN_DROPIN_DIR=/etc/systemd/network/10-netplan-${BRIDGE}.network.d
NETPLAN_DROPIN=$NETPLAN_DROPIN_DIR/50-wisp-dhcp-identity.conf
NETWORKD_NETDEV=/etc/systemd/network/00-wisp-${BRIDGE}.netdev
NETWORKD_NETWORK=/etc/systemd/network/00-wisp-${BRIDGE}.network

# What the plan staged from must be as it was then; otherwise the step stops
# before any change.
current_sources="$(plan_sources)" || fail "cannot read what the plan was made from"
[[ "$current_sources" == "$(cat "$NET_PLAN_DIR/sources")" ]] \
  || fail "the network's configuration changed since setup worked out the bridge; nothing was changed. Run setup again."

# applied: within APPLY_WAIT_SEC the bridge holds what the uplink held (see
# the header) and the uplink holds nothing; there is no one event to wait on.
# Sets WHY to what differs.
# On DHCP the default route is compared by its gateway: its metric and source
# are the lease's and the tool's, and an uplink may carry the same route twice
# (once from the initramfs).
facts_of() {
  if [[ "$UPLINK_MODE" == static ]]; then
    grep -E '^(addr[46]|route[46]|dns|domain) ' || true
  else
    grep -E '^(addr4|route4 default|dns) ' | sed -E 's/^(route4 default via [^ ]+).*/\1/' | LC_ALL=C sort -u || true
  fi
}
applied() {
  local waited=0 mac cid want have port
  want="$(facts_of < "$NET_PLAN_DIR/uplink.state")"
  while :; do
    mac="$(cat "/sys/class/net/$BRIDGE/address" 2>/dev/null || true)"
    have="$(l3_state "$BRIDGE" "$NET_TOOL" 2>/dev/null | facts_of)"
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

# put_file <dest> <src> <mode>: journaled, then live; the journal entry is
# written first, and a failed one stops the step before the file changes.
put_file() {
  journal_file "$1" "$2" || { WHY="cannot write the journal for $1"; return 1; }
  net_install_file "$1" "$2" "$3" || { WHY="cannot write $1"; return 1; }
  changed "$1"
}

# --- netplan: for a DUID identity, networkd's drop-in on netplan's unit for the
# bridge (netplan has no IAID key) — harmless while no bridge exists; then the
# operator's file as the plan edited and checked it, in one rename: the
# switch. Applied with `netplan apply`. ---
apply_netplan() {
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" ]]; then
    journal_dir "$NETPLAN_DROPIN_DIR" || { WHY="cannot make $NETPLAN_DROPIN_DIR"; return 1; }
    put_file "$NETPLAN_DROPIN" "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" 0644 || return 1
  fi
  put_file "$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" 0600 || return 1
  apply_notice
  timeout -k 10 "$APPLY_WAIT_SEC" netplan apply
}
verify_netplan() { :; }

# --- systemd-networkd: the bridge's .netdev and .network first — a bridge with
# no port, harmless — then the port file, the switch; applied with
# `networkctl reload`. The uplink's own file is not changed: it is kept as the
# original. ---
apply_networkd() {
  local f
  mapfile -t NETWORKD_UPLINK_SOURCES < "$NET_PLAN_DIR/networkd-sources"
  for f in "${NETWORKD_UPLINK_SOURCES[@]}"; do
    journal_file "$f" "$f" || { WHY="cannot write the journal for $f"; return 1; }
  done
  put_file "$NETWORKD_NETDEV" "$NET_PLAN_DIR/bridge.netdev" 0644 || return 1
  put_file "$NETWORKD_NETWORK" "$NET_PLAN_DIR/bridge.network" 0644 || return 1
  put_file "$NETWORKD_PORT_FILE" "$NET_PLAN_DIR/port.network" 0644 || return 1
  apply_notice
  timeout -k 10 "$NET_CMD_SEC" networkctl reload
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
# plan, added under UUIDs of their own, both connecting by themselves, and the
# bridge brought up with its port. The uplink's own connection is not changed.
# The bridge first: on its own it holds nothing (no port, no carrier), and a
# boot then still brings the uplink up on its own connection — NetworkManager's
# default wired one too, which it makes only while no stored connection is
# for that device. From the port on, a boot brings up the port, whose
# autoconnect priority is above the uplink connection's, and so the bridge.
# Never a boot with neither. ---
nm_add() {
  local args
  mapfile -t args < "$1"
  journal_conn "$2" || { WHY="cannot write the journal"; return 1; }
  timeout -k 10 "$NET_CMD_SEC" nmcli connection add connection.uuid "$2" "${args[@]}" >/dev/null \
    || { WHY="NetworkManager refused the connection $2"; return 1; }
  journal_connfp "$2" "$(nm_fingerprint "$2")" || { WHY="cannot write the journal"; return 1; }
}
apply_networkmanager() {
  if [[ -n "${NM_PROFILE_FILE:-}" ]]; then
    journal_file "$NM_PROFILE_FILE" "$NM_PROFILE_FILE" || { WHY="cannot write the journal"; return 1; }
  fi
  nm_add "$NET_PLAN_DIR/bridge.args" "$NM_BRIDGE_UUID" || return 1
  changed "NetworkManager connection $BRIDGE (bridge, ${UPLINK}'s layer 3 and DHCP identity)"
  nm_add "$NET_PLAN_DIR/port.args" "$NM_PORT_UUID" || return 1
  changed "NetworkManager connection ${BRIDGE}-port-${UPLINK} ($UPLINK as ${BRIDGE}'s port, with its link settings, ahead of ${UPLINK}'s own connection at boot)"
  apply_notice
  timeout -k 10 "$APPLY_WAIT_SEC" nmcli --wait "$APPLY_WAIT_SEC" connection up "$NM_BRIDGE_UUID" >/dev/null
}
verify_networkmanager() { :; }

# undo: from the journal; the step fails either way.
undo() {
  trap '' TERM INT
  echo "  not applied: ${WHY:-stopped}; undoing it" >&2
  if journal_restore; then
    fail "$BRIDGE was not applied (${WHY:-the step was stopped}). The network is as it was, and $UPLINK holds $(first_ipv4 "$UPLINK") again"
  fi
  fail "$BRIDGE was not applied (${WHY:-the step was stopped}). Undoing it did not complete: the journal stays in $JOURNAL_DIR, and the next run of setup decides from it first"
}

WHY=""
journal_begin "$NET_TOOL" "$UPLINK" "$BRIDGE" "$UPLINK_ADDR" "${UPLINK_CONNECTION:--}" || fail "cannot start the journal in $JOURNAL_DIR"
trap 'WHY="the step was stopped"; undo' TERM INT
if "apply_$NET_TOOL" && applied && "verify_$NET_TOOL"; then
  # From the check that passed to the commit, a stop waits.
  trap '' TERM INT
  journal_commit || fail "$BRIDGE is up, but the journal could not be committed; the next run of setup commits it"
  changed "$BRIDGE created on $UPLINK"
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    echo "  $BRIDGE holds $UPLINK_ADDR, its default route and name servers, hardware address $UPLINK_MAC, client identifier $UPLINK_CLIENT_ID; $UPLINK holds no address"
  else
    echo "  $BRIDGE holds ${UPLINK}'s static addresses, routes and name servers, hardware address $UPLINK_MAC; $UPLINK holds none"
  fi
  step_done
  exit 0
fi
WHY="${WHY:-the $NET_TOOL apply failed}"
undo
