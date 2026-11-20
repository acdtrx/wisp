# Sourced by the network plan, the bridge step and the container-dns step; do
# not execute it. What an interface holds at layer 3, read from the kernel,
# systemd-networkd and systemd-resolved, in one canonical form: the plan records
# the uplink's before the bridge is made, and the bridge's check compares the
# bridge's with it afterwards. And the readers both share.

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
  "${SETUP_PYTHON[@]}" "$NET_SETUP_DIR/networkd.py" json "$2" <<<"$out"
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

# client_id <dev>: the interface's DHCPv4 client identifier as hex bytes,
# colon-separated; empty without a lease. When systemd-networkd's record of the
# lease is read (before systemd 257): returns 2 when the record is missing, 3
# when it names no client identifier. Returns 1 when it cannot be read.
client_id() {
  local out b hex=""
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
}

# l3_state <dev>: one line per fact, sorted —
#   addr4 <cidr>    every global IPv4 address
#   addr6 <cidr>    every global IPv6 address, learned or set: the kernel
#                   cannot tell the two apart (a learned address with an
#                   infinite lifetime carries no "dynamic")
#   route4 <route>  every IPv4 route through the interface, as `ip route` puts it:
#                   `linkdown` with it when the interface has no carrier
#   route6 <route>  every configured IPv6 route (proto static), the same way
#   dns <server>, domain <name>   the interface's name servers and search
#                   domains, as systemd-resolved holds them (none when it
#                   does not run: systemd-networkd's take effect through it)
# Fails, printing nothing, when any read fails.
l3_state() {
  local dev="$1" out line facts=""
  out="$(net_call ip -4 -o addr show dev "$dev" scope global)" || return 1
  facts+="$(awk 'NF { print "addr4 " $4 }' <<<"$out")"$'\n'
  out="$(net_call ip -6 -o addr show dev "$dev" scope global)" || return 1
  facts+="$(awk 'NF { print "addr6 " $4 }' <<<"$out")"$'\n'
  out="$(net_call ip -4 route show dev "$dev")" || return 1
  facts+="$(sed -E '/^$/d; s/ +$//; s/^/route4 /' <<<"$out")"$'\n'
  out="$(net_call ip -6 route show dev "$dev" proto static)" || return 1
  facts+="$(sed -E '/^$/d; s/ +(pref medium|expires [^ ]+)//g; s/ +$//; s/^/route6 /' <<<"$out")"$'\n'
  if net_call systemctl is-active --quiet systemd-resolved; then
    out="$(net_call resolvectl dns "$dev")" || return 1
    for line in ${out#*:}; do facts+="dns $line"$'\n'; done
    out="$(net_call resolvectl domain "$dev")" || return 1
    for line in ${out#*:}; do facts+="domain $line"$'\n'; done
  fi
  awk 'NF' <<<"$facts" | sort
}
