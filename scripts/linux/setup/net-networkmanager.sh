# Sourced by network-plan.sh, the bridge step and the journal, as root; do not
# execute it. The bridge through NetworkManager.
#   plan_networkmanager    a bridge connection and a port connection, rendered
#                          and checked offline by `nmcli --offline`
#   apply_networkmanager   both written as keyfiles, the port's first (a power
#                          cut between them leaves a port whose bridge does
#                          not exist, which never comes up, not a bridge
#                          without its port), loaded in one call; then the
#                          bridge brought up with its port, whose
#                          autoconnect priority is above the uplink connection's
#                          (a boot inside the step brings up the bridge)
#   check_networkmanager   which connection NetworkManager now runs each link from
#   finish_networkmanager  the uplink's own connection deleted, its stored
#                          definition kept with the originals: the last change
#   undo_networkmanager    after the files are back: the connections reloaded and
#                          the uplink's own brought up (a generated one loaded
#                          back as a stored copy)

# nm_dbus <uuid> <method-or-property>: the connection's Flags or GetSettings,
# from NetworkManager's D-Bus interface, as busctl's JSON.
nm_dbus() {
  local path out
  out="$(net_call busctl call --json=short org.freedesktop.NetworkManager /org/freedesktop/NetworkManager/Settings \
    org.freedesktop.NetworkManager.Settings GetConnectionByUuid s "$1")" || return 1
  path="$(python3 -I "$NET_SETUP_DIR/nm.py" path <<<"$out")" || return 1
  case "$2" in
    Flags) net_call busctl get-property --json=short org.freedesktop.NetworkManager "$path" \
      org.freedesktop.NetworkManager.Settings.Connection Flags ;;
    *) net_call busctl call --json=short org.freedesktop.NetworkManager "$path" \
      org.freedesktop.NetworkManager.Settings.Connection "$2" ;;
  esac
}
# NetworkManager's flag for a connection it generated itself (the default wired
# one), which it holds in memory, under /run.
NM_GENERATED=2

# nm_connections: NetworkManager's connections, one a line — uuid, name, type
# and file, tab-separated (nmcli's terse output, its escaped colons read).
nm_connections() {
  local out
  out="$(net_call nmcli -t -f UUID,NAME,TYPE,FILENAME connection show)" || return 1
  python3 -I "$NET_SETUP_DIR/nm.py" rows <<<"$out"
}

# nm_others: the plan's refusals over connections besides the uplink's —
# another Ethernet connection not bound to another device, which could take
# the uplink (exactly one definition for it, at boot or after the step); any
# connection that hangs off it (the finish deletes the connection it may
# name); a name or file setup would use, taken while no bridge is in use. Each
# connection's settings read from NetworkManager's D-Bus interface, judged by
# nm.py; one gone by the time it is read (a VM's tap, a container's veth,
# which come and go) is none of the uplink's. A refusal exits: the bridge
# step's sources run it through sources_refusals.
nm_others() {
  local files uuid n v f says settings has err
  files="$(nm_connections)" || net_fail "cannot list NetworkManager's connections"
  err="$(staged_file)"
  while IFS=$'\t' read -r uuid n v f; do
    [[ -n "$uuid" && "$uuid" != "$UPLINK_CONNECTION" ]] || continue
    if ! settings="$(nm_dbus "$uuid" GetSettings 2>"$err")"; then
      has=0; nm_has "$uuid" || has=$?
      case $has in
        1) continue ;;
        2) net_fail "NetworkManager cannot be asked about its connection '$n' ($uuid)" ;;
        *) net_fail "cannot read the settings of NetworkManager's connection '$n' ($uuid): $(<"$err")" ;;
      esac
    fi
    says="$(python3 -I "$NET_SETUP_DIR/nm.py" other "$UPLINK" "$UPLINK_CONNECTION" "$UPLINK_MAC" "${UPLINK_PERMADDR:-}" <<<"$settings")" \
      || net_fail "cannot read the settings NetworkManager returned for its connection '$n' ($uuid)"
    case "$says" in
      dependent\ *) net_refuse UPLINK_DEPENDENT "NetworkManager's $v connection '$n' ($uuid) hangs off $UPLINK (${says#dependent })." ;;
      taker) refuse NM_SECOND_PROFILE "NetworkManager's connection '$n' ($uuid${f:+, $f}) could take the uplink $UPLINK too: setup leaves exactly one definition for it. Bind that connection to another device or remove it, and run this again." ;;
    esac
  done <<<"$files"
  for n in "$BRIDGE" "${BRIDGE}-port-${UPLINK}"; do
    ! awk -F'\t' -v n="$n" '$2 == n { found = 1 } END { exit !found }' <<<"$files" \
      || refuse NM_NAME_TAKEN "a NetworkManager connection named $n exists already, and no bridge is in use: remove it, or bring up the bridge it belongs to, and run this again."
  done
  for f in "/etc/NetworkManager/system-connections/${BRIDGE}.nmconnection" \
    "/etc/NetworkManager/system-connections/${BRIDGE}-port-${UPLINK}.nmconnection"; do
    [[ ! -e "$f" ]] || refuse NM_NAME_TAKEN "$f exists already, and no bridge is in use: remove it, and run this again."
  done
}

