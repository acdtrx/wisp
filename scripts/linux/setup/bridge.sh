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
# shellcheck source=bridge-journal.sh
source "$SETUP_DIR/bridge-journal.sh"

echo "--- Bridge ---"

if [[ "$BRIDGE_CREATE" == no ]]; then
  echo "  $BRIDGE carries the uplink"
  step_done
  exit 0
fi

# What the plan staged from must be as it was then; otherwise the step stops
# before any change.
current_sources="$(plan_sources)" || fail "cannot read what the plan was made from"
[[ "$current_sources" == "$(cat "$NET_PLAN_DIR/sources")" ]] \
  || fail "the network's configuration changed since setup worked out the bridge; the bridge step changed nothing. Run setup again."

# applied: within NET_APPLY_SEC the bridge holds what the uplink held (see
# the header) and the uplink holds nothing; there is no one event to wait on.
# Sets WHY to what differs.
# On DHCP the default route is compared by its gateway: its metric and source
# are the lease's and the tool's, and an uplink may carry the same route twice
# (once from the initramfs).
facts_of() {
  if [[ "$UPLINK_MODE" == static ]]; then
    grep -E '^(addr[46]|route[46]|dns|domain) ' || true
  else
    grep -E '^(addr4|route4 default|dns) ' | sed -E 's/^(route4 default via [^ ]+).*/\1/' | sort -u || true
  fi
}
# read_now: what the bridge and the uplink hold now, into NET_PLAN_DIR/now.*.
# Run in the background and waited for, so a stop interrupts the check at once.
# A read that fails leaves its part empty.
read_now() {
  rm -f "$NET_PLAN_DIR"/now.*
  cat "/sys/class/net/$BRIDGE/address" > "$NET_PLAN_DIR/now.mac" 2>/dev/null || true
  { l3_state "$BRIDGE" "$NET_TOOL" 2>/dev/null | facts_of; } > "$NET_PLAN_DIR/now.have" || true
  { l3_state "$UPLINK" "$NET_TOOL" 2>/dev/null | grep -E '^(addr[46]|route[46]) '; } > "$NET_PLAN_DIR/now.port" || true
  if [[ "$UPLINK_MODE" == dhcp ]]; then client_id "$BRIDGE" "$NET_TOOL"; fi > "$NET_PLAN_DIR/now.cid" || true
}
applied() {
  local deadline=$(( SECONDS + NET_APPLY_SEC )) mac cid want have port
  want="$(facts_of < "$NET_PLAN_DIR/uplink.state")"
  while :; do
    read_now &
    wait "$!" || true
    mac="$(cat "$NET_PLAN_DIR/now.mac" 2>/dev/null || true)"
    have="$(cat "$NET_PLAN_DIR/now.have" 2>/dev/null || true)"
    port="$(cat "$NET_PLAN_DIR/now.port" 2>/dev/null || true)"
    cid="$(cat "$NET_PLAN_DIR/now.cid" 2>/dev/null || true)"
    if [[ "$mac" == "$UPLINK_MAC" && "$have" == "$want" && -z "$port" && "$cid" == "${UPLINK_CLIENT_ID:-}" ]]; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      WHY="after ${NET_APPLY_SEC} s"
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
  install_file "$1" "$2" "$3" || { WHY="cannot write $1"; return 1; }
  changed "$1"
}

# undo: from the journal; the step fails either way.
undo() {
  trap '' TERM INT
  echo "  not applied: ${WHY:-stopped}; undoing it" >&2
  journal_undo_mark || true
  if journal_restore; then
    fail "$BRIDGE was not applied (${WHY:-the step was stopped}). The network is as it was, and $UPLINK holds $(first_ipv4 "$UPLINK") again"
  fi
  fail "$BRIDGE was not applied (${WHY:-the step was stopped}). Undoing it did not complete: the journal stays in $JOURNAL_DIR, and the next run of setup decides from it first"
}

WHY=""
journal_begin "$NET_TOOL" "$UPLINK" "$BRIDGE" "$UPLINK_ADDR" "${UPLINK_CONNECTION:--}" || fail "cannot start the journal in $JOURNAL_DIR"
trap 'WHY="the step was stopped"; undo' TERM INT
if "apply_$NET_TOOL" && applied && "check_$NET_TOOL"; then
  # From the check that passed to the commit, a stop waits.
  trap '' TERM INT
  if ! "finish_$NET_TOOL"; then
    undo
  fi
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
