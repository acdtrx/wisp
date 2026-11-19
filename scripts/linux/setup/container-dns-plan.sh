# Sourced by network-plan.sh, as root; do not execute it. The container DNS
# stub's refusal, made before anything changes: Wisp's container DNS forwarder
# binds port 53 on the stub address (container-dns.sh), and a backend that
# cannot fails its start.

# refuse_dns_port: another DNS server listening there, or on every IPv4 address
# (AdGuard Home, Pi-hole, unbound, bind9, dnsmasq), is refused. Wisp's own
# backend holding it is not another.
refuse_dns_port() {
  local listeners l local_addr pid who
  listeners="$(net_read ss -Hlnup '( sport = :53 )')" || exit 1
  listeners+=$'\n'"$(net_read ss -Hlntp '( sport = :53 )')" || exit 1
  while read -r l; do
    [[ -n "$l" ]] || continue
    local_addr="$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /:53$/) { print $i; exit } }' <<<"$l")"
    case "$local_addr" in
      # A wildcard bound to one device takes the port from the stub too (the
      # forwarder's UDP bind then fails with EADDRINUSE); [::]:53 is IPv6 only
      # and leaves it free.
      169.254.53.53:53 | 0.0.0.0:53 | 0.0.0.0%*:53 | '*:53' | '*%'*:53) ;;
      *) continue ;;
    esac
    pid="$(grep -o 'pid=[0-9]*' <<<"$l" | head -n 1 | cut -d= -f2 || true)"
    if [[ -n "$pid" ]] && grep -q '/wisp\.service' "/proc/$pid/cgroup" 2>/dev/null; then continue; fi
    who="$(grep -o '(("[^"]*"' <<<"$l" | head -n 1 | tr -d '("' || true)"
    echo "ERROR: ${who:-a process}${pid:+ (pid $pid)} listens on $local_addr, where Wisp's container DNS forwarder" >&2
    echo "       listens (169.254.53.53:53). Bind that server to the addresses it serves, not to every" >&2
    echo "       address, and run this again." >&2
    exit 1
  done <<<"$listeners"
}
