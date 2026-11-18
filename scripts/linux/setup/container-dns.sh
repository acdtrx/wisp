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
# Why a dedicated interface rather than br0 — two failure modes, both observed:
#
#   1. Runtime-only on br0: any systemd-networkd restart (an unattended systemd
#      upgrade is enough) re-applied br0's .network and flushed the address.
#      wisp's socket stays bound to the vanished IP, so `ss` still reports it
#      listening while every container DNS query black-holes. Silent and total.
#
#   2. Declared on br0 (a drop-in on its .network unit): networkd then applies
#      the static address immediately on reconfigure while the DHCP lease takes
#      a round-trip, so br0 briefly has ONLY the link-local. avahi published
#      `<host>.local -> 169.254.53.53` in that window, then re-announced with the
#      real address, hit a name conflict and renamed the host to `<host>-2`.
#      That broke every consumer of the host's .local name. Worse than (1).
#
# On its own interface the address is independent of br0's lifecycle entirely —
# networkd restarts, `netplan apply`, DHCP renewals and carrier flaps cannot
# touch it — and avahi never sees br0 without a routable address. Declaring it
# in netplan is a third dead end: an `addresses:` entry alongside `dhcp4: true`
# on a bridge sends networkd into a reconcile loop (docs/specs/CONTAINERS.md, Local DNS).
#
# Declared, not made: the interface and its address belong to the daemon that
# runs this host's links — systemd-networkd, from two files of its own (also
# where netplan renders to it), or NetworkManager, as a dummy connection. They
# exist at every boot before the backend starts, with nothing of Wisp's
# involved — wisp.service creates nothing. The address is part of the network
# being online, which wisp.service is ordered after: on systemd-networkd an
# instance of its own wait-online unit waits for wisp-dns0 (netplan limits the
# plain wait-online to its own interfaces, so RequiredForOnline in the file
# below would not reach it there); on NetworkManager it is a connection that
# comes up by itself, and
# NetworkManager's startup — what NetworkManager-wait-online waits for — ends
# only once the devices it activates at startup are up.
#
# Does NOT touch systemd-resolved. Earlier Wisp versions (< 2026-04-18)
# configured resolved with MulticastDNS=resolve — clean that up manually on
# upgrade: remove /etc/systemd/resolved.conf.d/wisp-mdns.conf and restart
# systemd-resolved. See docs/specs/CONTAINERS.md for the full cleanup list.
#
# Must run as root.
# Usage: container-dns.sh <netplan|networkd|networkmanager>   (network-plan.sh's NET_TOOL)
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

NET_TOOL="${1:-}"
case "$NET_TOOL" in
  netplan | networkd | networkmanager) ;;
  *) echo "Usage: $0 <netplan|networkd|networkmanager>"; exit 1 ;;
esac

echo "--- Container DNS (stub IP + resolv.conf, through $NET_TOOL) ---"

STUB_IP="169.254.53.53"
STUB_IFACE="wisp-dns0"
RESOLV_OUT="/var/lib/wisp/container-resolv.conf"
NETWORKD_DIR="/etc/systemd/network"
OLD_DROPIN_NAME="wisp-mdns-stub.conf"
RELOAD=0

