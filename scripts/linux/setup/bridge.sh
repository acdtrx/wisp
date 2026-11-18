#!/usr/bin/env bash
# Setup step, the last: the bridge Wisp's VMs and containers join. When the
# uplink already is a bridge there is nothing to do; otherwise `br0` is declared
# on the uplink through netplan, the tool that runs it (network-plan.sh), and
# applied. Run as root.
#
# The bridge keeps the host's address: it takes the uplink's hardware address,
# its IPv6 settings, and its DHCP identity exactly — the client identifier the
# DHCP server knows it by — or its static addresses, routes and name servers.
# netplan has no key for a DUID's IAID, so for a DUID identity a networkd drop-in
# on netplan's own unit for the bridge carries it. Applying is setup's last
# change, after which the step waits for the bridge to be routable.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
# shellcheck source=network-plan.sh
source "$SETUP_DIR/network-plan.sh"

echo "--- Bridge ---"

if [[ "$BRIDGE_CREATE" == no ]]; then
  echo "  $BRIDGE carries the uplink"
  step_done
  exit 0
fi

NETPLAN_FILE=/etc/netplan/90-wisp-bridge.yaml
DROPIN=/etc/systemd/network/10-netplan-${BRIDGE}.network.d/50-wisp-dhcp-identity.conf

# The uplink as netplan defines it, and its DHCPv4 identity as networkd holds
# it ([type, ...bytes]; type 1 is the MAC, 255 an IAID and DUID).
UPLINK_DEF="$(staged_file)"
netplan get "ethernets.$UPLINK_NETPLAN_ID" > "$UPLINK_DEF"
CLIENT_ID="$(networkctl status "$UPLINK" --json=short | net_json '" ".join(str(b) for b in (d.get("DHCPv4Client") or {}).get("ClientIdentifier") or [])')"

RENDERED="$(staged_file)"
RENDERED_DROPIN="$(staged_file)"
python3 - "$UPLINK_DEF" "$UPLINK_NETPLAN_ID" "$BRIDGE" "$UPLINK_MAC" "$CLIENT_ID" "$RENDERED" "$RENDERED_DROPIN" "$UPLINK" <<'PY'
import sys
import yaml

def_file, uplink_id, bridge, mac, client_id, out, out_dropin, uplink = sys.argv[1:9]
uplink_def = yaml.safe_load(open(def_file)) or {}
cid = [int(b) for b in client_id.split()]

bridge_def = {
    'interfaces': [uplink_id],
    'macaddress': mac,
    'parameters': {'stp': False, 'forward-delay': 0},
}
for key in ('dhcp6', 'accept-ra', 'ipv6-privacy', 'link-local'):
    if key in uplink_def:
        bridge_def[key] = uplink_def[key]
dropin = ''
if cid:
    bridge_def['dhcp4'] = True
    if cid[0] == 1:
        bridge_def['dhcp-identifier'] = 'mac'
    elif cid[0] == 255 and len(cid) > 5:
        iaid = int.from_bytes(bytes(cid[1:5]), 'big')
        dropin = (
            f'# Written by Wisp setup: {bridge} keeps the DHCP identity {uplink} had\n'
            f'# (DUID with IAID {iaid}), so the DHCP server hands it the same lease.\n'
            '[DHCPv4]\nClientIdentifier=duid\n'
            f'IAID={iaid}\n'
        )
    else:
        sys.exit(f'unexpected DHCPv4 client identifier type {cid[0]} on {uplink}')
else:
    # Static: the bridge takes the uplink's addresses, routes and name servers.
    for key in ('addresses', 'routes', 'gateway4', 'nameservers'):
        if key in uplink_def:
            bridge_def[key] = uplink_def[key]
    if 'addresses' not in bridge_def:
        sys.exit(f'{uplink} has neither a DHCPv4 lease nor static addresses in netplan')

doc = {'network': {
    'version': 2,
    'ethernets': {uplink_id: {'dhcp4': False, 'dhcp6': False, 'accept-ra': False}},
    'bridges': {bridge: bridge_def},
}}
with open(out, 'w') as f:
    f.write(f'# Written by Wisp setup: {bridge} on {uplink}, keeping its address.\n')
    yaml.safe_dump(doc, f, default_flow_style=False, sort_keys=True)
with open(out_dropin, 'w') as f:
    f.write(dropin)
PY

if [[ -s "$RENDERED_DROPIN" ]]; then
  mkdir -p "$(dirname "$DROPIN")"
  if write_if_changed "$DROPIN" 0644 "$RENDERED_DROPIN"; then changed "$DROPIN"; fi
fi
if write_if_changed "$NETPLAN_FILE" 0600 "$RENDERED"; then changed "$NETPLAN_FILE"; fi

echo "  applying: $BRIDGE on $UPLINK (was ${UPLINK_ADDR:-no IPv4 address}); an ssh session may pause"
netplan apply
changed "$BRIDGE created on $UPLINK"
/usr/lib/systemd/systemd-networkd-wait-online -i "$BRIDGE:routable" --timeout=90 \
  || fail "$BRIDGE did not become routable within 90 s"
echo "  $BRIDGE holds $(ip -4 -o addr show dev "$BRIDGE" scope global | awk '!done { print $4; done = 1 }')"
step_done
