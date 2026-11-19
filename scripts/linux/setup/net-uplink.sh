# Sourced by network-plan.sh, as root; do not execute it. The uplink and the
# tool that runs it, asked of the daemons, and the refusals every tool shares.
# Changes nothing.

# The container DNS stub's refusal, and its names.
# shellcheck source=container-dns-plan.sh
source "$(dirname "${BASH_SOURCE[0]}")/container-dns-plan.sh"

# net_refuse <CODE> <what was found>: an uplink setup cannot bridge (refuse,
# lib.sh), with the one remedy all of them share.
net_refuse() {
  refuse "$1" "$2" \
    "Setup makes Wisp's bridge on a plain Ethernet uplink, on DHCP or with a static" \
    "address, run by netplan, NetworkManager or systemd-networkd. Make the bridge on" \
    "this host's uplink with its own network tool and run this again: setup then" \
    "uses that bridge."
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

# detect_uplink: UPLINK, the default route's interface, its UPLINK_ADDR, and
# NET_TOOL, the tool that runs it. systemd-networkd names the file it runs a
# link from (netplan renders its own under /run: UPLINK_NETFILE);
# NetworkManager reports the link connected.
detect_uplink() {
  local route addrs json status
  route="$(net_read ip -4 route show default)" || exit 1
  UPLINK="$(awk '!done { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); done = 1; break } }' <<<"$route")"
  [[ -n "$UPLINK" ]] || refuse NO_DEFAULT_ROUTE "this host has no IPv4 default route, so no uplink to bridge: give it one, and run this again."
  addrs="$(net_read ip -4 -o addr show dev "$UPLINK" scope global)" || exit 1
  UPLINK_ADDR="$(awk '!done { print $4; done = 1 }' <<<"$addrs")"

  NET_TOOL=""
  UPLINK_NETFILE=""
  if systemctl is-active --quiet systemd-networkd; then
    json="$(net_read networkctl status "$UPLINK" --json=short)" || exit 1
    UPLINK_NETFILE="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/networkd.py" json NetworkFile <<<"$json")" \
      || net_fail "cannot read systemd-networkd's status of $UPLINK"
    case "$UPLINK_NETFILE" in
      /run/systemd/network/10-netplan-*) NET_TOOL=netplan ;;
      /*) NET_TOOL=networkd ;;
    esac
  fi
  if [[ -z "$NET_TOOL" ]] && systemctl is-active --quiet NetworkManager; then
    status="$(net_read nmcli -g GENERAL.STATE device show "$UPLINK")" || exit 1
    # "100 (connected)": through one of NetworkManager's profiles, not merely
    # seen configured by something else ("connected (externally)").
    case "$status" in
      "100 (connected)") NET_TOOL=networkmanager ;;
      100*) refuse TOOL_EXTERNAL "$UPLINK is up, but not through a NetworkManager profile ($status): run it with netplan, NetworkManager or systemd-networkd, and run this again." ;;
    esac
  fi
  if [[ -z "$NET_TOOL" ]] && grep -qsE "^[[:space:]]*iface[[:space:]]+$UPLINK([[:space:]]|$)" /etc/network/interfaces /etc/network/interfaces.d/*; then
    refuse TOOL_IFUPDOWN "$UPLINK is run by ifupdown (/etc/network/interfaces), which setup does not configure: run it with netplan, NetworkManager or systemd-networkd, and run this again."
  fi
  [[ -n "$NET_TOOL" ]] || refuse TOOL_NONE "$UPLINK is run by none of netplan, NetworkManager or systemd-networkd: run it with one of them, and run this again."
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

# refuse_no_python: the plan reads the tools' configuration and their JSON with
# python3, the one thing it needs that the packages step does not install
# first (netplan and cloud-init run on it too).
refuse_no_python() {
  command -v python3 >/dev/null \
    || refuse PYTHON_MISSING "setup reads the network's configuration with python3, which this host does not have: install it (apt install python3), and run this again."
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
    || refuse BRIDGE_NAME_TAKEN "$BRIDGE exists but does not carry the uplink $UPLINK; Wisp would bridge $UPLINK as $BRIDGE: remove $BRIDGE, or make it the bridge on $UPLINK with the host's network tool, and run this again."
  [[ -n "$UPLINK_ADDR" ]] || refuse UPLINK_NO_IPV4 "the uplink $UPLINK has no IPv4 address, which the bridge would keep: give it one, and run this again."
  UPLINK_MAC="$(cat "/sys/class/net/$UPLINK/address")"
  UPLINK_MTU="$(cat "/sys/class/net/$UPLINK/mtu")"
  # The permanent hardware address, which a cloned current one hides: each
  # tool matches a definition by either (link.py).
  local out
  out="$(net_read ip -j -d link show dev "$UPLINK")" || exit 1
  UPLINK_PERMADDR="$("${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/link.py" permaddr <<<"$out")" \
    || net_fail "cannot read ${UPLINK}'s permanent hardware address"
}

# uplink_client_id: UPLINK_CLIENT_ID, the uplink's DHCPv4 client identifier
# (net-state.sh, client_id), empty without a lease.
uplink_client_id() {
  local rc=0 record what
  UPLINK_CLIENT_ID="$(client_id "$UPLINK" "$NET_TOOL")" || rc=$?
  case $rc in
    0) ;;
    2|3)
      record="/run/systemd/netif/leases/$(cat "/sys/class/net/$UPLINK/ifindex" 2>/dev/null || echo '<ifindex>')"
      what="its record of the lease ($record) is missing"
      (( rc == 2 )) || what="its record of the lease ($record) has no CLIENTID="
      refuse DHCP_LEASE_RECORD "systemd-networkd holds a DHCP lease on $UPLINK, but $what: setup reads the client identifier there on systemd $SYSTEMD_VERSION (networkctl's JSON has it from 257 on). Renew the lease (networkctl renew $UPLINK), and run this again." ;;
    *) net_fail "cannot read ${UPLINK}'s DHCP lease from $NET_TOOL" ;;
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
        DHCP_ID_REFUSAL="DHCP_CLIENT_ID_TYPE $UPLINK's DHCPv4 client identifier $UPLINK_CLIENT_ID is too short for a DUID, which setup does not carry over: make the bridge on $UPLINK with the host's network tool, and run this again (setup then uses it)."
      fi ;;
    "") DHCP_ID_REFUSAL="DHCP_NO_LEASE $UPLINK is on DHCP but has no lease, whose identity the bridge must keep: let it get one (networkctl renew $UPLINK), and run this again." ;;
    *) DHCP_ID_REFUSAL="DHCP_CLIENT_ID_TYPE $UPLINK's DHCPv4 client identifier is of type 0x$type, which setup does not carry over: make the bridge on $UPLINK with the host's network tool, and run this again (setup then uses it)." ;;
  esac
}
refuse_dhcp_identity() {
  [[ -z "$DHCP_ID_REFUSAL" ]] || refuse "${DHCP_ID_REFUSAL%% *}" "${DHCP_ID_REFUSAL#* }"
}
# dhcp_identity_networkd: systemd-networkd's settings for it, which the bridge's
# definition (networkd) or a drop-in on netplan's unit for it (netplan, which
# has no IAID key) carries.
dhcp_identity_networkd() {
  printf '[DHCPv4]\nClientIdentifier=%s\n' "$DHCP_ID_KIND"
  [[ -z "$DHCP_IAID" ]] || printf 'IAID=%s\n\n[DHCPv6]\nIAID=%s\n' "$DHCP_IAID" "$DHCP_IAID"
}

# plan_sources: what the plan read, for the bridge step to check nothing of it
# changed since: the default route, the uplink's addresses, hardware address
# and MTU, cloud-init's say over the network, and what the tool's plan read
# (sources_<tool>). The container DNS stub, which setup declares between the
# plan and the bridge step, is not among them.
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
plan_sources() {
  local out
  out="$(net_call ip -4 route show default)" || return 1
  echo "route $out"
  out="$(net_call ip -4 -o addr show dev "$UPLINK" scope global)" || return 1
  awk 'NF { print "addr " $4 }' <<<"$out"
  local mac mtu
  mac="$(cat "/sys/class/net/$UPLINK/address")" && mtu="$(cat "/sys/class/net/$UPLINK/mtu")" || return 1
  echo "link $mac mtu $mtu"
  out="$(cloud_init_network)" || return 1
  echo "cloud-init $out"
  "sources_$NET_TOOL"
}
