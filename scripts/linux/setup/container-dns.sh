#!/usr/bin/env bash
# Setup step: the stub IP + container resolv.conf used by Wisp's in-process DNS
# forwarder (backend/src/lib/mdns/linux/forwarder.js).
#
# How it works:
#   - Hold the link-local 169.254.53.53/32 on a dedicated dummy interface,
#     wisp-dns0. The wisp process binds UDP+TCP 53 on this IP (via
#     CAP_NET_BIND_SERVICE) and answers container DNS queries: `.local` names
#     go to avahi over DBus, everything else goes to the host's upstream DNS.
#   - Drop a ready-to-bind-mount resolv.conf so Wisp containers on br0
#     use the stub IP as their sole nameserver.
#
# Containers still reach it: they carry an on-link `169.254.53.53/32 dev eth0`
# route and ARP for it on the bridge segment, and Linux's weak host model means
# the host answers that ARP from br0 even though the address lives elsewhere.
#
# On a device of its own, never on the bridge, whether at runtime or declared
# with it: there a networkd reconfigure or a DHCP round-trip removes it or
# leaves the bridge on it alone, and avahi then renames the host
# (docs/specs/CONTAINERS.md, Local DNS).
#
# Declared, not made: the dummy device and its address are a netplan definition
# in a file of Wisp's own (DNS_STUB_NETPLAN_FILE), rendered to
# systemd-networkd, so they exist at every boot before the backend starts, with
# nothing of Wisp's creating them — wisp.service creates nothing. The address
# is part of the network being online, which wisp.service is ordered after:
# the definition is not optional, so netplan's wait-online waits for it.
# Rendered with `netplan generate`, never `netplan apply`, and brought to its
# settings with the least systemd-networkd call the host needs (below). The
# stub declared in systemd-networkd's own files, as a host may hold it, is
# taken back.
#
# Does not touch systemd-resolved.
#
# Must run as root.
# Usage: container-dns.sh <bridge>   (network-plan.sh's BRIDGE)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin
# shellcheck source=net-state.sh
source "$SETUP_DIR/net-state.sh"
# shellcheck source=container-dns-plan.sh
source "$SETUP_DIR/container-dns-plan.sh"

BRIDGE="${1:-}"
[[ -n "$BRIDGE" ]] || { echo "Usage: $0 <bridge>"; exit 1; }

echo "--- Container DNS (stub IP + resolv.conf) ---"

RESOLV_OUT="/var/lib/wisp/container-resolv.conf"
NETWORKD_DIR="/etc/systemd/network"
BRIDGE_DROPIN_NAME="wisp-mdns-stub.conf"
# The stub declared in systemd-networkd's own files.
NETWORKD_FILES=("$NETWORKD_DIR/10-${DNS_STUB_IFACE}.netdev" "$NETWORKD_DIR/10-${DNS_STUB_IFACE}.network")
NETPLAN_STUB_UNIT="/run/systemd/network/10-netplan-${DNS_STUB_IFACE}.network"

