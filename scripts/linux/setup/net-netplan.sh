# Sourced by network-plan.sh, the bridge step and the journal, as root; do not
# execute it. The bridge through netplan: systemd-networkd from netplan's files.
#   plan_netplan    the operator's file that defines the uplink, edited with
#                   `netplan set` in a staged copy of /lib, /etc and /run/netplan
#                   and checked whole by netplan (netplan.py does the reading)
#   apply_netplan   for a DUID identity, networkd's drop-in on netplan's unit for
#                   the bridge (netplan has no IAID key) — harmless while no
#                   bridge exists; then the operator's file as the plan edited
#                   and checked it, in one rename: the switch; `netplan apply`
#   check_netplan   nothing beyond the shared check
#   finish_netplan  nothing: the switch was the last change
#   undo_netplan    after the files are back: the bridge deleted, `netplan apply`

plan_netplan() {
  local status def mode rc why stage d f hint kv merged
  status="$(net_read netplan status "$UPLINK" --format json)" || exit 1
  UPLINK_NETPLAN_ID="$(python3 -I "$NET_SETUP_DIR/netplan.py" status-id "$UPLINK" <<<"$status")" \
    || net_fail "cannot read netplan's status for $UPLINK"
  [[ -n "$UPLINK_NETPLAN_ID" ]] || net_refuse "netplan has no definition for the uplink $UPLINK."
  # The file the definition comes from, as netplan's parser reads it.
  NETPLAN_ORIGIN="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" python3 -I "$NET_SETUP_DIR/netplan.py" origin "$UPLINK_NETPLAN_ID")" \
    || net_fail "netplan cannot parse its configuration"
  [[ "$NETPLAN_ORIGIN" == /etc/netplan/*.yaml ]] \
    || net_refuse "netplan defines $UPLINK in $NETPLAN_ORIGIN, outside /etc/netplan, where setup cannot edit it."
  UPLINK_CLIENT_ID="$(client_id "$UPLINK" "$NET_TOOL")"
  def="$NET_PLAN_DIR/uplink.yaml"
  net_read netplan get "ethernets.$UPLINK_NETPLAN_ID" > "$def" || exit 1
  # The uplink's definition, checked; what moves to the bridge worked out; the
  # edits written as `netplan set` arguments (one per line: the origin hint, a
  # tab, key=value), all in the operator's file that defines the uplink: its
  # layer-3 keys removed, and the bridge defined with them.
  mode="$(python3 -I "$NET_SETUP_DIR/netplan.py" plan "$def" "$UPLINK_NETPLAN_ID" "$UPLINK" "$UPLINK_MAC" "$BRIDGE" \
    "$UPLINK_CLIENT_ID" "$NETPLAN_ORIGIN" "$NET_PLAN_DIR" "$UPLINK_MTU")" \
    || { rc=$?; if (( rc == 3 )); then net_refuse "$mode."; fi; net_fail "cannot work out the bridge for netplan: $mode"; }
  UPLINK_MODE="$mode"
  why="$(python3 -I "$NET_SETUP_DIR/netplan.py" shared "$NETPLAN_ORIGIN")" || net_fail "cannot read netplan's files"
  [[ -z "$why" ]] || net_refuse "$why; setup would write that definition back merged."
  # The edits made in a staged copy of /etc/netplan, generated, and the merged
  # definitions read back: the interface must keep no layer 3, the bridge must
  # be what setup wrote.
  stage="$NET_PLAN_DIR/stage"
  for d in /lib/netplan /etc/netplan /run/netplan; do
    [[ ! -d "$d" ]] && continue
    mkdir -p "$stage$(dirname "$d")" && cp -a "$d" "$stage$d" || net_fail "cannot stage $d"
  done
  while IFS=$'\t' read -r hint kv; do
    net_read netplan set --root-dir "$stage" --origin-hint "$hint" "$kv" || exit 1
  done < "$NET_PLAN_DIR/netplan-set.args"
  # netplan set touches the origin file alone: every other file in the stage
  # must still be its live one, and none new, so what is checked is what goes
  # live.
  for d in /lib/netplan /etc/netplan /run/netplan; do
    for f in "$d"/* "$stage$d"/*; do
      [[ -e "$f" || -L "$f" ]] || continue
      f="${f#"$stage"}"
      [[ "$f" == "$NETPLAN_ORIGIN" ]] && continue
      if [[ -e "$f" && -e "$stage$f" ]]; then
        cmp -s "$f" "$stage$f" || net_fail "netplan set changed $f in the stage, beside $NETPLAN_ORIGIN"
      elif [[ -e "$stage$f" ]]; then
        net_fail "netplan set made $f in the stage, beside $NETPLAN_ORIGIN"
      else
        net_fail "netplan set removed $f in the stage, beside $NETPLAN_ORIGIN"
      fi
    done
  done
  net_read netplan generate --root-dir "$stage" >/dev/null || exit 1
  merged="$(net_read netplan get --root-dir "$stage")" || exit 1
  why="$(python3 -I "$NET_SETUP_DIR/netplan.py" merged "$UPLINK_NETPLAN_ID" "$BRIDGE" \
    "$(awk -F'\t' -v k="bridges.$BRIDGE=" 'index($2, k) == 1 { print substr($2, length(k) + 1) }' "$NET_PLAN_DIR/netplan-set.args")" <<<"$merged")" \
    || net_fail "cannot read the staged netplan configuration back"
  [[ -z "$why" ]] || net_refuse "with setup's edits, netplan's merged configuration is not what setup wrote: $why."
  # The DUID drop-in attaches to the unit netplan renders for the bridge.
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" && ! -f "$stage/run/systemd/network/10-netplan-$BRIDGE.network" ]]; then
    net_refuse "netplan renders no 10-netplan-$BRIDGE.network for the DHCP identity's drop-in."
  fi
  # What was checked is what goes live: the edited file, as the stage holds it.
  cp -a "$stage$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" || net_fail "cannot keep the checked $NETPLAN_ORIGIN"
  rm -rf "$stage"
}

apply_netplan() {
  local dropin_dir=/etc/systemd/network/10-netplan-$BRIDGE.network.d
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" ]]; then
    journal_dir "$dropin_dir" || { WHY="cannot make $dropin_dir"; return 1; }
    put_file "$dropin_dir/50-wisp-dhcp-identity.conf" "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" 0644 || return 1
  fi
  put_file "$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" 0600 || return 1
  apply_notice
  timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" netplan apply
}
check_netplan() { :; }
finish_netplan() { :; }

# undo_netplan <bridge>: runs in journal_restore's subshell.
undo_netplan() {
  [[ ! -e "/sys/class/net/$1" ]] || timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ip link delete "$1"
  timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" netplan apply
}
