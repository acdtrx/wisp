# Sourced by the network plan, the bridge journal and the container-dns step;
# do not execute it. What an interface holds at layer 3, read from the kernel
# and the host's tool, in one canonical form: the plan records the uplink's
# before the bridge is made, and the bridge's check compares the bridge's with
# it afterwards. And the readers both share.

# shellcheck source=bounds.sh
source "$(dirname "${BASH_SOURCE[0]}")/bounds.sh"

NET_SETUP_DIR="${NET_SETUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

# net_call <cmd...>: a call of a network tool, bounded.
net_call() { timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" "$@"; }
# net_apply <cmd...>: an apply, bounded by NET_APPLY_SEC, in a step only: run
# through step_run (step.sh), as it can outlast NET_CMD_SEC.
net_apply() { step_run 0 timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" "$@"; }

# networkd_json <link> <path>: one value of `networkctl status <link> --json=short`
# (a list one item a line), read with a JSON parser.
networkd_json() {
  local out
  out="$(net_call networkctl status "$1" --json=short)" || return 1
  python3 -I "$NET_SETUP_DIR/networkd.py" json "$2" <<<"$out"
}

# nm_has <uuid>: 0 when NetworkManager has the connection, 1 when it has not
# (nmcli's exit 10: not found), 2 when NetworkManager cannot be asked.
nm_has() {
  local rc=0
  net_call nmcli -t -f connection.uuid connection show "$1" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 0 ;;
    10) return 1 ;;
    *) return 2 ;;
  esac
}

# first_ipv4 <dev>: the interface's first global IPv4 address, with prefix;
# empty when it has none or it cannot be read.
first_ipv4() {
  local out
  out="$(net_call ip -4 -o addr show dev "$1" scope global 2>/dev/null)" || return 0
  awk '!done { print $4; done = 1 }' <<<"$out"
}

# systemd-networkd's JSON (`networkctl status --json`) names a link's DHCPv4
# client identifier from systemd 257 on. Before, it is read, read only, from
# networkd's own record of the lease: the one read of a tool's internal state
# (docs/specs/DEPLOYMENT.md, The bridge).
NETWORKD_JSON_CLIENT_ID_SINCE=257

# networkd_lease_client_id <dev>: CLIENTID= of systemd-networkd's lease record
# for the interface (/run/systemd/netif/leases/<ifindex>), hex. Returns 2 when
# the record is missing, 3 when it has no CLIENTID=, 1 when the interface
# cannot be read.
networkd_lease_client_id() {
  local idx line
  idx="$(cat "/sys/class/net/$1/ifindex")" || return 1
  [[ -r "/run/systemd/netif/leases/$idx" ]] || return 2
  while IFS= read -r line; do
    [[ "$line" == CLIENTID=* ]] && { printf '%s' "${line#CLIENTID=}"; return 0; }
  done < "/run/systemd/netif/leases/$idx"
  return 3
}

# client_id <dev> <net-tool>: the interface's DHCPv4 client identifier as hex
# bytes, colon-separated; empty without a lease. When systemd-networkd holds a
# lease and its record of it is read (before systemd 257): returns 2 when the
# record is missing, 3 when it names no client identifier. Returns 1 when it
# cannot be read.
client_id() {
  local out b hex=""
  case "$2" in
    networkmanager)
      out="$(net_call nmcli -t -f DHCP4.OPTION device show "$1")" || return 1
      sed -n 's/^DHCP4\.OPTION\[[0-9]*\]:dhcp_client_identifier = //p' <<<"$out"
      ;;
    *)
      [[ "${SYSTEMD_VERSION:-}" =~ ^[0-9]+$ ]] \
        || { echo "ERROR: SYSTEMD_VERSION is not set (setup's distro.sh reads it)" >&2; return 1; }
      if (( SYSTEMD_VERSION >= NETWORKD_JSON_CLIENT_ID_SINCE )); then
        out="$(networkd_json "$1" DHCPv4Client.ClientIdentifier)" || return 1
        for b in $out; do hex+="$(printf '%02x:' "$b")"; done
        printf '%s' "${hex%:}"
        return 0
      fi
      out="$(networkd_json "$1" DHCPv4Client.Lease)" || return 1
      [[ -n "$out" ]] || return 0
      out="$(networkd_lease_client_id "$1")" || return $?
      sed -E 's/(..)/\1:/g; s/:$//' <<<"$out"
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
# Fails, printing nothing, when any read fails.
l3_state() {
  local dev="$1" tool="$2" out line facts=""
  out="$(net_call ip -4 -o addr show dev "$dev" scope global)" || return 1
  facts+="$(awk 'NF { print "addr4 " $4 }' <<<"$out")"$'\n'
  out="$(net_call ip -6 -o addr show dev "$dev" scope global)" || return 1
  facts+="$(awk 'NF && !/ dynamic/ { print "addr6 " $4 }' <<<"$out")"$'\n'
  out="$(net_call ip -4 route show dev "$dev")" || return 1
  facts+="$(sed -E '/^$/d; s/ +linkdown//; s/ +$//; s/^/route4 /' <<<"$out")"$'\n'
  out="$(net_call ip -6 route show dev "$dev" proto static)" || return 1
  facts+="$(sed -E '/^$/d; s/ +linkdown//; s/ +(pref medium|expires [^ ]+)//g; s/ +$//; s/^/route6 /' <<<"$out")"$'\n'
  case "$tool" in
    networkmanager)
      out="$(net_call nmcli -t -f IP4.DNS,IP6.DNS,IP4.DOMAIN,IP6.DOMAIN device show "$dev")" || return 1
      while IFS= read -r line; do
        case "$line" in
          IP[46].DNS*) facts+="dns ${line#*:}"$'\n' ;;
          IP[46].DOMAIN*) facts+="domain ${line#*:}"$'\n' ;;
        esac
      done <<<"$out"
      ;;
    *)
      # systemd-networkd's name servers take effect through systemd-resolved;
      # without it there are none to compare.
      if net_call systemctl is-active --quiet systemd-resolved; then
        out="$(net_call resolvectl dns "$dev")" || return 1
        for line in ${out#*:}; do facts+="dns $line"$'\n'; done
        out="$(net_call resolvectl domain "$dev")" || return 1
        for line in ${out#*:}; do facts+="domain $line"$'\n'; done
      fi
      ;;
  esac
  awk 'NF' <<<"$facts" | sort
}
