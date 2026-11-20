# Sourced by network-plan.sh, the bridge step and the journal, as root; do not
# execute it. The network plan's reads and refusals: the uplink, whether netplan
# runs it, the bridge worked out as edits of the operator's netplan file and
# checked by netplan, and what the plan read (plan_sources). Changes nothing.
#
# A Wisp host's network is run by netplan, rendered by systemd-networkd: a host
# whose uplink another tool runs is refused, bridge or not. Setup makes the
# bridge only for the uplink shape it can do completely and verify: a plain
# Ethernet interface, on DHCP or with a static address, with exactly one
# definition, its own. Its whole layer 3 moves to the bridge and leaves the
# interface, in the operator's own netplan file, edited with `netplan set`; its
# link settings stay on it. Every other shape, and every key setup neither
# moves nor keeps, is refused, naming what was found.

# shellcheck source=net-state.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-state.sh"
# The container DNS stub's refusal, and its names.
# shellcheck source=container-dns-plan.sh
source "$(dirname "${BASH_SOURCE[0]}")/container-dns-plan.sh"

# Where netplan reads its YAML from (netplan.py reads the same, given them).
NETPLAN_DIRS=(/lib/netplan /etc/netplan /run/netplan)

# net_refuse <CODE> <what was found>: an uplink setup cannot bridge (refuse,
# lib.sh), with the one remedy all of them share.
net_refuse() {
  refuse "$1" "$2" \
    "Setup makes Wisp's bridge on a plain Ethernet uplink, on DHCP or with a static" \
    "address, defined in netplan. Make the bridge on this host's uplink with netplan" \
    "and run this again: setup then uses that bridge."
}
# A network tool that fails is a failure, never a refusal. Used as
# `v="$(net_read …)" || exit 1`: the failure is reported from the subshell.
net_fail() {
  echo "ERROR: $*" >&2
  exit 1
}
net_read() {
  local rc=0
  net_call "$@" || rc=$?
  (( rc == 0 )) || net_fail "'$*' failed (exit $rc)"
}

