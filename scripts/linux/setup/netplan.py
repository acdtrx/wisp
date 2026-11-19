"""The netplan plan's reads and checks, for net-netplan.sh; run as root with
python3 -I. python3, its yaml module and netplan's own Python module are
netplan's runtime, so a netplan host has them.

  netplan.py status-id <uplink>
      reads `netplan status --format json` on stdin; prints the id of the
      uplink's definition, empty when netplan has none
  netplan.py origin <id>
      the file netplan's parser reads the definition <id> from
  netplan.py plan <def-file> <id> <uplink> <mac> <bridge> <id-kind> <origin> <out-dir> <mtu>
      the uplink's definition checked, what moves to the bridge worked out, and
      the edits written as `netplan set` arguments into <out-dir>; prints dhcp or
      static. On DHCP the bridge's dhcp-identifier is <id-kind> (mac or duid,
      net-uplink.sh's dhcp_identity). Exit 3 with the reason printed: refused;
      exit 5: refused, the reason naming the edit that lifts it.
  netplan.py shared <origin> <dir>...
      prints a definition <origin> shares with another netplan file, if any
  netplan.py dependents <id>
      reads `netplan get` (the merged configuration) on stdin; prints each
      definition that hangs off <id> (its `link:`: a VLAN, a VXLAN tunnel, an
      SR-IOV virtual function) or holds it (its `interfaces:`: a bond, a
      bridge, a VRF), whatever its kind
  netplan.py merged <id> <bridge> <bridge-json>
      reads the merged configuration on stdin; prints what is not as setup
      wrote it, if anything
"""
import glob
import json
import os
import sys

import yaml

def refuse(why, code=3):
    print(why)
    sys.exit(code)


def refuse_match(why, uplink, mac):
    refuse(f'{why}: match {uplink} alone, by its name (match: {{name: {uplink}}}, or the definition\'s id {uplink} '
           f'with no match), with its hardware address {mac} if wanted', 5)


def status_id(uplink):
    print(json.load(sys.stdin).get(uplink, {}).get("id") or "")


def origin(nid):
    from netplan import Parser, State
    p = Parser()
    p.load_yaml_hierarchy("/")
    s = State()
    s.import_parser_results(p)
    print(s[nid].filepath)


# Layer 3 moves to the bridge and leaves the interface, critical (whether
# networkd keeps the address when it stops) with it. What stays with the
# interface: how it is matched and named, and its link settings. Copied to the
# bridge and kept: whether the boot waits for it.
MOVED = {'dhcp4', 'dhcp6', 'dhcp-identifier', 'dhcp4-overrides', 'dhcp6-overrides', 'accept-ra',
         'ra-overrides', 'ipv6-privacy', 'ipv6-address-generation', 'ipv6-address-token', 'ipv6-mtu',
         'link-local', 'addresses', 'gateway4', 'gateway6', 'routes', 'routing-policy', 'nameservers',
         'optional-addresses', 'critical'}
COPIED = {'optional'}
KEPT = {'match', 'set-name', 'wakeonlan', 'mtu', 'macaddress', 'emit-lldp', 'renderer',
        'receive-checksum-offload', 'transmit-checksum-offload', 'tcp-segmentation-offload',
        'tcp6-segmentation-offload', 'generic-segmentation-offload', 'generic-receive-offload',
        'large-receive-offload'}


def has_ipv4(addrs):
    for a in addrs or []:
        a = next(iter(a)) if isinstance(a, dict) else a
        if ':' not in str(a):
            return True
    return False


