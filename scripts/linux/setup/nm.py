"""NetworkManager's answers, read for net-networkmanager.sh; run with
python3 -I. The settings come from NetworkManager's D-Bus interface, where a
connection's settings are what differs from the defaults.

  nm.py path
      reads `busctl call --json=short … GetConnectionByUuid` on stdin; prints
      the connection's object path
  nm.py rows
      reads nmcli's terse tabular output on stdin; prints each row's fields
      tab-separated, its escapes (\\: and \\\\) read
  nm.py flags
      reads `busctl get-property --json=short … Flags` on stdin; prints them
  nm.py other <uplink> <uplink-uuid> <uplink-mac>
      reads another connection's `busctl call --json=short … GetSettings` on
      stdin; prints `dependent <setting.property>` when it hangs off the uplink
      (a parent, or a port, naming the uplink or its connection; a connection
      of another type bound to the uplink by name or hardware address),
      `taker` when it is an Ethernet connection not bound to another device,
      which could take the uplink too, and nothing otherwise
  nm.py unknown
      reads `busctl call --json=short … GetSettings` on stdin; prints each
      setting the bridge step neither carries to the bridge, keeps on its port,
      nor may leave behind, as setting.property
  nm.py carry <metric4> <metric6> <out-dir>
      reads `nmcli -t connection show <uuid>` on stdin; writes what goes to the
      bridge (bridge.carry) and what stays on the port (port.carry), one nmcli
      property and its value a line each, and the connection's own copy
      (copy.carry: its name, binding and both); a route metric NetworkManager
      leaves to the device type (-1) is the one the uplink's routes have
"""
import json
import sys

# Carried whole: to the bridge (layer 3 and what the host does with it), or
# kept on the port (layer 2, the device's own).
BRIDGE_SETTINGS = {'ipv4', 'ipv6', 'proxy', 'hostname'}
PORT_SETTINGS = {'802-3-ethernet', 'ethtool', 'link', 'tc', 'sriov'}
# Of the connection setting: what names the profile and binds it, which the
# step's own connections replace; what goes to the bridge; what stays on the
# port. Anything else set is refused — permissions among them: the bridge
# comes up at boot for the host, never for one user's session.
CONNECTION_OWN = {'id', 'uuid', 'type', 'interface-name', 'timestamp', 'autoconnect', 'autoconnect-priority'}
CONNECTION_BRIDGE = {'zone', 'mdns', 'llmnr', 'dns-over-tls', 'dnssec', 'metered', 'mptcp-flags'}
CONNECTION_PORT = {'lldp'}


def empty(v):
    return v in ([], {}, '', None)


def unknown():
    settings = json.load(sys.stdin)['data'][0]
    for name, props in sorted(settings.items()):
        if name in BRIDGE_SETTINGS or name in PORT_SETTINGS:
            continue
        for prop, value in sorted(props.items()):
            # Off, the step's connections (which connect by themselves) would
            # not carry it: refused.
            if name == 'connection' and prop == 'autoconnect' and value['data'] is False:
                print(f'{name}.{prop}')
                continue
            if name == 'connection' and prop in CONNECTION_OWN | CONNECTION_BRIDGE | CONNECTION_PORT:
                continue
            if empty(value['data']):
                continue
            print(f'{name}.{prop}')


# A property that names the link another one hangs off: a parent (vlan,
# macvlan, vxlan, ip-tunnel, macsec, ipvlan, …) or a port (hsr), by interface
# name or connection UUID. Which settings have one is NetworkManager's to grow:
# the property names are tested, not the connection types.
LOWER_PROPERTIES = {'parent', 'port1', 'port2'}
PATTERN_CHARS = set('*?[!~\\')


def mac_of(value):
    return ':'.join(f'{b:02x}' for b in value['data']) if value and value['data'] else ''


def other(uplink, uplink_uuid, uplink_mac):
    settings = json.load(sys.stdin)['data'][0]
    for name, props in sorted(settings.items()):
        for prop in sorted(LOWER_PROPERTIES & set(props)):
            if props[prop]['data'] in (uplink, uplink_uuid):
                print(f'dependent {name}.{prop}')
                return
    con = settings.get('connection', {})
    kind = con.get('type', {}).get('data')
    mac = mac_of(settings.get('802-3-ethernet', {}).get('mac-address'))
    bind = con.get('interface-name', {}).get('data') or ''
    if kind != '802-3-ethernet':
        # One without a parent names the device it runs on by its name (a
        # PPPoE connection) or its hardware address (a virtual link).
        if bind == uplink:
            print('dependent connection.interface-name')
        elif mac == uplink_mac:
            print('dependent 802-3-ethernet.mac-address')
        return
    match = settings.get('match', {}).get('interface-name', {}).get('data') or []
    if bind and bind != uplink or mac and mac != uplink_mac:
        return
    # Bound elsewhere by match.interface-name: every item a plain name (no
    # pattern, no `!` or `~`), none the uplink's.
    if match and all(item != uplink and not PATTERN_CHARS & set(item) for item in match):
        return
    print('taker')


def path():
    print(json.load(sys.stdin)['data'][0])


def rows():
    for line in sys.stdin.read().splitlines():
        fields, cur, esc = [], '', False
        for ch in line:
            if esc:
                cur, esc = cur + ch, False
            elif ch == '\\':
                esc = True
            elif ch == ':':
                fields.append(cur)
                cur = ''
            else:
                cur += ch
        fields.append(cur)
        print('\t'.join(fields))


def flags():
    print(json.load(sys.stdin)['data'])


def carry(metric4, metric6, out):
    files = {k: open(f'{out}/{k}.carry', 'w') for k in ('bridge', 'port', 'copy')}
    for line in sys.stdin.read().splitlines():
        key, sep, value = line.partition(':')
        if not sep or '.' not in key:
            continue
        setting, prop = key.split('.', 1)
        if value in ('', '--') or prop.endswith('-deprecated'):
            continue
        if setting == 'connection':
            where = ('bridge' if prop in CONNECTION_BRIDGE else 'port' if prop in CONNECTION_PORT
                     else 'own' if prop in CONNECTION_OWN - {'timestamp', 'type'} else None)
        else:
            where = 'bridge' if setting in BRIDGE_SETTINGS else 'port' if setting in PORT_SETTINGS else None
        if where is None:
            continue
        files['copy'].write(f'{key}\n{value}\n')
        if where == 'own':
            continue
        # The client identifier the bridge sends is the one the lease shows.
        if key == 'ipv4.dhcp-client-id':
            continue
        if key == 'ipv4.route-metric' and value == '-1' and metric4:
            value = metric4
        if key == 'ipv6.route-metric' and value == '-1' and metric6:
            value = metric6
        files[where].write(f'{key}\n{value}\n')
    for f in files.values():
        f.close()


COMMANDS = {'path': path, 'rows': rows, 'flags': flags, 'unknown': unknown, 'carry': carry, 'other': other}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
