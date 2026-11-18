# Sourced by network-plan.sh and the bridge step; do not execute it. What an
# interface holds at layer 3, read from the kernel and the host's tool, in one
# canonical form: the plan records the uplink's before the bridge is made, and
# the bridge step compares the bridge's with it afterwards.

NET_STATE_SEC=30   # bound on each read

# l3_state <dev> <net-tool>: one line per fact, sorted —
#   addr4 <cidr>    every global IPv4 address
#   addr6 <cidr>    every global IPv6 address that is configured, not learned
#                   (no "dynamic": SLAAC and DHCPv6 addresses follow the link)
#   route4 <route>  every IPv4 route through the interface, as `ip route` puts it
#   route6 <route>  every configured IPv6 route (proto static)
#   dns <server>, domain <name>   the interface's name servers and search
#                   domains, as the tool's resolver holds them
l3_state() {
  local dev="$1" tool="$2" line
  {
    timeout "$NET_STATE_SEC" ip -4 -o addr show dev "$dev" scope global | awk '{ print "addr4 " $4 }'
    timeout "$NET_STATE_SEC" ip -6 -o addr show dev "$dev" scope global | awk '!/ dynamic/ { print "addr6 " $4 }'
    timeout "$NET_STATE_SEC" ip -4 route show dev "$dev" | sed -E 's/ +linkdown//; s/ +$//; s/^/route4 /'
    timeout "$NET_STATE_SEC" ip -6 route show dev "$dev" proto static | sed -E 's/ +linkdown//; s/ +(pref medium|expires [^ ]+)//g; s/ +$//; s/^/route6 /'
    case "$tool" in
      networkmanager)
        timeout "$NET_STATE_SEC" nmcli -t -f IP4.DNS,IP6.DNS,IP4.DOMAIN,IP6.DOMAIN device show "$dev" | while IFS= read -r line; do
          case "$line" in
            IP[46].DNS*) echo "dns ${line#*:}" ;;
            IP[46].DOMAIN*) echo "domain ${line#*:}" ;;
          esac
        done
        ;;
      *)
        # systemd-networkd's name servers take effect through systemd-resolved;
        # without it there are none to compare.
        if systemctl is-active --quiet systemd-resolved; then
          line="$(timeout "$NET_STATE_SEC" resolvectl dns "$dev")"
          for line in ${line#*:}; do echo "dns $line"; done
          line="$(timeout "$NET_STATE_SEC" resolvectl domain "$dev")"
          for line in ${line#*:}; do echo "domain $line"; done
        fi
        ;;
    esac
  } | LC_ALL=C sort
}