def plan(def_file, nid, uplink, mac, bridge, id_kind, origin_file, out, mtu):
    d = yaml.safe_load(open(def_file))
    if not isinstance(d, dict):
        refuse(f'netplan defines {uplink} ({nid}) elsewhere than "ethernets"')
    # Who the definition applies to: the uplink alone.
    match = d.get('match')
    if match is not None:
        by = sorted(set(match) - {'macaddress', 'name'})
        if by:
            refuse_match(f'netplan definition {nid} matches by {", ".join(by)}', uplink, mac)
        if 'macaddress' in match and str(match['macaddress']).lower() != mac:
            refuse_match(f'netplan definition {nid} matches {match["macaddress"]}, not {uplink} ({mac})', uplink, mac)
        if 'name' in match and match['name'] != uplink:
            refuse_match(f'netplan definition {nid} matches the name "{match["name"]}", not {uplink} alone', uplink, mac)
    elif nid != uplink:
        refuse_match(f'netplan definition {nid} does not name {uplink}', uplink, mac)
    if d.get('renderer', 'networkd') != 'networkd':
        refuse(f'{uplink}\'s netplan definition names the renderer {d["renderer"]}')

    other = sorted(set(d) - MOVED - COPIED - KEPT)
    if other:
        refuse(f'{uplink}\'s netplan definition has {", ".join(other)}, which setup does not carry over to a bridge')

    dhcp = d.get('dhcp4') is True
    if not dhcp and not has_ipv4(d.get('addresses')):
        refuse(f'{uplink} has neither DHCPv4 nor a static IPv4 address in netplan')

    bridge_def = {k: d[k] for k in (MOVED | COPIED) if k in d}
    # The uplink's MTU, on the bridge itself, so ports that join keep it.
    bridge_def.update({
        'interfaces': [nid],
        'macaddress': mac,
        'mtu': int(mtu),
        'parameters': {'stp': False},
    })
    if dhcp and id_kind:
        bridge_def['dhcp-identifier'] = id_kind

    hint = origin_file.rsplit('/', 1)[-1][:-len('.yaml')]
    with open(f'{out}/netplan-set.args', 'w') as f:
        # Off the interface; dhcp4 stays, as false, so the interface keeps a
        # definition of its own when nothing else is left in it.
        for k in sorted((MOVED & set(d)) - {'dhcp4'}):
            f.write(f'{hint}\tethernets.{nid}.{k}=null\n')
        f.write(f'{hint}\tethernets.{nid}.dhcp4=false\n')
        f.write(f'{hint}\tbridges.{bridge}={json.dumps(bridge_def, sort_keys=True)}\n')
    print('dhcp' if dhcp else 'static')


# netplan set writes the file back from its parsed state, merged lists
# included: a definition of that file that another file defines too would come
# back with that file's entries in it.
def shared(origin_file, *dirs):
    files = {}
    for d in dirs:
        for f in glob.glob(d + "/*.yaml"):
            files[os.path.basename(f)] = f

    def ids(path):
        net = (yaml.safe_load(open(path)) or {}).get("network") or {}
        return {(k, i) for k, v in net.items() if isinstance(v, dict) for i in v}

    mine = ids(origin_file)
    for name, path in sorted(files.items()):
        if path != origin_file:
            both = sorted(i for _, i in mine & ids(path))
            if both:
                print(f"{origin_file} defines {both[0]}, which {path} defines too")
                break


def merged(nid, bridge, wanted):
    net = yaml.safe_load(sys.stdin) or {}
    net = net.get("network", net)
    port = (net.get("ethernets") or {}).get(nid) or {}
    br = (net.get("bridges") or {}).get(bridge) or {}
    l3 = {"dhcp4", "dhcp6", "addresses", "routes", "routing-policy", "nameservers", "gateway4", "gateway6",
          "accept-ra", "link-local", "dhcp4-overrides", "dhcp6-overrides", "critical"}
    left = sorted(k for k in l3 & set(port) if port[k] not in (False, None, [], {}))
    want = json.loads(wanted)
    # netplan leaves out what has its default value.
    defaults = {"dhcp-identifier": "duid"}
    missing = sorted(k for k in want if k not in br and defaults.get(k) != want[k])
    if left:
        print(nid + " still has " + ", ".join(left))
    elif missing or br.get("interfaces") != [nid] or str(br.get("macaddress")).lower() != want["macaddress"]:
        print(bridge + " is not the bridge setup wrote (" + (", ".join(missing) or "interfaces or hardware address") + ")")


# The keys that tie a definition to another are tested in every section, not
# in a list of kinds netplan may grow.
def dependents_of(net, nid):
    out = []
    for section, defs in sorted(net.items()):
        if not isinstance(defs, dict):
            continue
        for name, d in sorted(defs.items()):
            if not isinstance(d, dict) or (section, name) == ('ethernets', nid):
                continue
            if d.get('link') == nid or nid in (d.get('interfaces') or []):
                out.append(f'{section}.{name}')
    return out


def dependents(nid):
    net = (yaml.safe_load(sys.stdin) or {}).get('network') or {}
    for d in dependents_of(net, nid):
        print(d)


COMMANDS = {'status-id': status_id, 'origin': origin, 'plan': plan, 'shared': shared, 'merged': merged,
            'dependents': dependents}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