# 1. Remove the previous design's drop-ins: a `[Network] Address=` snippet on
#    br0's own .network unit. Wisp wrote those (v2.0.1/v2.0.2) and they are the
#    direct cause of failure mode (2) above, so clearing them is corrective
#    repair of our own bad state, not a migration.
shopt -s nullglob
for stale in "$NETWORKD_DIR"/*.network.d/"$OLD_DROPIN_NAME"; do
  rm -f "$stale"
  changed "removed stale drop-in $stale (stub IP no longer lives on br0)"
  RELOAD=1
done
shopt -u nullglob

# 2. The dummy interface that carries the stub IP, with nothing else on it:
#    no IPv6 and no link-local address — every extra one is another record
#    avahi would register. The backend binds the address when it starts, so the
#    step ends with it there.
stub_up() {
  local addrs
  addrs="$(ip -4 addr show dev "$STUB_IFACE" 2>/dev/null || true)"
  [[ "$addrs" == *"${STUB_IP}/32"* ]]
}

# systemd-networkd: two files, because it needs the device (.netdev) and its
# addressing (.network) apart.
stub_networkd() {
  local netdev network
  netdev="$(staged_file)"
  cat > "$netdev" <<EOF
# Generated by Wisp container-dns.sh — carries the mDNS stub IP for Wisp's
# container DNS forwarder, off br0 so bridge reconfigures cannot disturb it.
[NetDev]
Name=${STUB_IFACE}
Kind=dummy
EOF

  network="$(staged_file)"
  cat > "$network" <<EOF
# Generated by Wisp container-dns.sh — see 10-${STUB_IFACE}.netdev.
# The address lands with scope link (iproute2/networkd do that for 169.254/16)
# and that is fine: the forwarder binds it explicitly, so replies to containers
# never go through the kernel's source-address selection.
# RequiredForOnline=no: the plain wait-online does not wait for this device.
# What waits for it is setup's systemd-networkd-wait-online@wisp-dns0:degraded
# instance (a link-local-only device settles at "degraded"), which
# network-online.target — and so wisp.service — is ordered after.
[Match]
Name=${STUB_IFACE}

[Network]
Address=${STUB_IP}/32
LinkLocalAddressing=no
IPv6AcceptRA=no

[Link]
RequiredForOnline=no
EOF

  if write_if_changed "$NETWORKD_DIR/10-${STUB_IFACE}.netdev" 0644 "$netdev"; then
    changed "$NETWORKD_DIR/10-${STUB_IFACE}.netdev"
    RELOAD=1
  fi
  if write_if_changed "$NETWORKD_DIR/10-${STUB_IFACE}.network" 0644 "$network"; then
    changed "$NETWORKD_DIR/10-${STUB_IFACE}.network"
    RELOAD=1
  fi

  # networkd applies what it was given: on a change, or when the address is not
  # there (files written before networkd ran), reload it and wait until the
  # interface has its address.
  if (( RELOAD )) || ! stub_up; then
    timeout 30 networkctl reload || fail "networkctl reload failed"
    /usr/lib/systemd/systemd-networkd-wait-online -i "${STUB_IFACE}:degraded" --timeout=30 >/dev/null \
      || fail "${STUB_IFACE} did not get ${STUB_IP} from systemd-networkd within 30 s"
    stub_up || fail "${STUB_IFACE} has no ${STUB_IP} after the reload"
    changed "systemd-networkd brought up ${STUB_IFACE} with ${STUB_IP}"
  fi
  unit_on "systemd-networkd-wait-online@${STUB_IFACE}:degraded"
}

# NetworkManager: one dummy connection, connecting by itself.
stub_networkmanager() {
  local want have
  local settings=(connection.interface-name "$STUB_IFACE" ipv4.method manual ipv4.addresses "${STUB_IP}/32"
    ipv6.method disabled connection.autoconnect yes)
  # Key by key, as nmcli prints them ("key:value"), sorted.
  want="$(printf '%s\n' connection.autoconnect:yes connection.interface-name:"$STUB_IFACE" connection.type:dummy \
    ipv4.addresses:"${STUB_IP}/32" ipv4.method:manual ipv6.method:disabled | LC_ALL=C sort)"
  have=""
  if timeout 30 nmcli -t -f connection.id connection show "$STUB_IFACE" >/dev/null 2>&1; then
    have="$(timeout 30 nmcli -t -f connection.type,connection.interface-name,ipv4.method,ipv4.addresses,ipv6.method,connection.autoconnect \
      connection show "$STUB_IFACE")" || fail "nmcli cannot read the connection $STUB_IFACE"
    have="$(LC_ALL=C sort <<<"$have")"
  fi
  if [[ -z "$have" ]]; then
    timeout 30 nmcli connection add type dummy con-name "$STUB_IFACE" ifname "$STUB_IFACE" "${settings[@]}" >/dev/null \
      || fail "NetworkManager refused the connection $STUB_IFACE"
    changed "NetworkManager connection $STUB_IFACE (${STUB_IP}/32)"
  elif [[ "$have" != "$want" ]]; then
    timeout 30 nmcli connection modify "$STUB_IFACE" "${settings[@]}" \
      || fail "NetworkManager refused the settings of $STUB_IFACE"
    changed "NetworkManager connection $STUB_IFACE set to ${STUB_IP}/32"
    RELOAD=1
  fi
  if (( RELOAD )) || ! stub_up; then
    timeout 60 nmcli --wait 30 connection up "$STUB_IFACE" >/dev/null \
      || fail "NetworkManager did not bring up ${STUB_IFACE} within 30 s"
    stub_up || fail "${STUB_IFACE} has no ${STUB_IP} after NetworkManager brought it up"
    changed "NetworkManager brought up ${STUB_IFACE} with ${STUB_IP}"
  fi
}

case "$NET_TOOL" in
  netplan | networkd) stub_networkd ;;
  networkmanager) stub_networkmanager ;;
esac

# Corrective repair of Wisp's own earlier state: a copy of the stub IP left on
# br0 would answer alongside wisp-dns0 and can leave br0 on a lone link-local
# address. Nothing to do when br0 does not exist.
BR0_ADDRS="$(ip -4 addr show dev br0 2>/dev/null || true)"
if [[ "$BR0_ADDRS" == *"${STUB_IP}/32"* ]]; then
  ip addr del "${STUB_IP}/32" dev br0
  changed "removed ${STUB_IP}/32 from br0 (now on ${STUB_IFACE})"
fi

# 3. A ready-to-bind-mount resolv.conf for containers. The backend's
#    resolveContainerResolvConf() returns this path for containers on a primary
#    bridge (not a VLAN sub-bridge, which has no path to the stub IP).
RESOLV="$(staged_file)"
cat > "$RESOLV" <<EOF
# Generated by Wisp container-dns.sh — bind-mounted into containers on br0.
nameserver ${STUB_IP}
options edns0
EOF
mkdir -p /var/lib/wisp
if write_if_changed "$RESOLV_OUT" 0644 "$RESOLV"; then changed "$RESOLV_OUT"; fi
step_done
