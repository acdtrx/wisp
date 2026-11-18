# Sourced by network-plan.sh and the bridge step; do not execute it. What an
# interface holds at layer 3, read from the kernel and the host's tool, in one
# canonical form: the plan records the uplink's before the bridge is made, and
# the bridge step compares the bridge's with it afterwards. And the readers
# both share.

NET_CMD_SEC=30   # bound on every call of a network tool that is not an apply

# first_ipv4 <dev>: the interface's first global IPv4 address, with prefix.
first_ipv4() {
  local out
  out="$(timeout "$NET_CMD_SEC" ip -4 -o addr show dev "$1" scope global 2>/dev/null)" || return 0
  awk '!done { print $4; done = 1 }' <<<"$out"
}

# json_array <json> <key>: a flat array's contents from networkd's JSON.
json_array() { [[ "$1" =~ \"$2\":\[([^]]*)\] ]] && printf '%s' "${BASH_REMATCH[1]}"; }
# json_string <json> <key>: a string value from networkd's JSON.
json_string() { [[ "$1" =~ \"$2\":\"([^\"]*)\" ]] && printf '%s' "${BASH_REMATCH[1]}"; }

# client_id <dev> <net-tool>: the interface's DHCPv4 client identifier as hex
# bytes, colon-separated; empty without a lease.
client_id() {
  local out bytes b hex=""
  case "$2" in
    networkmanager)
      out="$(timeout "$NET_CMD_SEC" nmcli -t -f DHCP4.OPTION device show "$1" 2>/dev/null)" || return 0
      sed -n 's/^DHCP4\.OPTION\[[0-9]*\]:dhcp_client_identifier = //p' <<<"$out"
      ;;
    *)
      out="$(timeout "$NET_CMD_SEC" networkctl status "$1" --json=short 2>/dev/null)" || return 0
      bytes="$(json_array "$out" ClientIdentifier || true)"
      for b in ${bytes//,/ }; do hex+="$(printf '%02x:' "$b")"; done
      printf '%s' "${hex%:}"
      ;;
  esac
}

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
    timeout "$NET_CMD_SEC" ip -4 -o addr show dev "$dev" scope global | awk '{ print "addr4 " $4 }'
    timeout "$NET_CMD_SEC" ip -6 -o addr show dev "$dev" scope global | awk '!/ dynamic/ { print "addr6 " $4 }'
    timeout "$NET_CMD_SEC" ip -4 route show dev "$dev" | sed -E 's/ +linkdown//; s/ +$//; s/^/route4 /'
    timeout "$NET_CMD_SEC" ip -6 route show dev "$dev" proto static | sed -E 's/ +linkdown//; s/ +(pref medium|expires [^ ]+)//g; s/ +$//; s/^/route6 /'
    case "$tool" in
      networkmanager)
        timeout "$NET_CMD_SEC" nmcli -t -f IP4.DNS,IP6.DNS,IP4.DOMAIN,IP6.DOMAIN device show "$dev" | while IFS= read -r line; do
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
          line="$(timeout "$NET_CMD_SEC" resolvectl dns "$dev")"
          for line in ${line#*:}; do echo "dns $line"; done
          line="$(timeout "$NET_CMD_SEC" resolvectl domain "$dev")"
          for line in ${line#*:}; do echo "domain $line"; done
        fi
        ;;
    esac
  } | LC_ALL=C sort
}

# plan_sources: what a plan to make the bridge is made from, as checksums (and
# for NetworkManager the uplink connection's settings), for the bridge step to
# check nothing changed since. Uses the plan's NET_TOOL, NET_PLAN_DIR and
# UPLINK_CONNECTION.
plan_sources() {
  case "$NET_TOOL" in
    netplan) sha256sum /lib/netplan/* /etc/netplan/* /run/netplan/* 2>/dev/null | LC_ALL=C sort -k2 ;;
    networkd) xargs -d '\n' sha256sum < "$NET_PLAN_DIR/networkd-sources" ;;
    networkmanager)
      timeout "$NET_CMD_SEC" nmcli -t connection show "$UPLINK_CONNECTION" | grep -vE '^(GENERAL|IP[46]|DHCP[46])\.|^connection\.timestamp:' | sha256sum
      timeout "$NET_CMD_SEC" nmcli -g GENERAL.CON-UUID device show "$UPLINK"
      ;;
  esac
}