# The remedy for a connection netplan renders that setup cannot keep.
NM_NETPLAN_REMEDY="store it as a keyfile under /etc/NetworkManager/system-connections, or let netplan run the uplink (renderer: networkd), and run this again."

# nm_refuse_settings <setting.property>...: the uplink's connection sets what
# setup neither carries to the bridge nor keeps on the port (nm.py unknown).
# Autoconnect off and permissions have a direct remedy, named when they are
# all there is; anything else is the bridge the operator makes.
nm_refuse_settings() {
  local s fix="" what=()
  for s in "$@"; do
    case "$s" in
      connection.autoconnect) fix+=" connection.autoconnect yes"; what+=("autoconnect off (it would not come up by itself)") ;;
      connection.permissions) fix+=' connection.permissions ""'; what+=("permissions (it would come up for those users alone)") ;;
      *) net_refuse NM_SETTING "$UPLINK's connection sets $*, which setup does not carry over to a bridge." ;;
    esac
  done
  refuse NM_SETTING "$UPLINK's connection sets $(IFS=,; echo "${what[*]}" | sed 's/,/, /g'), which the bridge cannot carry: the bridge comes up at boot for the host. Lift it (nmcli connection modify $UPLINK_CONNECTION$fix), and run this again."
}

plan_networkmanager() {
  local con mac out files n prio routes4 routes6 metric4 metric6 v f args why flags
  UPLINK_CONNECTION="$(net_read nmcli -g GENERAL.CON-UUID device show "$UPLINK")" || exit 1
  [[ -n "$UPLINK_CONNECTION" ]] || refuse NM_NO_CONNECTION "NetworkManager names no connection for the uplink $UPLINK: give it one (nmcli connection add type ethernet ifname $UPLINK …) and run this again."
  con="$(net_read nmcli -t -e no connection show "$UPLINK_CONNECTION")" || exit 1
  # One property of the uplink's connection; empty when unset.
  _prop() {
    local v
    v="$(awk -v k="$1:" 'index($0, k) == 1 && !done { print substr($0, length(k) + 1); done = 1 }' <<<"$con")"
    [[ "$v" == -- ]] && v=""
    printf '%s' "$v"
  }
  [[ "$(_prop connection.type)" == 802-3-ethernet ]] \
    || net_refuse NM_NOT_ETHERNET "$UPLINK's connection is of type $(_prop connection.type)."
  [[ -z "$(_prop match.interface-name)" ]] \
    || refuse NM_MATCH "$UPLINK's connection matches the interfaces \"$(_prop match.interface-name)\", not $UPLINK alone: bind it to $UPLINK by name (nmcli connection modify $UPLINK_CONNECTION match.interface-name \"\" connection.interface-name $UPLINK), and run this again."
  mac="$(_prop 802-3-ethernet.mac-address)"
  mac="${mac,,}"
  if [[ "$(_prop connection.interface-name)" != "$UPLINK" && "$mac" != "$UPLINK_MAC" \
    && ( -z "$UPLINK_PERMADDR" || "$mac" != "$UPLINK_PERMADDR" ) ]]; then
    refuse NM_NOT_BOUND "$UPLINK's connection is not bound to $UPLINK by name or hardware address, so it applies to other interfaces too: bind it (nmcli connection modify $UPLINK_CONNECTION connection.interface-name $UPLINK), and run this again."
  fi
  # Every setting it holds goes to the bridge or stays on the port (nm.py's
  # lists); any other is refused, naming it.
  why="$(nm_dbus "$UPLINK_CONNECTION" GetSettings | python3 -I "$NET_SETUP_DIR/nm.py" unknown)" \
    || net_fail "cannot read the settings of ${UPLINK}'s connection from NetworkManager"
  [[ -z "$why" ]] || nm_refuse_settings $why
  # The uplink's connection is deleted as the bridge step's last change, its
  # definition kept to undo that: a keyfile under /etc, the file netplan keeps
  # for a connection NetworkManager made, or — for the default one
  # NetworkManager generates for a wired device and holds in memory — a copy
  # rendered here. One stored anywhere else, one under /run that something
  # writes there again at every boot (an initrd's), and one netplan renders
  # from an operator's own file are refused.
  files="$(nm_connections)" || net_fail "cannot list NetworkManager's connections"
  NM_PROFILE_FILE="$(awk -F'\t' -v u="$UPLINK_CONNECTION" '$1 == u { print $4 }' <<<"$files")"
  case "$NM_PROFILE_FILE" in
    /etc/NetworkManager/system-connections/*) ;;
    /run/NetworkManager/system-connections/netplan-NM-"$UPLINK_CONNECTION".nmconnection)
      NM_PROFILE_FILE="/etc/netplan/90-NM-$UPLINK_CONNECTION.yaml"
      [[ -f "$NM_PROFILE_FILE" ]] || refuse NM_NETPLAN_MISSING "${UPLINK}'s connection is rendered by netplan, but $NM_PROFILE_FILE is missing, so setup cannot keep it to undo its removal: $NM_NETPLAN_REMEDY" ;;
    /run/NetworkManager/system-connections/netplan-*)
      refuse NM_NETPLAN_OPERATOR "${UPLINK}'s connection is rendered by netplan from an operator's file in /etc/netplan, which setup does not change through NetworkManager: $NM_NETPLAN_REMEDY" ;;
    /run/NetworkManager/*)
      flags="$(nm_dbus "$UPLINK_CONNECTION" Flags | python3 -I "$NET_SETUP_DIR/nm.py" flags)" \
        || net_fail "cannot read the flags of ${UPLINK}'s connection from NetworkManager"
      (( flags & NM_GENERATED )) \
        || refuse NM_PROFILE_IN_RUN "${UPLINK}'s connection is held in $NM_PROFILE_FILE, which something writes again at every boot (an initrd's network configuration, for one), so it would come back beside the bridge: store the connection as a keyfile under /etc/NetworkManager/system-connections and stop what writes it, then run this again."
      NM_PROFILE_FILE="" ;;
    *) refuse NM_PROFILE_STORE "${UPLINK}'s connection is stored in ${NM_PROFILE_FILE:-no file}, where setup cannot keep it to undo its removal: store it as a keyfile under /etc/NetworkManager/system-connections, and run this again." ;;
  esac
  [[ -z "$NM_PROFILE_FILE" ]] || journal_root_ok "$NM_PROFILE_FILE" \
    || refuse NM_PROFILE_STORE "${UPLINK}'s connection is stored in $NM_PROFILE_FILE, where setup cannot keep it to undo its removal: store it as a keyfile under /etc/NetworkManager/system-connections, and run this again."
  [[ ! -L "$NM_PROFILE_FILE" ]] \
    || refuse NM_PROFILE_LINK "${UPLINK}'s connection is stored in $NM_PROFILE_FILE, a symbolic link, which the undo of its removal would bring back as a file: make it the file itself, and run this again."
  nm_others
  NM_BRIDGE_FILE="/etc/NetworkManager/system-connections/${BRIDGE}.nmconnection"
  NM_PORT_FILE="/etc/NetworkManager/system-connections/${BRIDGE}-port-${UPLINK}.nmconnection"
  # The port comes up on the uplink at boot ahead of the uplink's own
  # connection: autoconnect priority above it.
  prio="$(_prop connection.autoconnect-priority)"
  [[ "$prio" =~ ^-?[0-9]+$ ]] || prio=0
  (( prio < 999 )) || refuse NM_PRIORITY "${UPLINK}'s connection has the highest autoconnect priority (999), so no port could come up ahead of it: lower it, and run this again."
  NM_PORT_PRIORITY=$(( prio + 1 > 0 ? prio + 1 : 0 ))
  NM_BRIDGE_UUID="$(cat /proc/sys/kernel/random/uuid)"
  NM_PORT_UUID="$(cat /proc/sys/kernel/random/uuid)"
  case "$(_prop ipv4.method)" in
    auto) UPLINK_MODE=dhcp ;;
    manual) UPLINK_MODE=static ;;
    *) refuse NM_IPV4_METHOD "$UPLINK's connection has IPv4 method '$(_prop ipv4.method)': give it DHCP (auto) or a static address (manual), and run this again." ;;
  esac
  for v in 802-1x.eap connection.master connection.controller; do
    [[ -z "$(_prop "$v")" ]] || net_refuse NM_SETTING "$UPLINK's connection sets $v ($(_prop "$v")), which setup does not carry over to a bridge."
  done
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    uplink_client_id
    if [[ -z "$UPLINK_CLIENT_ID" ]]; then
      # The bridge must send the lease's client identifier to keep the address.
      [[ "$(_prop ipv4.dhcp-client-id)" != none ]] \
        || refuse NM_NO_CLIENT_ID "$UPLINK is on DHCP but sends no client identifier (its connection says ipv4.dhcp-client-id none), which the bridge must send to keep the address: let it send one (nmcli connection modify $UPLINK_CONNECTION ipv4.dhcp-client-id \"\", then nmcli device reapply $UPLINK: a new lease, maybe a new address), and run this again."
      refuse NM_NO_CLIENT_ID "$UPLINK is on DHCP but NetworkManager reports no client identifier for its lease, which the bridge must send to keep the address: renew the lease (nmcli device reapply $UPLINK) and run this again; if it still has none, make the bridge with the host's network tool (setup then uses it)."
    fi
  fi
  # NetworkManager gives a bridge another default route metric than an
  # Ethernet interface: the metric the uplink's routes have is kept.
  routes4="$(net_read ip -4 route show default dev "$UPLINK")" || exit 1
  routes6="$(net_read ip -6 route show default dev "$UPLINK")" || exit 1
  _metric_of() { awk '$1 == "default" && !done { for (i = 1; i < NF; i++) if ($i == "metric") { print $(i + 1); done = 1; break } }' <<<"$1"; }
  metric4="$(_metric_of "$routes4")"
  metric6="$(_metric_of "$routes6")"
  python3 -I "$NET_SETUP_DIR/nm.py" carry "$metric4" "$metric6" "$NET_PLAN_DIR" <<<"$con" \
    || net_fail "cannot sort ${UPLINK}'s connection's settings"
  # The bridge connection: the uplink connection's layer 3 (bridge.carry), the
  # client identifier it sent on DHCP, exactly (NetworkManager takes it as
  # bytes), and its hardware address and MTU. The port connection: no
  # addressing of its own, and the uplink connection's link settings
  # (port.carry). Both connect by themselves from the moment they are added
  # (see the bridge step).
  {
    printf '%s\n' type bridge ifname "$BRIDGE" con-name "$BRIDGE" connection.uuid "$NM_BRIDGE_UUID" \
      bridge.mac-address "$UPLINK_MAC" bridge.stp no connection.autoconnect yes connection.autoconnect-ports true \
      802-3-ethernet.mtu "$UPLINK_MTU"
    cat "$NET_PLAN_DIR/bridge.carry"
    [[ -z "${UPLINK_CLIENT_ID:-}" ]] || printf '%s\n' ipv4.dhcp-client-id "$UPLINK_CLIENT_ID"
  } > "$NET_PLAN_DIR/bridge.args"
  {
    printf '%s\n' type ethernet ifname "$UPLINK" con-name "${BRIDGE}-port-${UPLINK}" connection.uuid "$NM_PORT_UUID" \
      controller "$BRIDGE" port-type bridge connection.autoconnect yes \
      connection.autoconnect-priority "$NM_PORT_PRIORITY"
    cat "$NET_PLAN_DIR/port.carry"
  } > "$NET_PLAN_DIR/port.args"
  # The generated default connection, rendered as a stored one: what the undo
  # of its deletion loads back.
  if [[ -z "$NM_PROFILE_FILE" ]]; then
    { printf '%s\n' type ethernet; cat "$NET_PLAN_DIR/copy.carry"; } > "$NET_PLAN_DIR/uplink.args"
  fi
  # Each rendered as a keyfile and checked by NetworkManager itself, offline
  # (nmcli --offline, NetworkManager 1.40 and later: every supported host's):
  # nothing is added.
  for f in bridge port uplink; do
    [[ -f "$NET_PLAN_DIR/$f.args" ]] || continue
    mapfile -t args < "$NET_PLAN_DIR/$f.args"
    why="$(net_call nmcli --offline connection add "${args[@]}" 2>&1 >"$NET_PLAN_DIR/$f.nmconnection.out")" \
      || net_refuse NM_REJECTS "NetworkManager does not accept the $f connection setup would add: ${why:-nmcli --offline failed}."
    # nmcli before 1.54 prints its warnings (a port's bridge not among the
    # profiles, offline) on stdout, ahead of the keyfile, which starts with
    # its first group.
    awk 'started || /^\[/ { started = 1; print }' "$NET_PLAN_DIR/$f.nmconnection.out" > "$NET_PLAN_DIR/$f.nmconnection" \
      && [[ -s "$NET_PLAN_DIR/$f.nmconnection" ]] \
      || net_fail "nmcli --offline printed no keyfile for the $f connection"
  done
  unset -f _metric_of _prop
}

# sources_networkmanager: what the plan read about the uplink, for the bridge
# step to check is unchanged: the uplink's connection (its row, its settings),
# the connection the uplink runs from, and the other connections' say on it
# (nm_others). Nothing else: setup's own steps between the two (libvirt's
# network stopped, the stub's connection) are not the uplink's.
sources_networkmanager() {
  local out
  out="$(nm_connections)" || return 1
  awk -F'\t' -v u="$UPLINK_CONNECTION" '$1 == u' <<<"$out"
  out="$(net_call nmcli -t -e no connection show "$UPLINK_CONNECTION")" || return 1
  grep -vE '^(GENERAL|IP[46]|DHCP[46])\.|^connection\.timestamp:' <<<"$out" | sha256sum
  net_call nmcli -g GENERAL.CON-UUID device show "$UPLINK" || return 1
  sources_refusals nm_others || return 1
}

apply_networkmanager() {
  put_file "$NM_PORT_FILE" "$NET_PLAN_DIR/port.nmconnection" 0600 || return 1
  put_file "$NM_BRIDGE_FILE" "$NET_PLAN_DIR/bridge.nmconnection" 0600 || return 1
  apply_notice
  net_call nmcli connection load "$NM_BRIDGE_FILE" "$NM_PORT_FILE" \
    || { WHY="NetworkManager did not load $NM_BRIDGE_FILE and $NM_PORT_FILE"; return 1; }
  net_apply nmcli --wait "$NET_APPLY_SEC" connection up "$NM_BRIDGE_UUID" >/dev/null
}
check_networkmanager() {
  local link want got
  for link in "$BRIDGE" "$UPLINK"; do
    want="$NM_BRIDGE_UUID"
    [[ "$link" == "$UPLINK" ]] && want="$NM_PORT_UUID"
    got="$(net_call nmcli -g GENERAL.CON-UUID device show "$link" 2>/dev/null || true)"
    if [[ "$got" != "$want" ]]; then
      CHECK_WHY="NetworkManager runs $link from the connection '${got}', not $want"
      return 1
    fi
  done
}
# finish_networkmanager: the step's last change, by the step once its check
# passed, or by a later run that found the step finished but for this. What is
# journalled already is not again; a connection already gone is not deleted.
finish_networkmanager() {
  local has
  _journal_read || { WHY="cannot read the journal"; return 1; }
  if [[ "$J_FINISH" == no ]]; then
    journal_finish || { WHY="cannot write the journal"; return 1; }
  fi
  if [[ -n "${NM_PROFILE_FILE:-}" ]] && ! _journal_has_file "$NM_PROFILE_FILE"; then
    journal_file "$NM_PROFILE_FILE" - || { WHY="cannot write the journal for $NM_PROFILE_FILE"; return 1; }
  fi
  if (( ${#J_CONNRM[@]} == 0 )); then
    journal_connrm "$UPLINK_CONNECTION" || { WHY="cannot write the journal"; return 1; }
  fi
  has=0; nm_has "$UPLINK_CONNECTION" || has=$?
  case $has in
    0) net_call nmcli connection delete "$UPLINK_CONNECTION" >/dev/null \
         || { WHY="NetworkManager did not delete ${UPLINK}'s former connection $UPLINK_CONNECTION"; return 1; } ;;
    1) ;;
    *) WHY="NetworkManager cannot be asked about ${UPLINK}'s former connection $UPLINK_CONNECTION"; return 1 ;;
  esac
  changed "NetworkManager connection $UPLINK_CONNECTION deleted: ${UPLINK}'s former one, now held by $BRIDGE and its port"
}

# undo_networkmanager <nm files restored: yes|no> <netplan's 90-NM file
# restored: yes|no>: in journal_restore, once the files are back. The step's
# connections go with their files, and the uplink's own comes back with its file
# (netplan's, generated); then it is brought up. The default connection
# NetworkManager had generated, which the step deleted, comes back as the stored
# connection rendered from it in the plan (uplink.nmconnection) — what
# NetworkManager itself makes of it once an operator edits it; RESTORE_STORED
# names it, also when an earlier undo of this journal loaded it.
undo_networkmanager() {
  local has state stored="/etc/NetworkManager/system-connections/$UPLINK_CONNECTION.nmconnection"
  if [[ "$2" == yes ]]; then
    net_call netplan generate || return 1
  fi
  if [[ "$1" == yes ]]; then
    net_call nmcli connection reload || return 1
  fi
  has=0; nm_has "$UPLINK_CONNECTION" || has=$?
  (( has <= 1 )) || return 1
  if (( has == 1 )); then
    [[ -s "$JOURNAL_DIR/uplink.nmconnection" ]] || return 1
    install_file "$stored" "$JOURNAL_DIR/uplink.nmconnection" 0600 || return 1
    net_call nmcli connection load "$stored" || return 1
    RESTORE_STORED="$stored"
  elif [[ -z "${NM_PROFILE_FILE:-}" && -s "$JOURNAL_DIR/uplink.nmconnection" ]] \
    && cmp -s "$stored" "$JOURNAL_DIR/uplink.nmconnection"; then
    RESTORE_STORED="$stored"
  fi
  state="$(net_call nmcli -g GENERAL.STATE connection show "$UPLINK_CONNECTION")" || return 1
  if [[ "$state" != activated ]]; then
    net_apply nmcli --wait "$NET_APPLY_SEC" connection up "$UPLINK_CONNECTION" >/dev/null || return 1
  fi
}
