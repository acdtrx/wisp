"""systemd-networkd's files, read for net-networkd.sh and net-netplan.sh; run as
root with python3 -I. A file is read as networkd reads it: sections, `Key=value`
lines, `#` and `;` comments, a trailing backslash continuing a line.

  networkd.py json <path>
      reads `networkctl status <link> --json=short` on stdin; prints the value
      at <path> (keys joined by dots), nothing when it is not there: a string as
      it is, a list one item a line
  networkd.py takers <uplink> <mac> <driver> <own-file>
      prints each .network file, but <own-file>, whose [Match] could take the
      uplink — a second definition for it. networkd runs a link from the first
      file, by name, that matches it: a file whose name sorts after <own-file>'s
      (an initrd's catch-all fallback, zzzz-…) never takes the uplink, before
      the bridge step or after, as the uplink's file keeps its name.
  networkd.py port <file> <uplink> <mac> <out-dir>
      the uplink's file split: what moves to the bridge (bridge.network.body),
      what stays on the port (port.match, port.link); prints dhcp or static.
      Exit 3 with the reason printed: refused.
"""
import fnmatch
import json
import os
import sys

DIRS = ("/etc/systemd/network", "/run/systemd/network", "/usr/local/lib/systemd/network",
        "/usr/lib/systemd/network", "/lib/systemd/network")


def refuse(why):
    print(why)
    sys.exit(3)


def parse(path):
    """[(section, key, value)], in the file's order."""
    out, sect, pending = [], None, ''
    with open(path) as f:
        for raw in f:
            line = raw.rstrip('\n')
            if pending:
                line = pending + line.lstrip()
                pending = ''
            if line.endswith('\\'):
                pending = line[:-1] + ' '
                continue
            s = line.strip()
            if not s or s[0] in '#;':
                continue
            if s.startswith('[') and s.endswith(']'):
                sect = s[1:-1]
                continue
            if '=' not in s:
                refuse(f'{path}: "{s}" is not a setting')
            if sect is None:
                refuse(f'{path}: a setting outside any section')
            key, value = s.split('=', 1)
            out.append((sect, key.strip(), value.strip()))
    return out


def json_key(path):
    v = json.load(sys.stdin)
    for key in path.split('.'):
        v = v.get(key) if isinstance(v, dict) else None
    if isinstance(v, list):
        for item in v:
            print(item)
    elif v is not None:
        print(v)


def files():
    """The .network files networkd reads, by name: the first directory wins, and
    a link to /dev/null masks the name."""
    seen = {}
    for d in DIRS:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith('.network') and name not in seen:
                seen[name] = os.path.join(d, name)
    return {n: p for n, p in sorted(seen.items()) if os.path.realpath(p) != '/dev/null'}


def matches(patterns, value):
    """One [Match] list: space-separated globs, `!` before the list inverts it."""
    words = patterns.split()
    if not words:
        return True
    invert = words[0].startswith('!')
    if invert:
        words[0] = words[0][1:]
    hit = value is not None and any(fnmatch.fnmatchcase(value, w) for w in words if w)
    return hit != invert


def takers(uplink, mac, driver, own):
    # What the uplink is, for each [Match] key; a key not listed here is a
    # condition on the host (Host=, Virtualization=, KernelCommandLine=, …) or
    # one setup cannot read, and is taken as met.
    facts = {'Name': uplink, 'OriginalName': uplink, 'MACAddress': mac, 'PermanentMACAddress': mac,
             'Driver': driver or None, 'Type': 'ether', 'Kind': None, 'WLANInterfaceType': None,
             'SSID': None, 'BSSID': None}
    own_name = os.path.basename(own)
    for name, path in files().items():
        if name >= own_name:
            continue
        conds = {}
        for sect, key, value in parse(path):
            if sect == 'Match':
                conds[key] = (conds.get(key, '') + ' ' + value).strip() if value else ''
        # networkd ignores a file with no condition in [Match].
        if not any(conds.values()):
            continue
        if all(matches(v, facts[k]) for k, v in conds.items() if k in facts and v):
            print(path)


# The uplink's own file, split. What moves to the bridge: its layer 3 — the
# sections below whole, and the [Network] settings in NETWORK_MOVED. What stays
# on the port: [Match], [Link] (but what the boot waits for, which goes with the
# address), and the layer-2 settings in NETWORK_PORT. Anything else is refused,
# naming it.
SECTIONS_MOVED = {'Address', 'Route', 'RoutingPolicyRule', 'NextHop', 'DHCP', 'DHCPv4', 'DHCPv6',
                  'DHCPPrefixDelegation', 'IPv6AcceptRA', 'IPv6SendRA', 'IPv6Prefix', 'IPv6RoutePrefix',
                  'DHCPServer', 'DHCPServerStaticLease', 'Neighbor', 'IPv6AddressLabel'}
