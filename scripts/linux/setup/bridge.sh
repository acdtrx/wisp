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
# shellcheck source=bridge-journal.sh
source "$SETUP_DIR/bridge-journal.sh"
step_begin

echo "--- Bridge ---"
plan_record_read "$NET_PLAN_DIR/plan" || fail "no network plan in $NET_PLAN_DIR"

if [[ "$BRIDGE_CREATE" == no ]]; then
  echo "  $BRIDGE carries the uplink"
  step_done
  exit 0
fi

# What the plan read must be as it was then; otherwise the step stops before
# any change.
current_sources="$(plan_sources)" || fail "cannot read what the plan was made from"
planned_sources="$(cat "$NET_PLAN_DIR/sources")" || fail "no record of what the plan was made from in $NET_PLAN_DIR"
[[ "$current_sources" == "$planned_sources" ]] \
  || refuse NETWORK_CHANGED_SINCE_PLAN "the network's configuration changed since setup worked out the bridge; the bridge step changed nothing. Run setup again."

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

# undo: from the journal, inside a section that must finish; the step fails
# either way, saying what was checked.
undo() {
  step_hold
  echo "  not applied: ${WHY:-stopped}; undoing it" >&2
  journal_restore || fail "$BRIDGE was not applied (${WHY:-the step was stopped}). Undoing it did not complete: the journal stays in $JOURNAL_DIR, and the next run of setup decides from it first"
  fail "$BRIDGE was not applied (${WHY:-the step was stopped}). $RESTORE_OUTCOME"
}
undo_stopped() { WHY="the step was stopped"; undo; }

# stub_back: an apply can drop the container DNS stub's address for a while
# (netplan's, on Debian 13: about 6 s), and the backend's start follows the
# step: after the commit, the stub is waited for until it holds its address, up
# to NET_WAIT_SEC.
# Not part of the bridge or its check: the bridge stays whatever the stub
# does. Outside a section that must finish, so a stop ends the wait at once.
stub_back() {
  local deadline=$(( SECONDS + NET_WAIT_SEC )) addrs
  while :; do
    addrs="$(net_call ip -4 -o addr show dev "$DNS_STUB_IFACE" 2>/dev/null || true)"
    [[ "$addrs" != *" ${DNS_STUB_IP}/32 "* ]] || return 0
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

WHY=""
journal_begin "$NET_PLAN_DIR" || fail "cannot start the journal in $JOURNAL_DIR"
# From the first change a stop undoes; the apply call in flight runs to its
# end first.
STEP_ON_STOP=undo_stopped
step_hold
applied=0
"apply_$NET_TOOL" && applied=1
step_release
if (( applied )) && bridge_check "$NET_PLAN_DIR"; then
  # From the check that passed to the commit, a stop waits.
  step_hold
  if ! "finish_$NET_TOOL"; then
    undo
  fi
  journal_commit || fail "$BRIDGE is up, but the journal could not be committed; the next run of setup decides from it first"
  STEP_ON_STOP=""
  changed "$BRIDGE created on $UPLINK"
  # What the check compared: name servers and search domains only where the
  # tool holds them (net-state.sh, l3_state).
  held="$(facts_of < "$NET_PLAN_DIR/uplink.state" | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
  extra=""
  [[ " $held" != *" dns "* ]] || extra+=", name servers"
  [[ " $held" != *" domain "* ]] || extra+=", search domains"
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    echo "  $BRIDGE holds $UPLINK_ADDR, its default route${extra}, hardware address $UPLINK_MAC, client identifier $UPLINK_CLIENT_ID; $UPLINK holds no address"
  else
    echo "  $BRIDGE holds ${UPLINK}'s static addresses, routes${extra}, hardware address $UPLINK_MAC; $UPLINK holds none"
  fi
  journal_cleanup || fail "$JOURNAL_KEEP_FAILED"
  step_done
  # A stop that waited for the commit ends the step now, its work done.
  step_release
  if ! stub_back; then
    case "$NET_TOOL" in
      networkmanager) how="nmcli connection up $DNS_STUB_IFACE" ;;
      *) how="networkctl reconfigure $DNS_STUB_IFACE" ;;
    esac
    fail "$BRIDGE is in place on $UPLINK and kept, but the container DNS stub $DNS_STUB_IFACE did not hold ${DNS_STUB_IP}/32 in the ${NET_WAIT_SEC} s waited after the bridge was committed: bring it back ($how), and run this again."
  fi
  exit 0
fi
WHY="${WHY:-the $NET_TOOL apply failed}"
undo
