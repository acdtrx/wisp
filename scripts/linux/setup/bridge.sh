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
# NET_APPLY_SEC, the bridge must hold the uplink's hardware address, IPv4
# addresses, configured IPv6 addresses and default route — and on DHCP its
# client identifier and name servers, on a static address all its routes, name
# servers and search domains — the uplink none of it, the uplink must be its
# port and the bridge have carrier, and systemd-networkd must run each from the
# unit netplan renders for it. Otherwise, or when the step is stopped, it puts the kept original back,
# applies it, and fails saying so; failing before its switch, it takes back
# only what it wrote.
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
KEPT="" KEPT_STAGE="" DROPIN_DIR_MADE=0 SWITCHED=0 WHY=""

# keep_original: NETPLAN_ORIGIN copied into KEPT, staged under a hidden name
# and renamed into place, so no half-made one is ever seen; a stage a step cut
# short left goes first.
keep_original() {
  local when name n=1
  mkdir -p "$KEPT_ROOT" && chmod 700 "$KEPT_ROOT" || return 1
  rm -rf -- "$KEPT_ROOT"/.*.wisp-new
  when="$(date -u +%Y-%m-%dT%H%M%SZ)"
  name="$when"
  while [[ -e "$KEPT_ROOT/$name" ]]; do n=$((n + 1)); name="$when-$n"; done
  # Named only once it is free: drop_kept removes KEPT.
  KEPT="$KEPT_ROOT/$name"
  KEPT_STAGE="$KEPT_ROOT/.$name.wisp-new"
  mkdir -p "$KEPT_STAGE$(dirname "$NETPLAN_ORIGIN")" \
    && cp -a "$NETPLAN_ORIGIN" "$KEPT_STAGE$NETPLAN_ORIGIN" \
    && sync "$KEPT_STAGE$NETPLAN_ORIGIN" "$KEPT_STAGE$(dirname "$NETPLAN_ORIGIN")" "$KEPT_STAGE/etc" "$KEPT_STAGE" \
    && mv -T "$KEPT_STAGE" "$KEPT" && sync "$KEPT_ROOT"
}
# drop_kept: a stop before the first change leaves nothing kept.
drop_kept() { rm -rf -- ${KEPT_STAGE:+"$KEPT_STAGE"} ${KEPT:+"$KEPT"}; }

# apply_bridge: the drop-in as this plan needs it, the switch (SWITCHED), then
# netplan applies them. Sets WHY when a part fails.
apply_bridge() {
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" ]]; then
    if [[ ! -d "$DROPIN_DIR" ]]; then
      mkdir -p "$DROPIN_DIR" || { WHY="cannot make $DROPIN_DIR"; return 1; }
      DROPIN_DIR_MADE=1
    fi
    if ! cmp -s "$DROPIN" "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf"; then
      install_file "$DROPIN" "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" 0644 || { WHY="cannot write $DROPIN"; return 1; }
      changed "$DROPIN"
    fi
  elif [[ -e "$DROPIN" ]]; then
    # One an earlier step left would pin another identity on the bridge.
    remove_file "$DROPIN" || { WHY="cannot remove $DROPIN"; return 1; }
    changed "removed $DROPIN"
  fi
  install_file "$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" 0600 || { WHY="cannot write $NETPLAN_ORIGIN"; return 1; }
  SWITCHED=1
  changed "$NETPLAN_ORIGIN"
  echo "  applying: $BRIDGE on $UPLINK (was $UPLINK_ADDR); an ssh session may pause"
  net_apply netplan apply || { WHY="netplan apply failed"; return 1; }
}

