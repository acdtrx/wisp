# Sourced by network-plan.sh, as root; do not execute it. The uplink and the
# tool that runs it, asked of the daemons, and the refusals every tool shares.
# Changes nothing.

net_refuse() {
  echo "ERROR: $*" >&2
  echo "       Setup makes Wisp's bridge on a plain Ethernet uplink, on DHCP or with a static" >&2
  echo "       address, run by netplan, NetworkManager or systemd-networkd. Make the bridge on" >&2
  echo "       this host's uplink with its own network tool and run this again: setup then" >&2
  echo "       uses that bridge." >&2
  exit 1
}
# A network tool that fails is a failure, never a refusal. Used as
# `v="$(net_read …)" || exit 1`: the failure is reported from the subshell.
net_fail() {
  echo "ERROR: $*" >&2
  exit 1
}
net_read() {
  local rc=0
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" "$@" || rc=$?
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
  [[ -n "$UPLINK" ]] || net_refuse "this host has no IPv4 default route, so no uplink to bridge."
  addrs="$(net_read ip -4 -o addr show dev "$UPLINK" scope global)" || exit 1
  UPLINK_ADDR="$(awk '!done { print $4; done = 1 }' <<<"$addrs")"

  NET_TOOL=""
  UPLINK_NETFILE=""
  if systemctl is-active --quiet systemd-networkd; then
    json="$(net_read networkctl status "$UPLINK" --json=short)" || exit 1
    UPLINK_NETFILE="$(json_string "$json" NetworkFile || true)"
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
      100*) net_refuse "$UPLINK is up, but not through a NetworkManager profile ($status)." ;;
    esac
  fi
  if [[ -z "$NET_TOOL" ]] && grep -qsE "^[[:space:]]*iface[[:space:]]+$UPLINK([[:space:]]|$)" /etc/network/interfaces /etc/network/interfaces.d/*; then
    net_refuse "$UPLINK is run by ifupdown (/etc/network/interfaces), which setup does not configure."
  fi
  [[ -n "$NET_TOOL" ]] || net_refuse "$UPLINK is run by none of netplan, NetworkManager or systemd-networkd."
}

# cloud-init managing the network: setup never edits what cloud-init writes
# nor changes cloud-init's own configuration, so such a host is refused. It
# manages the network when it is installed, not switched off as a whole
# (/etc/cloud/cloud-init.disabled, cloud-init=disabled on the kernel command
# line), and its merged configuration (cloud-init-network.py) does not say
# `network: {config: disabled}` — nor network-config=disabled on the command
# line. An installer that writes the host's own netplan file (Ubuntu Server's)
# switches it off that way.
refuse_cloud_init_network() {
  local ci
  if command -v cloud-init >/dev/null && [[ ! -e /etc/cloud/cloud-init.disabled ]] \
    && ! grep -qwE 'cloud-init=disabled|network-config=disabled' /proc/cmdline; then
    ci="$(python3 -I "$NET_SETUP_DIR/cloud-init-network.py")" || net_fail "cannot read cloud-init's configuration in /etc/cloud"
    if [[ "$ci" != off:* ]]; then
      echo "ERROR: cloud-init manages this host's network, and setup does not edit what cloud-init writes." >&2
      echo "       Switch its networking off with the one documented line, network: {config: disabled}," >&2
      echo "       in a file under /etc/cloud/cloud.cfg.d/ (for example 99-disable-network-config.cfg)," >&2
      echo "       keep the network's definition as a file of your own, and run this again." >&2
      exit 1
    fi
  fi
}

# refuse_uplink_shape: what setup can bridge is a plain physical Ethernet
# interface with an IPv4 address, and no other device already named BRIDGE.
# Sets UPLINK_MAC and UPLINK_MTU, which the bridge takes.
refuse_uplink_shape() {
  refuse_cloud_init_network
  [[ ! -d "/sys/class/net/$UPLINK/bonding" ]] || net_refuse "the uplink $UPLINK is a bond."
  [[ ! -d "/sys/class/net/$UPLINK/wireless" ]] || net_refuse "the uplink $UPLINK is a Wi-Fi interface."
  [[ ! -e "/proc/net/vlan/$UPLINK" ]] || net_refuse "the uplink $UPLINK is a VLAN."
  [[ -e "/sys/class/net/$UPLINK/device" && "$(cat "/sys/class/net/$UPLINK/type")" == 1 ]] \
    || net_refuse "the uplink $UPLINK is not a physical Ethernet interface."
  [[ ! -e "/sys/class/net/$BRIDGE" ]] \
    || net_refuse "$BRIDGE exists but does not carry the uplink $UPLINK; Wisp would bridge $UPLINK as $BRIDGE."
  [[ -n "$UPLINK_ADDR" ]] || net_refuse "the uplink $UPLINK has no IPv4 address."
  UPLINK_MAC="$(cat "/sys/class/net/$UPLINK/address")"
  UPLINK_MTU="$(cat "/sys/class/net/$UPLINK/mtu")"
}
