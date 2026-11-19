# Sourced by network-plan.sh, the bridge step and the journal, as root; do not
# execute it. The bridge through NetworkManager.
#   plan_networkmanager    a bridge connection and a port connection, rendered
#                          and checked offline by `nmcli --offline`
#   apply_networkmanager   both written as keyfiles and loaded together, so
#                          NetworkManager never holds one without the other;
#                          then the bridge brought up with its port, whose
#                          autoconnect priority is above the uplink connection's
#                          (a boot inside the step brings up the bridge)
#   check_networkmanager   which connection NetworkManager now runs each link from
#   finish_networkmanager  the uplink's own connection deleted, its stored
#                          definition kept with the originals: the last change
#   undo_networkmanager    after the files are back: the connections reloaded and
#                          the uplink's own brought up

plan_networkmanager() {
  local con mac files n prio routes4 routes6 metric4 metric6 p v f args why
  UPLINK_CONNECTION="$(net_read nmcli -g GENERAL.CON-UUID device show "$UPLINK")" || exit 1
  [[ -n "$UPLINK_CONNECTION" ]] || net_refuse "NetworkManager names no connection for the uplink $UPLINK."
  con="$(net_read nmcli -t connection show "$UPLINK_CONNECTION")" || exit 1
  # One property of the uplink's connection; empty when unset.
  _prop() {
    local v
    v="$(awk -v k="$1:" 'index($0, k) == 1 && !done { print substr($0, length(k) + 1); done = 1 }' <<<"$con")"
    [[ "$v" == -- ]] && v=""
    printf '%s' "$v"
  }
  [[ "$(_prop connection.type)" == 802-3-ethernet ]] \
    || net_refuse "$UPLINK's connection is of type $(_prop connection.type)."
  [[ -z "$(_prop match.interface-name)" ]] \
    || net_refuse "$UPLINK's connection matches the interfaces \"$(_prop match.interface-name)\", not $UPLINK alone."
  mac="$(_prop 802-3-ethernet.mac-address)"
  if [[ "$(_prop connection.interface-name)" != "$UPLINK" && "${mac,,}" != "$UPLINK_MAC" ]]; then
    net_refuse "$UPLINK's connection is not bound to $UPLINK by name or hardware address, so it applies to other interfaces too."
  fi
  # The uplink's connection is deleted as the bridge step's last change, its
  # stored definition kept with the originals: a keyfile under /etc, or the
  # file netplan keeps for a connection NetworkManager made. The default one
  # NetworkManager makes for a wired device and holds in memory needs nothing
  # kept. A definition stored anywhere else, or one netplan renders from an
  # operator's own file, is refused.
  files="$(net_read nmcli -t -f UUID,NAME,FILENAME connection show)" || exit 1
  NM_PROFILE_FILE="$(awk -F: -v u="$UPLINK_CONNECTION" '$1 == u { print $3 }' <<<"$files")"
  case "$NM_PROFILE_FILE" in
    /etc/NetworkManager/system-connections/*) ;;
    /run/NetworkManager/system-connections/netplan-NM-"$UPLINK_CONNECTION".nmconnection)
      NM_PROFILE_FILE="/etc/netplan/90-NM-$UPLINK_CONNECTION.yaml"
      [[ -f "$NM_PROFILE_FILE" ]] || net_refuse "${UPLINK}'s connection is rendered by netplan, but $NM_PROFILE_FILE is missing." ;;
    /run/NetworkManager/system-connections/netplan-*)
      net_refuse "${UPLINK}'s connection is rendered by netplan from an operator's file in /etc/netplan: setup does not change it through NetworkManager." ;;
    "" | /run/NetworkManager/*) NM_PROFILE_FILE="" ;;
    *) net_refuse "${UPLINK}'s connection is stored in $NM_PROFILE_FILE, where setup cannot keep it to undo its removal." ;;
  esac
  [[ -z "$NM_PROFILE_FILE" ]] || journal_root_ok "$NM_PROFILE_FILE" \
    || net_refuse "${UPLINK}'s connection is stored in $NM_PROFILE_FILE, where setup cannot keep it to undo its removal."
  # Names setup would give its connections, and the files it would write them
  # to, already taken while no bridge is in use.
  for n in "$BRIDGE" "${BRIDGE}-port-${UPLINK}"; do
    ! awk -F: -v n="$n" '$2 == n { found = 1 } END { exit !found }' <<<"$files" \
      || net_refuse "a NetworkManager connection named $n exists already, and no bridge is in use: remove it, or bring up the bridge it belongs to."
  done
  NM_BRIDGE_FILE="/etc/NetworkManager/system-connections/${BRIDGE}.nmconnection"
  NM_PORT_FILE="/etc/NetworkManager/system-connections/${BRIDGE}-port-${UPLINK}.nmconnection"
  for n in "$NM_BRIDGE_FILE" "$NM_PORT_FILE"; do
    [[ ! -e "$n" ]] || net_refuse "$n exists already, and no bridge is in use: remove it."
  done
  # The port comes up on the uplink at boot ahead of the uplink's own
  # connection: autoconnect priority above it.
  prio="$(_prop connection.autoconnect-priority)"
  [[ "$prio" =~ ^-?[0-9]+$ ]] || prio=0
  (( prio < 999 )) || net_refuse "${UPLINK}'s connection has the highest autoconnect priority (999): no port could come up ahead of it."
  NM_PORT_PRIORITY=$(( prio + 1 > 0 ? prio + 1 : 0 ))
  NM_BRIDGE_UUID="$(cat /proc/sys/kernel/random/uuid)"
  NM_PORT_UUID="$(cat /proc/sys/kernel/random/uuid)"
  case "$(_prop ipv4.method)" in
    auto) UPLINK_MODE=dhcp ;;
    manual) UPLINK_MODE=static ;;
    *) net_refuse "$UPLINK's connection has IPv4 method '$(_prop ipv4.method)': neither DHCP nor a static address." ;;
  esac
  for p in 802-1x.eap connection.master connection.controller; do
    v="$(_prop "$p")"
    [[ -z "$v" ]] || net_refuse "$UPLINK's connection sets $p ($v), which setup does not carry over to a bridge."
  done
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    UPLINK_CLIENT_ID="$(client_id "$UPLINK" "$NET_TOOL")"
    [[ -n "$UPLINK_CLIENT_ID" ]] || net_refuse "$UPLINK is on DHCP but NetworkManager reports no client identifier for its lease."
  fi
  # NetworkManager gives a bridge another default route metric than an
  # Ethernet interface: the metric the uplink's routes have is kept.
  routes4="$(net_read ip -4 route show default dev "$UPLINK")" || exit 1
  routes6="$(net_read ip -6 route show default dev "$UPLINK")" || exit 1
  _metric_of() { awk '$1 == "default" && !done { for (i = 1; i < NF; i++) if ($i == "metric") { print $(i + 1); done = 1; break } }' <<<"$1"; }
  metric4="$(_metric_of "$routes4")"
  metric6="$(_metric_of "$routes6")"
  # The bridge connection: the uplink connection's whole layer 3 — every ipv4.*
  # and ipv6.* property it holds, static addresses, routes, name servers and
  # DHCP settings alike — its route metrics, the client identifier it sent on
  # DHCP, exactly (NM takes it as bytes), and its hardware address. The port
  # connection: no addressing of its own, and the uplink connection's link
  # settings (every 802-3-ethernet.* and ethtool.* property). Both connect by
  # themselves from the moment they are added (see the bridge step).
  {
    printf '%s\n' type bridge ifname "$BRIDGE" con-name "$BRIDGE" connection.uuid "$NM_BRIDGE_UUID" \
      bridge.mac-address "$UPLINK_MAC" bridge.stp no connection.autoconnect yes connection.autoconnect-ports true \
      802-3-ethernet.mtu "$UPLINK_MTU"
    awk -v m4="$metric4" -v m6="$metric6" '/^ipv[46]\./ {
      k = $0; sub(/:.*/, "", k); v = substr($0, length(k) + 2)
      if (v == "" || v == "--" || k == "ipv4.dhcp-client-id" || k ~ /-deprecated$/) next
      if (k == "ipv4.route-metric" && v == "-1" && m4 != "") v = m4
      if (k == "ipv6.route-metric" && v == "-1" && m6 != "") v = m6
      print k; print v
    }' <<<"$con"
    [[ -z "${UPLINK_CLIENT_ID:-}" ]] || printf '%s\n' ipv4.dhcp-client-id "$UPLINK_CLIENT_ID"
  } > "$NET_PLAN_DIR/bridge.args"
  {
    printf '%s\n' type ethernet ifname "$UPLINK" con-name "${BRIDGE}-port-${UPLINK}" connection.uuid "$NM_PORT_UUID" \
      controller "$BRIDGE" port-type bridge connection.autoconnect yes \
      connection.autoconnect-priority "$NM_PORT_PRIORITY"
    awk '/^(802-3-ethernet|ethtool)\./ {
      k = $0; sub(/:.*/, "", k); v = substr($0, length(k) + 2)
      if (v == "" || v == "--") next
      print k; print v
    }' <<<"$con"
  } > "$NET_PLAN_DIR/port.args"
  # Both rendered as keyfiles and checked by NetworkManager itself, offline:
  # nothing is added.
  if ! timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli --offline connection add --help >/dev/null 2>&1; then
    net_refuse "this nmcli has no --offline, with which setup checks the connections it adds before adding them."
  fi
  for f in bridge port; do
    mapfile -t args < "$NET_PLAN_DIR/$f.args"
    why="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli --offline connection add "${args[@]}" 2>&1 >"$NET_PLAN_DIR/$f.nmconnection")" \
      || net_refuse "NetworkManager does not accept the $f connection setup would add: ${why:-nmcli --offline failed}."
  done
  unset -f _metric_of _prop
}