# facts_of: the facts compared, from l3_state's lines: on DHCP too, every
# configured address of either family. On DHCP the default route is compared
# by its gateway: systemd-networkd sets its metric and source per link, and an
# uplink may carry the same route twice (once from the initramfs).
facts_of() {
  if [[ "$UPLINK_MODE" == static ]]; then
    grep -E '^(addr[46]|route[46]|dns|domain) ' || true
  else
    grep -E '^(addr[46]|route4 default|dns) ' | sed -E 's/^(route4 default via [^ ]+).*/\1/' | sort -u || true
  fi
}
# read_now: what the bridge and the uplink hold now, one part a file in the
# step's now.*; a part that cannot be read (the bridge not there yet) is
# marked so. Run through step_run, so a stop ends it at once.
read_now() {
  local dir="$STEP_TMP_DIR" state master
  rm -f "$dir"/now.*
  cat "/sys/class/net/$BRIDGE/address" > "$dir/now.mac" 2>/dev/null || echo unreadable > "$dir/now.mac"
  master="$(readlink "/sys/class/net/$UPLINK/master" 2>/dev/null)" || master=none
  echo "${master##*/}" > "$dir/now.master"
  cat "/sys/class/net/$BRIDGE/carrier" > "$dir/now.carrier" 2>/dev/null || echo unreadable > "$dir/now.carrier"
  if state="$(l3_state "$BRIDGE" 2>/dev/null)"; then facts_of <<<"$state"; else echo unreadable; fi > "$dir/now.have"
  if state="$(l3_state "$UPLINK" 2>/dev/null)"; then grep -E '^(addr[46]|route[46]) ' <<<"$state" || true; else echo unreadable; fi > "$dir/now.port"
  if [[ "$UPLINK_MODE" == dhcp ]]; then client_id "$BRIDGE" 2>/dev/null || echo unreadable; fi > "$dir/now.cid"
  networkd_json "$BRIDGE" NetworkFile > "$dir/now.bridge-unit" 2>/dev/null || echo unreadable > "$dir/now.bridge-unit"
  networkd_json "$UPLINK" NetworkFile > "$dir/now.uplink-unit" 2>/dev/null || echo unreadable > "$dir/now.uplink-unit"
}
# now <part>: one part of the last read.
now() { cat "$STEP_TMP_DIR/now.$1" 2>/dev/null || true; }
# bridge_check: within NET_APPLY_SEC, the uplink is the bridge's port and the
# bridge has carrier, the bridge holds what the uplink held (the plan's
# uplink.state), the uplink none of it, and systemd-networkd runs each from the
# unit netplan renders for it. A bridge without its port can hold static
# addresses and their routes all the same (netplan configures a bridge without
# carrier). There is no one event to wait on: read once a second. Sets WHY to
# what differs.
bridge_check() {
  local deadline=$(( SECONDS + NET_APPLY_SEC )) bridge_unit="/run/systemd/network/10-netplan-$BRIDGE.network"
  local want mac master carrier have port cid bunit uunit
  want="$(facts_of < "$NET_PLAN_DIR/uplink.state")"
  while :; do
    step_run 0 read_now || true
    mac="$(now mac)" master="$(now master)" carrier="$(now carrier)"
    have="$(now have)" port="$(now port)" cid="$(now cid)"
    bunit="$(now bridge-unit)" uunit="$(now uplink-unit)"
    if [[ "$master" == "$BRIDGE" && "$carrier" == 1 && "$mac" == "$UPLINK_MAC" && "$cid" == "${UPLINK_CLIENT_ID:-}" \
      && "$have" == "$want" && -z "$port" && "$bunit" == "$bridge_unit" && "$uunit" == "$UPLINK_NETFILE" ]]; then
      rm -f "$STEP_TMP_DIR"/now.*
      return 0
    fi
    if (( SECONDS >= deadline )); then
      WHY="after ${NET_APPLY_SEC} s"
      [[ "$master" == "$BRIDGE" ]] || WHY+=", $UPLINK is not $BRIDGE's port (its master: '${master}')"
      [[ "$carrier" == 1 ]] || WHY+=", $BRIDGE has no carrier"
      [[ "$mac" == "$UPLINK_MAC" ]] || WHY+=", $BRIDGE has hardware address '${mac}' (was $UPLINK_MAC)"
      [[ "$cid" == "${UPLINK_CLIENT_ID:-}" ]] || WHY+=", $BRIDGE sends client identifier '${cid}' (was $UPLINK_CLIENT_ID)"
      [[ "$have" == "$want" ]] || WHY+=", $BRIDGE holds [$(echo $have)], $UPLINK held [$(echo $want)]"
      [[ -z "$port" ]] || WHY+=", $UPLINK still holds [$(echo $port)]"
      [[ "$bunit" == "$bridge_unit" ]] || WHY+=", systemd-networkd runs $BRIDGE from '${bunit}', not $bridge_unit"
      [[ "$uunit" == "$UPLINK_NETFILE" ]] || WHY+=", systemd-networkd runs $UPLINK from '${uunit}', not $UPLINK_NETFILE"
      rm -f "$STEP_TMP_DIR"/now.*
      return 1
    fi
    sleep 1
  done
}
# read_uplink: the facts the uplink holds now, into the step's now.uplink, as
# read_now reads.
read_uplink() {
  local state
  if state="$(l3_state "$UPLINK" 2>/dev/null)"; then facts_of <<<"$state"; else echo unreadable; fi > "$STEP_TMP_DIR/now.uplink"
}
# uplink_back: after an undo, whether the uplink holds again what it held
# before, waited for as the check waits. Sets UPLINK_HOLDS to what it holds,
# and UPLINK_HELD to what it held, for the message.
uplink_back() {
  local deadline=$(( SECONDS + NET_APPLY_SEC ))
  UPLINK_HELD="$(facts_of < "$NET_PLAN_DIR/uplink.state")"
  while :; do
    step_run 0 read_uplink || true
    UPLINK_HOLDS="$(now uplink)"
    rm -f "$STEP_TMP_DIR/now.uplink"
    [[ "$UPLINK_HOLDS" != "$UPLINK_HELD" ]] || return 0
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

# remove_dropin: the drop-in gone, and its directory, when this step made it
# and it is empty.
remove_dropin() {
  remove_file "$DROPIN" || return 1
  (( ! DROPIN_DIR_MADE )) || rmdir "$DROPIN_DIR" 2>/dev/null || true
}
# restore: after the switch, the kept original back, the drop-in gone, the
# bridge deleted, netplan applied. Stops at the first part that fails.
restore() {
  local copy="$KEPT$NETPLAN_ORIGIN"
  install_file "$NETPLAN_ORIGIN" "$copy" "$(stat -c %a "$copy")" "$(stat -c %U:%G "$copy")" || return 1
  remove_dropin || return 1
  [[ ! -e "/sys/class/net/$BRIDGE" ]] || net_call ip link delete "$BRIDGE" || return 1
  net_apply netplan apply
}
# undo: inside a section that must finish (step_hold): never cut short by a
# stop (the session's KILL past setup's bound is the end of it). The step
# fails either way, saying what the uplink holds (undo_fail).
undo() {
  local addr outcome
  step_hold
  echo "  not applied: $WHY; undoing it" >&2
  if (( ! SWITCHED )); then
    # Before the switch the network is as it was: what the step wrote goes.
    rm -rf -- "$KEPT"
    remove_dropin || undo_fail "$BRIDGE was not applied ($WHY), before its switch: $NETPLAN_ORIGIN is as it was, but $DROPIN, which the step wrote, could not be removed: remove it."
    undo_fail "$BRIDGE was not applied ($WHY), before its switch: $NETPLAN_ORIGIN is as it was."
  fi
  restore || undo_fail "$BRIDGE was not applied ($WHY). Undoing it did not complete: the network may be half the bridge's, and the original stays kept in $KEPT. docs/specs/DEPLOYMENT.md (The bridge) says how to put it back at the console."
  rm -rf -- "$KEPT"
  outcome="$NETPLAN_ORIGIN is back as it was"
  if uplink_back; then
    addr="$(awk '$1 == "addr4" && !done { print $2; done = 1 }' <<<"$UPLINK_HOLDS")"
    outcome+="; $UPLINK holds the addresses, routes and name servers it held before${addr:+ ($addr)}"
  else
    outcome+="; but $UPLINK holds [$(echo $UPLINK_HOLDS)] after ${NET_APPLY_SEC} s, where it held [$(echo $UPLINK_HELD)] before"
  fi
  undo_fail "$BRIDGE was not applied ($WHY). $outcome."
}
# undo_fail <message>: the undo's end: exit 1, or 143 when the step was
# stopped, as every stopped step ends (step_stop).
UNDO_STATUS=1
undo_fail() {
  echo "ERROR: $*" >&2
  exit "$UNDO_STATUS"
}
undo_stopped() { WHY="the step was stopped" UNDO_STATUS=143; undo; }

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
  echo "  $BRIDGE holds what $UPLINK held ($UPLINK_ADDR, $UPLINK_MODE) with its hardware address $UPLINK_MAC; $UPLINK is its port and holds no address"
  echo "  The original network file stays kept in $KEPT."
  step_done
  # An apply can drop the container DNS stub's address for a while
  # (docs/specs/CONTAINERS.md, Local DNS), and the backend's start follows the
  # step: the stub is waited for until it holds its settings. Not part of the
  # bridge or its check: the bridge stays whatever the stub does. Outside a
  # section that must finish, so a stop ends the wait after its read in flight.
  dns_stub_wait || fail "$BRIDGE is in place on $UPLINK and kept, but the container DNS stub $DNS_STUB_IFACE did not hold ${DNS_STUB_IP}/32 alone in the ${NET_WAIT_SEC} s waited after the bridge was made: bring it back (networkctl reconfigure $DNS_STUB_IFACE), and run this again."
  exit 0
fi
undo
