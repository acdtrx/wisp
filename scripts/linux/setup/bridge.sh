#!/usr/bin/env bash
# Setup step, the last: the bridge Wisp's VMs and containers join. When the
# uplink already is a bridge there is nothing to do; otherwise `br0`, worked out
# and checked by network-plan.sh in this run, goes live through netplan: the
# operator's netplan file kept as it was, first; for a DUID identity,
# networkd's drop-in on netplan's unit for the bridge (harmless while no bridge
# exists); then the operator's file as the plan edited and checked it, in one
# rename — the switch — and `netplan apply`. Each change leaves a network that
# boots, old or new. Run as root.
#
# The bridge keeps the host's address: it takes the uplink's hardware address
# and its whole layer 3, static or DHCP, with its DHCP identity, so the DHCP
# server hands it the same lease; link settings stay with the uplink, which
# becomes its port with no addressing of its own. After the apply, within
# NET_APPLY_SEC, the bridge must hold the uplink's former hardware address, IPv4
# addresses and default route — and on DHCP its client identifier and name
# servers, on a static address all its routes, name servers and search domains
# — the uplink none of it, and systemd-networkd must run each from the unit
# netplan renders for it. Otherwise, or when the step is stopped, it puts the
# kept original back, applies it, and fails saying so.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
# shellcheck source=bridge-plan.sh
source "$SETUP_DIR/bridge-plan.sh"
# shellcheck source=plan-record.sh
source "$SETUP_DIR/plan-record.sh"
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

# Where the operator's originals are kept: a directory per bridge step, named
# by its UTC time, each file under its own path in it.
KEPT_ROOT=/var/lib/wisp/network-before-bridge
DROPIN_DIR="/etc/systemd/network/10-netplan-$BRIDGE.network.d"
DROPIN="$DROPIN_DIR/50-wisp-dhcp-identity.conf"
KEPT="" KEPT_STAGE="" DROPIN_DIR_MADE=0 WHY=""

# keep_original: NETPLAN_ORIGIN copied into KEPT, staged under a hidden name
# and renamed into place, so no half-made one is ever seen; a stage a step cut
# short left goes first.
keep_original() {
  local when n=1
  mkdir -p "$KEPT_ROOT" && chmod 700 "$KEPT_ROOT" || return 1
  rm -rf -- "$KEPT_ROOT"/.*.wisp-new
  when="$(date -u +%Y-%m-%dT%H%M%SZ)"
  KEPT="$KEPT_ROOT/$when"
  while [[ -e "$KEPT" ]]; do n=$((n + 1)); KEPT="$KEPT_ROOT/$when-$n"; done
  KEPT_STAGE="$KEPT_ROOT/.$(basename "$KEPT").wisp-new"
  mkdir -p "$KEPT_STAGE$(dirname "$NETPLAN_ORIGIN")" \
    && cp -a "$NETPLAN_ORIGIN" "$KEPT_STAGE$NETPLAN_ORIGIN" \
    && sync "$KEPT_STAGE$NETPLAN_ORIGIN" "$KEPT_STAGE$(dirname "$NETPLAN_ORIGIN")" "$KEPT_STAGE/etc" "$KEPT_STAGE" \
    && mv -T "$KEPT_STAGE" "$KEPT" && sync "$KEPT_ROOT"
}
# drop_kept: a stop before the first change leaves nothing kept.
drop_kept() { rm -rf -- ${KEPT_STAGE:+"$KEPT_STAGE"} ${KEPT:+"$KEPT"}; }

# apply_bridge: the drop-in as this plan needs it, the switch, then netplan
# applies them. Sets WHY when a part fails.
apply_bridge() {
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" ]]; then
    if [[ ! -d "$DROPIN_DIR" ]]; then
      mkdir -p "$DROPIN_DIR" || { WHY="cannot make $DROPIN_DIR"; return 1; }
      DROPIN_DIR_MADE=1
    fi
    install_file "$DROPIN" "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" 0644 || { WHY="cannot write $DROPIN"; return 1; }
    changed "$DROPIN"
  elif [[ -e "$DROPIN" ]]; then
    # One an earlier step left would pin another identity on the bridge.
    remove_file "$DROPIN" || { WHY="cannot remove $DROPIN"; return 1; }
    changed "removed $DROPIN"
  fi
  install_file "$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" 0600 || { WHY="cannot write $NETPLAN_ORIGIN"; return 1; }
  changed "$NETPLAN_ORIGIN"
  echo "  applying: $BRIDGE on $UPLINK (was $UPLINK_ADDR); an ssh session may pause"
  net_apply netplan apply || { WHY="netplan apply failed"; return 1; }
}