apply_networkmanager() {
  put_file "$NM_BRIDGE_FILE" "$NET_PLAN_DIR/bridge.nmconnection" 0600 || return 1
  put_file "$NM_PORT_FILE" "$NET_PLAN_DIR/port.nmconnection" 0600 || return 1
  apply_notice
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli connection load "$NM_BRIDGE_FILE" "$NM_PORT_FILE" \
    || { WHY="NetworkManager did not load $NM_BRIDGE_FILE and $NM_PORT_FILE"; return 1; }
  timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" nmcli --wait "$NET_APPLY_SEC" connection up "$NM_BRIDGE_UUID" >/dev/null
}
check_networkmanager() {
  local link want got
  for link in "$BRIDGE" "$UPLINK"; do
    want="$NM_BRIDGE_UUID"
    [[ "$link" == "$UPLINK" ]] && want="$NM_PORT_UUID"
    got="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli -g GENERAL.CON-UUID device show "$link" 2>/dev/null || true)"
    if [[ "$got" != "$want" ]]; then
      WHY="NetworkManager runs $link from the connection '${got}', not $want"
      return 1
    fi
  done
}
finish_networkmanager() {
  if [[ -n "${NM_PROFILE_FILE:-}" ]]; then
    journal_file "$NM_PROFILE_FILE" - || { WHY="cannot write the journal for $NM_PROFILE_FILE"; return 1; }
  fi
  journal_connrm "$UPLINK_CONNECTION" || { WHY="cannot write the journal"; return 1; }
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli connection delete "$UPLINK_CONNECTION" >/dev/null \
    || { WHY="NetworkManager did not delete ${UPLINK}'s former connection $UPLINK_CONNECTION"; return 1; }
  changed "NetworkManager connection $UPLINK_CONNECTION deleted: ${UPLINK}'s former one, now held by $BRIDGE and its port"
}

# undo_networkmanager <connection or -> <nm files restored: yes|no> <netplan's
# 90-NM file restored: yes|no>: runs in journal_restore's subshell. The step's
# connections go with their files, and the uplink's own comes back with its file
# (netplan's, generated); then it is brought up. When it is gone —
# NetworkManager's default wired one, held in memory, does not outlive a reboot
# once a stored connection is for the device — a restart of NetworkManager, with
# no such connection left, makes it again.
undo_networkmanager() {
  local con="$1" has state
  if [[ "$3" == yes ]]; then
    timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" netplan generate || return 1
  fi
  if [[ "$2" == yes ]]; then
    timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli connection reload || return 1
  fi
  has=1
  if [[ "$con" != - ]]; then
    has=0; nm_has "$con" || has=$?
    (( has <= 1 )) || return 1
  fi
  if (( has == 0 )); then
    state="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli -g GENERAL.STATE connection show "$con")" || return 1
    if [[ "$state" != activated ]]; then
      timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" nmcli --wait "$NET_APPLY_SEC" connection up "$con" >/dev/null || return 1
    fi
  else
    timeout -k "$NET_KILL_SEC" 60 systemctl restart NetworkManager || return 1
  fi
}
