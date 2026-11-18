# Sourced by setup and the installer; do not execute it. Works out, changing
# nothing, how this host's network is run and which bridge Wisp uses, and
# refuses a host setup cannot serve — before anything changes.
#
# A Wisp host needs a bridge: without one no VM or container has a network.
# The bridge is the one carrying the uplink (the default route's interface), or
# else `br0`, created on the uplink by the bridge step, setup's last change.
# The network tool is the one running the uplink: netplan (rendering to
# systemd-networkd) here; NetworkManager and plain systemd-networkd hosts are
# refused for now, naming what is supported.
#
# Sets:
#   NET_TOOL        netplan
#   UPLINK          the default route's interface
#   BRIDGE          the bridge Wisp uses
#   BRIDGE_CREATE   yes when the bridge step must create BRIDGE on UPLINK
#   UPLINK_MAC, UPLINK_NETPLAN_ID, UPLINK_ADDR (for the installer's question)

net_refuse() {
  echo "ERROR: $*" >&2
  echo "       Wisp hosts run Debian or Ubuntu with netplan, and an uplink that can be bridged." >&2
  exit 1
}

# A JSON document on stdin, one value out by a Python expression over `d`
# (python3 is netplan's own runtime, so it is on every netplan host).
net_json() {
  python3 -c 'import json, sys; d = json.load(sys.stdin); v = eval(sys.argv[1]); print("" if v is None else v)' "$@"
}

UPLINK="$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
[[ -n "$UPLINK" ]] || net_refuse "this host has no IPv4 default route, so no uplink to bridge."

# Which tool runs the uplink: ask the daemons.
NET_TOOL=""
if systemctl is-active --quiet systemd-networkd 2>/dev/null; then
  _netfile="$(networkctl status "$UPLINK" --json=short 2>/dev/null | net_json 'd.get("NetworkFile")' || true)"
  case "$_netfile" in
    /run/systemd/network/10-netplan-*) NET_TOOL=netplan ;;
    ?*) net_refuse "$UPLINK is run by systemd-networkd without netplan ($_netfile); this setup does not configure such hosts yet." ;;
  esac
fi
if [[ -z "$NET_TOOL" ]] && systemctl is-active --quiet NetworkManager 2>/dev/null \
  && grep -q "^${UPLINK}:connected" <<<"$(nmcli -t -f DEVICE,STATE device 2>/dev/null)"; then
  net_refuse "$UPLINK is run by NetworkManager; this setup does not configure such hosts yet."
fi
[[ -n "$NET_TOOL" ]] || net_refuse "$UPLINK is run by none of netplan, NetworkManager or systemd-networkd."

UPLINK_ADDR="$(ip -4 -o addr show dev "$UPLINK" scope global 2>/dev/null | awk '{ print $4; exit }')"

if [[ -d "/sys/class/net/$UPLINK/bridge" ]]; then
  BRIDGE="$UPLINK"
  BRIDGE_CREATE=no
else
  # An Ethernet-type link, not Wi-Fi and not a tunnel (whose type is not 1).
  [[ "$(cat "/sys/class/net/$UPLINK/type" 2>/dev/null)" == 1 && ! -d "/sys/class/net/$UPLINK/wireless" ]] \
    || net_refuse "the uplink $UPLINK cannot be bridged (Wi-Fi or a tunnel)."
  BRIDGE=br0
  BRIDGE_CREATE=yes
  if [[ -e "/sys/class/net/$BRIDGE" ]]; then
    net_refuse "$BRIDGE exists but does not carry the uplink $UPLINK; Wisp would bridge $UPLINK as $BRIDGE."
  fi
  UPLINK_MAC="$(cat "/sys/class/net/$UPLINK/address")"
  UPLINK_NETPLAN_ID="$(netplan status "$UPLINK" --format json 2>/dev/null | net_json "d.get(sys.argv[2], {}).get('id')" "$UPLINK" 2>/dev/null || true)"
  [[ -n "$UPLINK_NETPLAN_ID" ]] || net_refuse "netplan has no definition for the uplink $UPLINK."
fi
unset _netfile