# facts_of: the facts compared, from l3_state's lines. On DHCP the default
# route is compared by its gateway: systemd-networkd sets its metric and
# source per link, and an uplink may carry the same route twice (once from the
# initramfs).
facts_of() {
  if [[ "$UPLINK_MODE" == static ]]; then
    grep -E '^(addr[46]|route[46]|dns|domain) ' || true
  else
    grep -E '^(addr4|route4 default|dns) ' | sed -E 's/^(route4 default via [^ ]+).*/\1/' | sort -u || true
  fi
}
# runs_from_netplan: whether systemd-networkd runs the bridge and the uplink
# from the units netplan renders for them; CHECK_WHY says otherwise.
runs_from_netplan() {
  local link want got
  for link in "$BRIDGE" "$UPLINK"; do
    want="/run/systemd/network/10-netplan-$BRIDGE.network"
    [[ "$link" == "$UPLINK" ]] && want="/run/systemd/network/10-netplan-$UPLINK_NETPLAN_ID.network"
    got="$(networkd_json "$link" NetworkFile 2>/dev/null || true)"
    if [[ "$got" != "$want" ]]; then
      CHECK_WHY="systemd-networkd runs $link from '${got}', not $want"
      return 1
    fi
  done
}
# read_now: what the bridge and the uplink hold now, into the step's now.*; a
# part that cannot be read (the bridge not there yet) is marked so.
read_now() {
  local dir="$STEP_TMP_DIR" state
  rm -f "$dir"/now.*
  cat "/sys/class/net/$BRIDGE/address" > "$dir/now.mac" 2>/dev/null || echo unreadable > "$dir/now.mac"
  if state="$(l3_state "$BRIDGE" 2>/dev/null)"; then facts_of <<<"$state"; else echo unreadable; fi > "$dir/now.have"
  if state="$(l3_state "$UPLINK" 2>/dev/null)"; then grep -E '^(addr[46]|route[46]) ' <<<"$state" || true; else echo unreadable; fi > "$dir/now.port"
  if [[ "$UPLINK_MODE" == dhcp ]]; then client_id "$BRIDGE" 2>/dev/null || echo unreadable; fi > "$dir/now.cid"
}
# bridge_check: within NET_APPLY_SEC, the bridge holds what the uplink held
# (the plan's uplink.state), the uplink none of it, each run from netplan's
# unit. There is no one event to wait on: read once a second, each read in the
# background and waited for, so a stop interrupts it at once. Sets WHY to what
# differs.
bridge_check() {
  local dir="$STEP_TMP_DIR" deadline=$(( SECONDS + NET_APPLY_SEC )) mac cid want have port
  want="$(facts_of < "$NET_PLAN_DIR/uplink.state")"
  while :; do
    read_now &
    while kill -0 "$!" 2>/dev/null; do wait "$!" 2>/dev/null || true; done
    mac="$(cat "$dir/now.mac" 2>/dev/null || true)"
    have="$(cat "$dir/now.have" 2>/dev/null || true)"
    port="$(cat "$dir/now.port" 2>/dev/null || true)"
    cid="$(cat "$dir/now.cid" 2>/dev/null || true)"
    if [[ "$mac" == "$UPLINK_MAC" && "$have" == "$want" && -z "$port" && "$cid" == "${UPLINK_CLIENT_ID:-}" ]] \
      && runs_from_netplan; then
      rm -f "$dir"/now.*
      return 0
    fi
    if (( SECONDS >= deadline )); then
      WHY="after ${NET_APPLY_SEC} s"
      [[ "$mac" == "$UPLINK_MAC" ]] || WHY+=", $BRIDGE has hardware address '${mac}' (was $UPLINK_MAC)"
      [[ "$cid" == "${UPLINK_CLIENT_ID:-}" ]] || WHY+=", $BRIDGE sends client identifier '${cid}' (was $UPLINK_CLIENT_ID)"
      [[ "$have" == "$want" ]] || WHY+=", $BRIDGE holds [$(echo $have)], $UPLINK held [$(echo $want)]"
      [[ -z "$port" ]] || WHY+=", $UPLINK still holds [$(echo $port)]"
      runs_from_netplan || WHY+=", $CHECK_WHY"
      rm -f "$dir"/now.*
      return 1
    fi
    sleep 1
  done
}
# uplink_back: after an undo, whether the uplink holds again what it held
# before, waited for as the check waits. Sets UPLINK_HOLDS to what it holds,
# and UPLINK_HELD to what it held, for the message.
uplink_back() {
  local deadline=$(( SECONDS + NET_APPLY_SEC )) state
  UPLINK_HELD="$(facts_of < "$NET_PLAN_DIR/uplink.state")"
  while :; do
    ( if state="$(l3_state "$UPLINK" 2>/dev/null)"; then facts_of <<<"$state"; else echo unreadable; fi \
      > "$STEP_TMP_DIR/now.uplink" ) &
    while kill -0 "$!" 2>/dev/null; do wait "$!" 2>/dev/null || true; done
    UPLINK_HOLDS="$(cat "$STEP_TMP_DIR/now.uplink" 2>/dev/null || true)"
    rm -f "$STEP_TMP_DIR/now.uplink"
    [[ "$UPLINK_HOLDS" != "$UPLINK_HELD" ]] || return 0
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

# restore: the kept original back, the drop-in gone (and its directory, when
# this step made it and it is empty), the bridge deleted, netplan applied.
# Stops at the first part that fails.
restore() {
  local copy="$KEPT$NETPLAN_ORIGIN"
  install_file "$NETPLAN_ORIGIN" "$copy" "$(stat -c %a "$copy")" "$(stat -c %U:%G "$copy")" || return 1
  remove_file "$DROPIN" || return 1
  (( ! DROPIN_DIR_MADE )) || rmdir "$DROPIN_DIR" 2>/dev/null || true
  [[ ! -e "/sys/class/net/$BRIDGE" ]] || net_call ip link delete "$BRIDGE" || return 1
  net_apply netplan apply
}
# undo: inside a section that must finish (step_hold): never cut short by a
# stop (the session's KILL past setup's bound is the end of it). The step
# fails either way, saying what the uplink holds.
undo() {
  local addr outcome
  step_hold
  echo "  not applied: ${WHY:-stopped}; undoing it" >&2
  restore || fail "$BRIDGE was not applied (${WHY:-the step was stopped}). Undoing it did not complete: the network may be half the bridge's, and the original stays kept in $KEPT. docs/specs/DEPLOYMENT.md (The bridge) says how to put it back at the console."
  rm -rf -- "$KEPT"
  outcome="$NETPLAN_ORIGIN is back as it was"
  if uplink_back; then
    addr="$(awk '$1 == "addr4" && !done { print $2; done = 1 }' <<<"$UPLINK_HOLDS")"
    outcome+="; $UPLINK holds the addresses, routes and name servers it held before${addr:+ ($addr)}"
  else
    outcome+="; but $UPLINK holds [$(echo $UPLINK_HOLDS)] after ${NET_APPLY_SEC} s, where it held [$(echo $UPLINK_HELD)] before"
  fi
  fail "$BRIDGE was not applied (${WHY:-the step was stopped}). $outcome."
}
undo_stopped() { WHY="the step was stopped"; undo; }

STEP_ON_STOP=drop_kept
keep_original || { drop_kept; fail "cannot keep $NETPLAN_ORIGIN in $KEPT_ROOT; the bridge step changed nothing"; }
echo "  $NETPLAN_ORIGIN kept in $KEPT"
# From the first change a stop undoes; the apply call in flight runs to its
# end first.
STEP_ON_STOP=undo_stopped
step_hold
applied=0
apply_bridge && applied=1
step_release
if (( applied )) && bridge_check; then
  STEP_ON_STOP=""
  changed "$BRIDGE created on $UPLINK"
  # What the check compared: name servers and search domains only where
  # systemd-resolved holds them (net-state.sh, l3_state).
  held="$(facts_of < "$NET_PLAN_DIR/uplink.state" | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
  extra=""
  [[ " $held" != *" dns "* ]] || extra+=", name servers"
  [[ " $held" != *" domain "* ]] || extra+=", search domains"
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    echo "  $BRIDGE holds $UPLINK_ADDR, its default route${extra}, hardware address $UPLINK_MAC, client identifier $UPLINK_CLIENT_ID; $UPLINK holds no address"
  else
    echo "  $BRIDGE holds ${UPLINK}'s static addresses, routes${extra}, hardware address $UPLINK_MAC; $UPLINK holds none"
  fi
  echo "  The original network file stays kept in $KEPT."
  step_done
  # An apply can drop the container DNS stub's address for a while (netplan's,
  # on Debian 13: about 6 s), and the backend's start follows the step: the
  # stub is waited for until it holds its settings. Not part of the bridge or
  # its check: the bridge stays whatever the stub does. Outside a section that
  # must finish, so a stop ends the wait at once.
  dns_stub_wait || fail "$BRIDGE is in place on $UPLINK and kept, but the container DNS stub $DNS_STUB_IFACE did not hold ${DNS_STUB_IP}/32 alone in the ${NET_WAIT_SEC} s waited after the bridge was made: bring it back (networkctl reconfigure $DNS_STUB_IFACE), and run this again."
  exit 0
fi
undo
