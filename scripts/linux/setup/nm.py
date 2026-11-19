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
            if name == 'connection' and prop in CONNECTION_OWN | CONNECTION_BRIDGE | CONNECTION_PORT:
                continue
            if empty(value['data']):
                continue
            print(f'{name}.{prop}')


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


COMMANDS = {'path': path, 'rows': rows, 'flags': flags, 'unknown': unknown, 'carry': carry}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