# 1. No drop-in declaring the stub's address on the bridge's own unit, as a
#    host may hold. The address it put on the bridge goes below;
#    systemd-networkd forgets the drop-in at its next reload or boot.
shopt -s nullglob
for stale in "$NETWORKD_DIR"/*.network.d/"$BRIDGE_DROPIN_NAME"; do
  rm -f "$stale"
  changed "removed $stale (the stub's address is on ${DNS_STUB_IFACE}, never on the bridge)"
done
shopt -u nullglob

# 2. The dummy device that carries the stub IP, with nothing else on it: no
#    IPv6 and no link-local address — every extra one is another record avahi
#    would register. The address lands with scope link (networkd does that for
#    169.254/16), which is fine: the forwarder binds it explicitly, so replies
#    to containers never go through the kernel's source-address selection. The
#    backend binds the address when it starts, so the step ends with it there.

# The stub's file as the network plan rendered and checked it; netplan renders
# its units to /run when the file is new or changed, when systemd-networkd's
# own files go, and when the device is missing.
yaml="$NET_PLAN_DIR/$DNS_STUB_PLANNED"
[[ -s "$yaml" ]] || fail "no container DNS stub definition in the network plan ($yaml)"
GENERATE=0
if write_if_changed "$DNS_STUB_NETPLAN_FILE" 0600 "$yaml"; then
  changed "$DNS_STUB_NETPLAN_FILE"
  GENERATE=1
fi
for f in "${NETWORKD_FILES[@]}"; do
  [[ ! -e "$f" ]] || GENERATE=1
done
[[ -e "/sys/class/net/$DNS_STUB_IFACE" ]] || GENERATE=1
if (( GENERATE )); then
  step_run 0 timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" netplan generate || fail "netplan generate failed"
fi
for f in "${NETWORKD_FILES[@]}"; do
  [[ -e "$f" ]] || continue
  remove_file "$f" || fail "cannot remove $f"
  changed "removed $f (the stub is netplan's)"
done

# What brings the device to its settings is decided from the host, never from
# what this run wrote, so a run cut short is finished by the next. A reload of
# systemd-networkd reconfigures every link it runs from netplan's units, the
# bridge among them, whose DHCP lease it drops and takes again, so it is the
# last resort: a missing device, or one that runs from another file
# (systemd-networkd's own, deleted or not) without its settings. A device that
# holds them from another file keeps running; systemd-networkd runs it from
# netplan's unit from its next reload or boot. Each path ends with the device
# holding them, or fails.
how=""
if [[ ! -e "/sys/class/net/$DNS_STUB_IFACE" ]]; then
  net_call networkctl reload || fail "networkctl reload failed"
  how="systemd-networkd reloaded"
elif ! dns_stub_holds; then
  runs_from="$(networkd_json "$DNS_STUB_IFACE" NetworkFile)" || fail "cannot read systemd-networkd's status of $DNS_STUB_IFACE"
  if [[ "$runs_from" == "$NETPLAN_STUB_UNIT" ]]; then
    net_call networkctl reconfigure "$DNS_STUB_IFACE" || fail "networkctl reconfigure $DNS_STUB_IFACE failed"
    how="$DNS_STUB_IFACE reconfigured"
  else
    net_call networkctl reload || fail "networkctl reload failed"
    how="systemd-networkd reloaded ($DNS_STUB_IFACE ran from '${runs_from}')"
  fi
fi
if [[ -n "$how" ]]; then
  dns_stub_wait || fail "${DNS_STUB_IFACE} does not hold ${DNS_STUB_IP}/32 alone ${NET_WAIT_SEC} s after: $how"
  changed "$how: ${DNS_STUB_IFACE} holds ${DNS_STUB_IP}/32"
fi

# No copy of the stub IP on the bridge, as a host may hold: it would answer
# alongside wisp-dns0 and can leave the bridge on a lone link-local address.
# Nothing to do when the bridge does not exist yet.
BRIDGE_ADDRS="$(net_call ip -4 addr show dev "$BRIDGE" 2>/dev/null || true)"
if [[ "$BRIDGE_ADDRS" == *"${DNS_STUB_IP}/32"* ]]; then
  net_call ip addr del "${DNS_STUB_IP}/32" dev "$BRIDGE" || fail "cannot remove ${DNS_STUB_IP}/32 from $BRIDGE"
  changed "removed ${DNS_STUB_IP}/32 from $BRIDGE (now on ${DNS_STUB_IFACE})"
fi

# 3. A ready-to-bind-mount resolv.conf for containers. The backend's
#    resolveContainerResolvConf() returns this path for containers on a primary
#    bridge (not a VLAN sub-bridge, which has no path to the stub IP).
RESOLV="$(staged_file)"
cat > "$RESOLV" <<EOF
# Generated by Wisp container-dns.sh — bind-mounted into containers on the bridge.
nameserver ${DNS_STUB_IP}
options edns0
EOF
mkdir -p /var/lib/wisp
if write_if_changed "$RESOLV_OUT" 0644 "$RESOLV"; then changed "$RESOLV_OUT"; fi
step_done