SECTIONS_PORT = {'Link', 'LLDP'}
NETWORK_MOVED = {'Description', 'DHCP', 'Address', 'Gateway', 'DNS', 'Domains', 'DNSDefaultRoute', 'NTP',
                 'LinkLocalAddressing', 'IPv6LinkLocalAddressGenerationMode', 'IPv6StableSecretAddress',
                 'IPv4LLRoute', 'IPv4LLStartAddress', 'DefaultRouteOnDevice', 'IPv6AcceptRA',
                 'IPv6PrivacyExtensions', 'IPv6DuplicateAddressDetection', 'IPv6HopLimit',
                 'IPv6RetransmissionTimeSec', 'IPv4ProxyARP', 'IPv4ProxyARPPrivateVLAN', 'IPv6ProxyNDP',
                 'IPv6ProxyNDPAddress', 'IPv4AcceptLocal', 'IPv4RouteLocalnet', 'IPForward', 'IPv4Forwarding',
                 'IPv6Forwarding', 'IPMasquerade', 'IPv6SendRA', 'DHCPPrefixDelegation', 'DHCPServer',
                 'LLMNR', 'MulticastDNS', 'DNSOverTLS', 'DNSSEC', 'DNSSECNegativeTrustAnchors',
                 'ConfigureWithoutCarrier', 'IgnoreCarrierLoss', 'KeepConfiguration', 'IPv6MTUBytes',
                 'IPv4ReversePathFilter', 'MulticastRouter'}
NETWORK_PORT = {'LLDP', 'EmitLLDP'}
ONLINE = {'RequiredForOnline', 'RequiredFamilyForOnline'}


def port(path, uplink, mac, out):
    body, link, match = [], [], []
    by_name = by_mac = False
    dhcp = ''
    static4 = False
    for sect, key, value in parse(path):
        line = f'{key}={value}'
        if sect == 'Match':
            if key == 'Name':
                if value != uplink:
                    refuse(f'{path} matches the name "{value}", not {uplink} alone')
                by_name = True
            elif key in ('MACAddress', 'PermanentMACAddress'):
                if value.lower() != mac:
                    refuse(f'{path} matches {value}, not {uplink} ({mac}) alone')
                by_mac = by_mac or key == 'MACAddress'
            else:
                refuse(f'{path} matches by {key}')
            match.append(line)
            continue
        if key == 'IAID':
            refuse(f'{path} pins an IAID, which setup does not carry over')
        if sect == 'Network':
            if key in NETWORK_PORT:
                link.append(('Network', line))
                continue
            if key not in NETWORK_MOVED:
                refuse(f'{path} sets {key}= in [Network], which setup does not carry over to a bridge')
            if key == 'DHCP':
                dhcp = value
            if key == 'Address' and ':' not in value:
                static4 = True
            body.append(('Network', line))
        elif sect in SECTIONS_MOVED:
            if sect == 'Address' and key == 'Address' and ':' not in value:
                static4 = True
            # The DHCP identity is the one the uplink had, pinned by the plan.
            if sect in ('DHCP', 'DHCPv4') and key == 'ClientIdentifier':
                continue
            body.append((sect, line))
        elif sect in SECTIONS_PORT:
            (body if key in ONLINE else link).append((sect, line))
        else:
            refuse(f'{path} has a [{sect}] section, which setup does not carry over to a bridge')
    # The bridge takes the uplink's hardware address: a match on it alone would
    # take the bridge too.
    if by_mac and not by_name:
        refuse(f'{path} matches {uplink} by its hardware address alone, which the bridge takes too')

    def write(name, lines):
        with open(os.path.join(out, name), 'w') as f:
            last = None
            for sect, line in lines:
                if sect != last:
                    f.write(f'\n[{sect}]\n')
                    last = sect
                f.write(line + '\n')
    write('bridge.network.body', body)
    write('port.link', link)
    with open(os.path.join(out, 'port.match'), 'w') as f:
        f.write(''.join(m + '\n' for m in match))
    if dhcp.lower() in ('yes', 'true', 'on', '1', 'ipv4', 'both'):
        print('dhcp')
    elif static4:
        print('static')
    else:
        refuse(f'{uplink} has neither DHCPv4 nor a static IPv4 address in {path}')


COMMANDS = {'json': json_key, 'takers': takers, 'port': port}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
