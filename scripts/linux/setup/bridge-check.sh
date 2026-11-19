# Sourced by the bridge journal; do not execute it. The bridge step's check,
# run by the step after its apply and by a later run that finds the step's
# journal (bridge-journal.sh): within NET_APPLY_SEC the bridge holds what the
# uplink held — its hardware address, IPv4 addresses and default route, and on
# DHCP its client identifier and name servers, on a static address all its
# routes, name servers and search domains — the uplink holds none of it, and
# the tool runs each from the definition the step wrote (check_<tool>). There
# is no one event to wait on. Uses the plan's record.

# The reads go to the step's temp directory (step.sh), never to the plan's or
# the journal's: the asking phase changes nothing on the host.

# facts_of: the facts compared, from l3_state's lines. On DHCP the default
# route is compared by its gateway: its metric and source are the lease's and
# the tool's, and an uplink may carry the same route twice (once from the
# initramfs).
facts_of() {
  if [[ "$UPLINK_MODE" == static ]]; then
    grep -E '^(addr[46]|route[46]|dns|domain) ' || true
  else
    grep -E '^(addr4|route4 default|dns) ' | sed -E 's/^(route4 default via [^ ]+).*/\1/' | sort -u || true
  fi
}
# _read_now: what the bridge and the uplink hold now, into the step's
# now.*; a part that cannot be read (the bridge not there yet) is marked so.
_read_now() {
  local dir="$STEP_TMP_DIR" state
  rm -f "$dir"/now.*
  cat "/sys/class/net/$BRIDGE/address" > "$dir/now.mac" 2>/dev/null || echo unreadable > "$dir/now.mac"
  if state="$(l3_state "$BRIDGE" "$NET_TOOL" 2>/dev/null)"; then facts_of <<<"$state"; else echo unreadable; fi > "$dir/now.have"
  if state="$(l3_state "$UPLINK" "$NET_TOOL" 2>/dev/null)"; then grep -E '^(addr[46]|route[46]) ' <<<"$state" || true; else echo unreadable; fi > "$dir/now.port"
  if [[ "$UPLINK_MODE" == dhcp ]]; then client_id "$BRIDGE" "$NET_TOOL" 2>/dev/null || echo unreadable; fi > "$dir/now.cid"
  # The tool's apply reconfigures every link it runs, the stub's too: the
  # step ends only once the stub holds its address again, so the backend's
  # start after it finds it.
  state="$(net_call ip -4 -o addr show dev "$DNS_STUB_IFACE" 2>/dev/null || true)"
  if [[ "$state" == *" ${DNS_STUB_IP}/32 "* ]]; then echo yes; else echo no; fi > "$dir/now.stub"
}
# bridge_check <dir>: <dir> holds uplink.state, the reference. Run in the
# background and waited for, a read at a time, so a stop interrupts it at once.
# Sets WHY to what differs.
bridge_check() {
  local dir="$STEP_TMP_DIR" deadline=$(( SECONDS + NET_APPLY_SEC )) mac cid want have port stub
  want="$(facts_of < "$1/uplink.state")"
  while :; do
    _read_now &
    # A held stop returns wait early: wait again while the read runs.
    while kill -0 "$!" 2>/dev/null; do wait "$!" 2>/dev/null || true; done
    mac="$(cat "$dir/now.mac" 2>/dev/null || true)"
    have="$(cat "$dir/now.have" 2>/dev/null || true)"
    port="$(cat "$dir/now.port" 2>/dev/null || true)"
    cid="$(cat "$dir/now.cid" 2>/dev/null || true)"
    stub="$(cat "$dir/now.stub" 2>/dev/null || true)"
    if [[ "$mac" == "$UPLINK_MAC" && "$have" == "$want" && -z "$port" && "$cid" == "${UPLINK_CLIENT_ID:-}" && "$stub" == yes ]] \
      && "check_$NET_TOOL"; then
      rm -f "$dir"/now.*
      return 0
    fi
    if (( SECONDS >= deadline )); then
      WHY="after ${NET_APPLY_SEC} s"
      [[ "$mac" == "$UPLINK_MAC" ]] || WHY+=", $BRIDGE has hardware address '${mac}' (was $UPLINK_MAC)"
      [[ "$cid" == "${UPLINK_CLIENT_ID:-}" ]] || WHY+=", $BRIDGE sends client identifier '${cid}' (was $UPLINK_CLIENT_ID)"
      [[ "$have" == "$want" ]] || WHY+=", $BRIDGE holds [$(echo $have)], $UPLINK held [$(echo $want)]"
      [[ -z "$port" ]] || WHY+=", $UPLINK still holds [$(echo $port)]"
      [[ "$stub" == yes ]] || WHY+=", $DNS_STUB_IFACE does not hold ${DNS_STUB_IP}/32"
      "check_$NET_TOOL" || WHY+=", $CHECK_WHY"
      rm -f "$dir"/now.*
      return 1
    fi
    sleep 1
  done
}

# uplink_back <dir>: after an undo, whether the uplink holds again what it
# held before (<dir>/uplink.state, the check's reference), waited for as the
# check waits. Sets UPLINK_HOLDS to what it holds, and UPLINK_HELD to what it
# held, for the message.
uplink_back() {
  local deadline=$(( SECONDS + NET_APPLY_SEC )) state
  UPLINK_HELD="$(facts_of < "$1/uplink.state")"
  while :; do
    ( if state="$(l3_state "$UPLINK" "$NET_TOOL" 2>/dev/null)"; then facts_of <<<"$state"; else echo unreadable; fi \
      > "$STEP_TMP_DIR/now.uplink" ) &
    while kill -0 "$!" 2>/dev/null; do wait "$!" 2>/dev/null || true; done
    UPLINK_HOLDS="$(cat "$STEP_TMP_DIR/now.uplink" 2>/dev/null || true)"
    rm -f "$STEP_TMP_DIR/now.uplink"
    [[ "$UPLINK_HOLDS" != "$UPLINK_HELD" ]] || return 0
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}
