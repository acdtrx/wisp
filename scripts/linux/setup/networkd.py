"""systemd-networkd's files and status, read for the network plan and the
bridge's check; run as root with lib.sh's SETUP_PYTHON. A file is read as
networkd reads it: sections, `Key=value` lines, `#` and `;` comments, a
trailing backslash continuing a line.

  networkd.py json <path>
      reads `networkctl status <link> --json=short` on stdin; prints the value
      at <path> (keys joined by dots), nothing when it is not there: a string as
      it is, a list one item a line
  networkd.py takers <uplink> <mac> <permaddr> <driver> <own-file>
      prints each .network file, but <own-file> (the one netplan renders for
      the uplink), whose [Match] could take the uplink — a second definition
      for it. networkd runs a link from the first file, by name, that matches
      it: a file whose name sorts after <own-file>'s (an initrd's catch-all
      fallback, zzzz-…) never takes the uplink.
"""
import fnmatch
import json
import os
import sys

DIRS = ("/etc/systemd/network", "/run/systemd/network", "/usr/local/lib/systemd/network",
        "/usr/lib/systemd/network", "/lib/systemd/network")


def refuse(why, code=3):
    print(why)
    sys.exit(code)


def parse(path):
    """[(section, n, key, value)], in the file's order; n numbers the section's
    headers, as two [Route] sections are two routes."""
    out, sect, n, pending = [], None, 0, ''
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
                n += 1
                continue
            if '=' not in s:
                refuse(f'{path}: "{s}" is not a setting')
            if sect is None:
                refuse(f'{path}: a setting outside any section')
            key, value = s.split('=', 1)
            out.append((sect, n, key.strip(), value.strip()))
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


def takers(uplink, mac, permaddr, driver, own):
    # What the uplink is, for each [Match] key; a key not listed here is a
    # condition on the host (Host=, Virtualization=, KernelCommandLine=, …) or
    # one setup cannot read, and is taken as met.
    # As networkd matches: MACAddress= the current address, PermanentMACAddress=
    # the permanent one (permaddr, empty when they are the same).
    facts = {'Name': uplink, 'OriginalName': uplink, 'MACAddress': mac, 'PermanentMACAddress': permaddr or mac,
             'Driver': driver or None, 'Type': 'ether', 'Kind': None, 'WLANInterfaceType': None,
             'SSID': None, 'BSSID': None}
    own_name = os.path.basename(own)
    for name, path in files().items():
        if name >= own_name:
            continue
        conds = {}
        for sect, _, key, value in parse(path):
            if sect == 'Match':
                conds[key] = (conds.get(key, '') + ' ' + value).strip() if value else ''
        # networkd ignores a file with no condition in [Match].
        if not any(conds.values()):
            continue
        if all(matches(v, facts[k]) for k, v in conds.items() if k in facts and v):
            print(path)


COMMANDS = {'json': json_key, 'takers': takers}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