# detect_uplink: UPLINK, the default route's interface, and its UPLINK_ADDR;
# refused unless netplan, rendered by systemd-networkd, runs it: netplan is
# installed and networkd runs the uplink from the unit netplan renders for it
# (UPLINK_NETFILE). No Python runs before netplan is known to be there: netplan
# brings python3 with it, a host without netplan may have none.
detect_uplink() {
  local route addrs
  route="$(net_read ip -4 route show default)" || exit 1
  UPLINK="$(awk '!done { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); done = 1; break } }' <<<"$route")"
  [[ -n "$UPLINK" ]] || refuse NO_DEFAULT_ROUTE "this host has no IPv4 default route, so no uplink to bridge: give it one, and run this again."
  addrs="$(net_read ip -4 -o addr show dev "$UPLINK" scope global)" || exit 1
  UPLINK_ADDR="$(awk '!done { print $4; done = 1 }' <<<"$addrs")"

  UPLINK_NETFILE=""
  if command -v netplan >/dev/null && systemctl is-active --quiet systemd-networkd; then
    UPLINK_NETFILE="$(networkd_json "$UPLINK" NetworkFile)" || net_fail "cannot read systemd-networkd's status of $UPLINK"
    [[ "$UPLINK_NETFILE" != /run/systemd/network/10-netplan-* ]] || return 0
  fi
  refuse UPLINK_NOT_NETPLAN "netplan, rendered by systemd-networkd, does not run the uplink $UPLINK: $(uplink_runner)." \
    "Wisp runs where netplan runs the network, rendered by systemd-networkd. Nothing in the network was changed." \
    "Run the uplink with netplan, rendered by systemd-networkd (renderer networkd), and run this again." \
    "On a host Wisp runs on already, an update stops here and rolls back: Wisp stays on its current release" \
    "until netplan (renderer networkd) runs this host's network."
}
# uplink_runner: what runs the uplink, as far as setup can tell, for the
# refusal's message only.
uplink_runner() {
  local state
  if [[ -n "$UPLINK_NETFILE" ]]; then
    echo "systemd-networkd runs it from $UPLINK_NETFILE, a file of its own"
    return 0
  fi
  # NetworkManager runs it when it reports the device connected through one of
  # its profiles ("100 (connected)"), netplan's among them.
  if systemctl is-active --quiet NetworkManager; then
    state="$(net_call nmcli -g GENERAL.STATE device show "$UPLINK" 2>/dev/null || true)"
    [[ "$state" != "100 (connected)" ]] || { echo "NetworkManager runs it"; return 0; }
  fi
  if grep -qsE "^[[:space:]]*iface[[:space:]]+$UPLINK([[:space:]]|$)" /etc/network/interfaces /etc/network/interfaces.d/*; then
    echo "ifupdown runs it (/etc/network/interfaces)"
    return 0
  fi
  if systemctl is-active --quiet systemd-networkd && ! command -v netplan >/dev/null; then
    echo "systemd-networkd runs this host's network, and netplan is not installed"
    return 0
  fi
  echo "setup cannot tell what runs it"
}

# cloud-init managing the network: setup never edits what cloud-init writes
# nor changes cloud-init's own configuration, so such a host is refused. It
# manages the network when it is installed, not switched off as a whole
# (/etc/cloud/cloud-init.disabled, cloud-init=disabled on the kernel command
# line), and its merged configuration (cloud-init-network.py) does not say
# `network: {config: disabled}` — nor network-config=disabled on the command
# line. An installer that writes the host's own netplan file (Ubuntu Server's)
# switches it off that way.
#
# cloud_init_network: prints absent, disabled, off:<file> or managed.
cloud_init_network() {
  if ! command -v cloud-init >/dev/null; then echo absent; return 0; fi
  if [[ -e /etc/cloud/cloud-init.disabled ]] || grep -qwE 'cloud-init=disabled|network-config=disabled' /proc/cmdline; then
    echo disabled; return 0
  fi
  "${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/cloud-init-network.py"
}
refuse_cloud_init_network() {
  local ci
  ci="$(cloud_init_network)" || net_fail "cannot read cloud-init's configuration in /etc/cloud"
  [[ "$ci" == managed ]] || return 0
  refuse CLOUD_INIT_NETWORK "cloud-init manages this host's network, and setup does not edit what cloud-init writes." \
    "Switch its networking off with the one documented line, network: {config: disabled}, in a file" \
    "under /etc/cloud/cloud.cfg.d/ (for example 99-disable-network-config.cfg), and run this again:" \
    "the network file cloud-init wrote is then yours, and setup edits it like any other."
}

# refuse_uplink_shape: what setup can bridge is a plain physical Ethernet
# interface with an IPv4 address, and no other device already named BRIDGE.
# Sets UPLINK_MAC and UPLINK_MTU, which the bridge takes.
refuse_uplink_shape() {
  refuse_cloud_init_network
  [[ ! -d "/sys/class/net/$UPLINK/bonding" ]] || net_refuse UPLINK_BOND "the uplink $UPLINK is a bond."
  [[ ! -d "/sys/class/net/$UPLINK/wireless" ]] || net_refuse UPLINK_WIFI "the uplink $UPLINK is a Wi-Fi interface."
  [[ ! -e "/proc/net/vlan/$UPLINK" ]] || net_refuse UPLINK_VLAN "the uplink $UPLINK is a VLAN."
  [[ -e "/sys/class/net/$UPLINK/device" && "$(cat "/sys/class/net/$UPLINK/type")" == 1 ]] \
    || net_refuse UPLINK_NOT_ETHERNET "the uplink $UPLINK is not a physical Ethernet interface."
  [[ ! -e "/sys/class/net/$BRIDGE" ]] \
    || refuse BRIDGE_NAME_TAKEN "$BRIDGE exists but does not carry the uplink $UPLINK; Wisp would bridge $UPLINK as $BRIDGE: remove $BRIDGE, or make it the bridge on $UPLINK with netplan, and run this again."
  [[ -n "$UPLINK_ADDR" ]] || refuse UPLINK_NO_IPV4 "the uplink $UPLINK has no IPv4 address, which the bridge would keep: give it one, and run this again."
  UPLINK_MAC="$(cat "/sys/class/net/$UPLINK/address")"
  UPLINK_MTU="$(cat "/sys/class/net/$UPLINK/mtu")"
  # The permanent hardware address, which a cloned current one hides: a
  # .network file can match the uplink by it (link.py).
  local out
  out="$(net_read ip -j -d link show dev "$UPLINK")" || exit 1
  UPLINK_PERMADDR="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/link.py" permaddr <<<"$out")" \
    || net_fail "cannot read ${UPLINK}'s permanent hardware address"
}

# uplink_client_id: UPLINK_CLIENT_ID, the uplink's DHCPv4 client identifier
# (net-state.sh, client_id), empty without a lease.
uplink_client_id() {
  local rc=0 record what
  UPLINK_CLIENT_ID="$(client_id "$UPLINK")" || rc=$?
  case $rc in
    0) ;;
    2|3)
      record="/run/systemd/netif/leases/$(cat "/sys/class/net/$UPLINK/ifindex" 2>/dev/null || echo '<ifindex>')"
      what="its record of the lease ($record) is missing"
      (( rc == 2 )) || what="its record of the lease ($record) has no CLIENTID="
      refuse DHCP_LEASE_RECORD "systemd-networkd holds a DHCP lease on $UPLINK, but $what: setup reads the client identifier there on systemd $SYSTEMD_VERSION (networkctl's JSON has it from 257 on). Renew the lease (networkctl renew $UPLINK), and run this again." ;;
    *) net_fail "cannot read ${UPLINK}'s DHCP lease from systemd-networkd" ;;
  esac
}

# dhcp_identity: the DHCP identity the uplink's lease shows (UPLINK_CLIENT_ID),
# which the bridge must send to get the same lease, in the terms netplan and
# systemd-networkd set it: DHCP_ID_KIND mac (a type-1 client identifier: the
# hardware address, which the bridge takes) or duid (type 255: networkd's
# DUID, with DHCP_IAID, the IAID networkd derived from the uplink's name, which
# the bridge would not). Anything else sets DHCP_ID_REFUSAL instead, which
# refuse_dhcp_identity refuses once the uplink is known to be on DHCP.
dhcp_identity() {
  local type a b c d bytes
  DHCP_ID_KIND="" DHCP_IAID="" DHCP_ID_REFUSAL=""
  type="${UPLINK_CLIENT_ID%%:*}"
  IFS=: read -r -a bytes <<<"$UPLINK_CLIENT_ID"
  case "$type" in
    01) DHCP_ID_KIND=mac ;;
    ff)
      if (( ${#bytes[@]} > 5 )); then
        a="${bytes[1]}" b="${bytes[2]}" c="${bytes[3]}" d="${bytes[4]}"
        DHCP_ID_KIND=duid DHCP_IAID=$((16#$a$b$c$d))
      else
        DHCP_ID_REFUSAL="DHCP_CLIENT_ID_TYPE $UPLINK's DHCPv4 client identifier $UPLINK_CLIENT_ID is too short for a DUID, which setup does not carry over: make the bridge on $UPLINK with netplan, and run this again (setup then uses it)."
      fi ;;
    "") DHCP_ID_REFUSAL="DHCP_NO_LEASE $UPLINK is on DHCP but has no lease, whose identity the bridge must keep: let it get one (networkctl renew $UPLINK), and run this again." ;;
    *) DHCP_ID_REFUSAL="DHCP_CLIENT_ID_TYPE $UPLINK's DHCPv4 client identifier is of type 0x$type, which setup does not carry over: make the bridge on $UPLINK with netplan, and run this again (setup then uses it)." ;;
  esac
}
refuse_dhcp_identity() {
  [[ -z "$DHCP_ID_REFUSAL" ]] || refuse "${DHCP_ID_REFUSAL%% *}" "${DHCP_ID_REFUSAL#* }"
}

# networkd_takers <own-file>: refused when another .network file, beside the
# one netplan renders for the uplink, could take it (networkd.py): setup leaves
# exactly one definition for it.
networkd_takers() {
  local driver takers
  driver="$(basename "$(readlink "/sys/class/net/$UPLINK/device/driver" 2>/dev/null)" 2>/dev/null || true)"
  takers="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/networkd.py" takers "$UPLINK" "$UPLINK_MAC" "${UPLINK_PERMADDR:-}" "$driver" "$1")" \
    || net_fail "cannot read systemd-networkd's files"
  [[ -z "$takers" ]] \
    || refuse NETWORKD_SECOND_FILE "systemd-networkd could take the uplink $UPLINK from $(echo $takers) too, beside netplan's $1: setup leaves exactly one definition for it. Make that file match only other interfaces, or remove it, and run this again."
  printf '%s\n' "takers none"
}

# plan_bridge: the operator's file that defines the uplink, edited with
# `netplan set` in a staged copy of /lib, /etc and /run/netplan and checked
# whole by netplan (netplan.py does the reading); what was checked is kept in
# the plan's directory as netplan-origin.yaml, the file the bridge step puts in
# place. For a DUID identity, also networkd's drop-in on the unit netplan
# renders for the bridge (netplan has no IAID key): 50-wisp-dhcp-identity.conf.
plan_bridge() {
  local status def mode rc why stage d f hint kv merged dropins
  status="$(net_read netplan status "$UPLINK" --format json)" || exit 1
  UPLINK_NETPLAN_ID="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/netplan.py" status-id "$UPLINK" <<<"$status")" \
    || net_fail "cannot read netplan's status for $UPLINK"
  [[ -n "$UPLINK_NETPLAN_ID" ]] || refuse NETPLAN_NO_DEFINITION "netplan has no definition for the uplink $UPLINK: define it in a file of your own under /etc/netplan, and run this again."
  # The file the definition comes from, as netplan's parser reads it.
  NETPLAN_ORIGIN="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" "${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/netplan.py" origin "$UPLINK_NETPLAN_ID")" \
    || net_fail "netplan cannot parse its configuration"
  [[ "$NETPLAN_ORIGIN" == /etc/netplan/*.yaml ]] \
    || refuse NETPLAN_OUTSIDE_ETC "netplan defines $UPLINK in $NETPLAN_ORIGIN, outside /etc/netplan, where setup cannot edit it: define it in a file of your own under /etc/netplan, and run this again."
  [[ ! -L "$NETPLAN_ORIGIN" ]] \
    || refuse NETPLAN_LINK_FILE "netplan defines $UPLINK in $NETPLAN_ORIGIN, a symbolic link, which setup would replace with a file: make it the file itself, and run this again."
  # A networkd drop-in on the unit netplan renders for the uplink would stay
  # with the port, its settings neither moved nor kept by setup's rule.
  dropins="$(networkd_json "$UPLINK" NetworkFileDropins)" || net_fail "cannot read systemd-networkd's status of $UPLINK"
  [[ -z "$dropins" ]] \
    || refuse NETPLAN_DROPINS "systemd-networkd runs $UPLINK from netplan's $UPLINK_NETFILE with drop-ins ($(echo $dropins)): put their settings in the netplan definition, and run this again."
  networkd_takers "$UPLINK_NETFILE" >/dev/null
  uplink_client_id
  dhcp_identity
  why="$(net_read netplan get | "${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/netplan.py" dependents "$UPLINK_NETPLAN_ID")" \
    || net_fail "cannot read netplan's configuration"
  [[ -z "$why" ]] || net_refuse UPLINK_DEPENDENT "netplan's $(echo $why) hangs off or holds $UPLINK's definition."
  def="$NET_PLAN_DIR/uplink.yaml"
  net_read netplan get "ethernets.$UPLINK_NETPLAN_ID" > "$def" || exit 1
  # The uplink's definition, checked; what moves to the bridge worked out; the
  # edits written as `netplan set` arguments (one per line: the origin hint, a
  # tab, key=value), all in the operator's file that defines the uplink: its
  # layer-3 keys removed, and the bridge defined with them.
  mode="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/netplan.py" plan "$def" "$UPLINK_NETPLAN_ID" "$UPLINK" "$UPLINK_MAC" "$BRIDGE" \
    "$DHCP_ID_KIND" "$NETPLAN_ORIGIN" "$NET_PLAN_DIR" "$UPLINK_MTU")" \
    || { rc=$?; case $rc in
           3) net_refuse NETPLAN_SETTING "$mode." ;;
           5) refuse NETPLAN_SETTING "$mode; then run this again." ;;
         esac; net_fail "cannot work out the bridge for netplan: $mode"; }
  UPLINK_MODE="$mode"
  # For a DUID identity, the IAID: networkd's drop-in on the unit netplan
  # renders for the bridge pins it.
  if [[ "$UPLINK_MODE" == dhcp ]]; then
    refuse_dhcp_identity
    if [[ -n "$DHCP_IAID" ]]; then
      {
        echo "# Written by Wisp setup: $BRIDGE keeps the DHCP identity $UPLINK had"
        echo "# (DUID with IAID $DHCP_IAID), so the DHCP server hands it the same lease."
        printf '[DHCPv4]\nClientIdentifier=%s\nIAID=%s\n\n[DHCPv6]\nIAID=%s\n' "$DHCP_ID_KIND" "$DHCP_IAID" "$DHCP_IAID"
      } > "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf"
    fi
  fi
  why="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/netplan.py" shared "$NETPLAN_ORIGIN" "${NETPLAN_DIRS[@]}")" || net_fail "cannot read netplan's files"
  [[ -z "$why" ]] || net_refuse NETPLAN_SHARED "$why; setup would write that definition back merged."
  # The edits made in a staged copy of /etc/netplan, generated, and the merged
  # definitions read back: the interface must keep no layer 3, the bridge must
  # be what setup wrote.
  stage="$NET_PLAN_DIR/stage"
  for d in "${NETPLAN_DIRS[@]}"; do
    [[ ! -d "$d" ]] && continue
    mkdir -p "$stage$(dirname "$d")" && cp -a "$d" "$stage$d" || net_fail "cannot stage $d"
  done
  while IFS=$'\t' read -r hint kv; do
    net_read netplan set --root-dir "$stage" --origin-hint "$hint" "$kv" || exit 1
  done < "$NET_PLAN_DIR/netplan-set.args"
  # netplan set touches the origin file alone: every other file in the stage
  # must still be its live one, and none new, so what is checked is what goes
  # live.
  for d in "${NETPLAN_DIRS[@]}"; do
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
  why="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/netplan.py" merged "$UPLINK_NETPLAN_ID" "$BRIDGE" \
    "$(awk -F'\t' -v k="bridges.$BRIDGE=" 'index($2, k) == 1 { print substr($2, length(k) + 1) }' "$NET_PLAN_DIR/netplan-set.args")" <<<"$merged")" \
    || net_fail "cannot read the staged netplan configuration back"
  [[ -z "$why" ]] || net_refuse NETPLAN_MERGED "with setup's edits, netplan's merged configuration is not what setup wrote: $why."
  # The DUID drop-in attaches to the unit netplan renders for the bridge.
  if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" && ! -f "$stage/run/systemd/network/10-netplan-$BRIDGE.network" ]]; then
    net_refuse NETPLAN_NO_BRIDGE_UNIT "netplan renders no 10-netplan-$BRIDGE.network, which the drop-in that keeps the DHCP identity attaches to."
  fi
  # What was checked is what goes live: the edited file, as the stage holds it.
  cp -a "$stage$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" || net_fail "cannot keep the checked $NETPLAN_ORIGIN"
  rm -rf "$stage"
}

# sources_refusals <cmd...>: what a check of the plan's says now, for the
# sources: its refusal (ERROR CODE: …) is part of the text compared, a
# refusal now being a change since the plan; its failure (net_fail's
# "ERROR: …") fails the read.
sources_refusals() {
  local out
  out="$( ( "$@" ) 2>&1 )" || true
  if grep -q '^ERROR: ' <<<"$out"; then printf '%s\n' "$out" >&2; return 1; fi
  printf '%s\n' "$out"
}
# plan_sources: what the plan read, for the bridge step to check nothing of it
# changed since: the default route, the uplink's addresses, hardware address
# and MTU, cloud-init's say over the network, netplan's files by checksum, the
# file networkd runs the uplink from, and who else could take it. Not among
# them: the container DNS stub's own netplan file, which setup writes between
# the plan and the bridge step; and what netplan renders under /run, which
# follows from netplan's files (a netplan.io upgrade in the packages step
# renders it again).
plan_sources() {
  local out mac mtu d file dropins
  out="$(net_call ip -4 route show default)" || return 1
  echo "route $out"
  out="$(net_call ip -4 -o addr show dev "$UPLINK" scope global)" || return 1
  awk 'NF { print "addr " $4 }' <<<"$out"
  mac="$(cat "/sys/class/net/$UPLINK/address")" && mtu="$(cat "/sys/class/net/$UPLINK/mtu")" || return 1
  echo "link $mac mtu $mtu"
  out="$(cloud_init_network)" || return 1
  echo "cloud-init $out"
  for d in "${NETPLAN_DIRS[@]}"; do
    [[ -d "$d" ]] || continue
    find "$d" -type f ! -path "$DNS_STUB_NETPLAN_FILE" -print0 | sort -z | xargs -0 -r sha256sum || return 1
  done
  file="$(networkd_json "$UPLINK" NetworkFile)" || return 1
  dropins="$(networkd_json "$UPLINK" NetworkFileDropins)" || return 1
  echo "runs-from $file $dropins"
  sources_refusals networkd_takers "$UPLINK_NETFILE" || return 1
}
