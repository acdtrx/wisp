# Sourced by setup and the installer, as root; do not execute it. Works out,
# changing nothing, how this host's network is run and which bridge Wisp uses,
# and refuses a host setup cannot serve — before anything changes.
#
# A Wisp host needs a bridge: without one no VM or container has a network.
# The bridge is the one carrying the uplink (the default route's interface), or
# else `br0`, which the bridge step, setup's last change, creates on the uplink
# through the tool that runs it, asked of the daemons: systemd-networkd from
# netplan's files (netplan), systemd-networkd from its own files (networkd), or
# NetworkManager. The stub interface is declared through it too.
#
# Setup makes the bridge only for the uplink shape it can do completely and
# verify: a plain Ethernet interface, on DHCP or with a static address set
# through the host's tool, defined on its own (no wildcard or multi-interface
# match). Its whole layer 3 — addresses, routes, gateways, name servers and
# search domains, routing policy, DHCP settings — moves to the bridge and
# leaves the interface, in the tool's own files, edited through the tool.
# Every other shape — a bond, a VLAN, Wi-Fi, a tunnel, a shared definition, a
# setting setup cannot carry over — is refused here, naming what was found: the
# operator makes the bridge with the host's own tool, and setup then uses it.
# So is a host none of the three tools runs.
#
# Everything that can refuse is worked out here, the bridge's configuration
# included: rendered into NET_PLAN_DIR, and for netplan checked as a whole by
# netplan itself. The plan runs once per entry point: what it found is kept in
# NET_PLAN_DIR/plan.env, which a step sourcing this file reads instead of
# working it out again; the process that works it out removes NET_PLAN_DIR when
# it exits. It is made under the install lock, in the run that applies it.
#
# Sets (and records):
#   NET_TOOL        netplan | networkd | networkmanager
#   UPLINK          the default route's interface
#   UPLINK_ADDR     its IPv4 address with prefix
#   BRIDGE          the bridge Wisp uses
#   BRIDGE_CREATE   yes when the bridge step must create BRIDGE on UPLINK
# and, when it must:
#   UPLINK_MAC        the uplink's hardware address, which the bridge takes
#   UPLINK_MODE       dhcp (DHCPv4, with or without static addresses) | static
#   UPLINK_CLIENT_ID  on DHCP, its DHCPv4 client identifier (hex bytes,
#                     colon-separated), which the bridge sends too
#   NET_PLAN_DIR      uplink.state, what the uplink holds (net-state.sh), and
#                     the bridge's configuration, worked out:
#     netplan:        netplan-origin.yaml (the operator's file, edited with
#                     `netplan set` and checked whole in a stage copy of
#                     /lib, /etc and /run/netplan), 50-wisp-dhcp-identity.conf
#     networkd:       bridge.netdev, bridge.network, port.network (the
#                     uplink's own file, rewritten as the port's definition)
#     networkmanager: bridge.nmconnection, port.nmconnection (keyfiles,
#                     rendered and checked by `nmcli --offline`)
#   UPLINK_NETPLAN_ID     netplan: the uplink's definition id
#   NETPLAN_ORIGIN        netplan: the file that defines it
#   UPLINK_MTU            the uplink's MTU, which the bridge's definition sets
#   NETWORKD_PORT_FILE    networkd: the uplink's own file under /etc (in place,
#                         or overriding a vendor file), which becomes the port's
#   UPLINK_CONNECTION     networkmanager: the uplink's connection (UUID), which
#                         the bridge step deletes last
#   NM_PROFILE_FILE       networkmanager: the file under /etc that stores it,
#                         when there is one (kept as the original)
#   NM_BRIDGE_UUID, NM_PORT_UUID, NM_BRIDGE_FILE, NM_PORT_FILE
#                         networkmanager: the connections to add, and their keyfiles
#   NET_PLAN_DIR/sources  what the plan was made from, which the bridge step
#                         checks is unchanged before it applies
#   NET_PLAN_JOURNAL      what an earlier bridge step's journal was found to
#                         be (see bridge-journal.sh), when there was one
#
# NET_PLAN_ASK=1 (the installer's asking phase): changes nothing, a journal
# included — it is only classified, and the installer says what will be done.
#
# Also refused before any change, whatever the uplink: another DNS server on
# the stub's port 53. And first of all, a bridge step that died is undone
# (bridge-journal.sh).

if [[ -n "${NET_PLAN_DIR:-}" && -f "$NET_PLAN_DIR/plan.env" ]]; then
  # shellcheck source=/dev/null
  source "$NET_PLAN_DIR/plan.env"
  return 0
fi

# shellcheck source=net-state.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-state.sh"
# shellcheck source=bridge-journal.sh
source "$(dirname "${BASH_SOURCE[0]}")/bridge-journal.sh"

net_refuse() {
  echo "ERROR: $*" >&2
  echo "       Setup makes Wisp's bridge on a plain Ethernet uplink, on DHCP or with a static" >&2
  echo "       address, run by netplan, NetworkManager or systemd-networkd. Make the bridge on" >&2
  echo "       this host's uplink with its own network tool and run this again: setup then" >&2
  echo "       uses that bridge." >&2
  exit 1
}
# A network tool that fails is a failure, never a refusal. Used as
# `v="$(net_read …)" || exit 1`: the failure is reported from the subshell.
net_fail() {
  echo "ERROR: $*" >&2
  exit 1
}
net_read() {
  local rc=0
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" "$@" || rc=$?
  (( rc == 0 )) || net_fail "'$*' failed (exit $rc)"
}

NET_PLAN_DIR="$(mktemp -d -t wisp-net-plan.XXXXXX)" || net_fail "cannot create a temp directory"
export NET_PLAN_DIR
# A step's own temp directory (step.sh) goes too, as its trap is replaced here.
trap 'rm -rf "$NET_PLAN_DIR" ${STEP_TMP_DIR:+"$STEP_TMP_DIR"}' EXIT

# A bridge step that died left its journal: decided on first, from what the
# host holds now (bridge-journal.sh), before anything is worked out.
NET_PLAN_JOURNAL=""
if [[ -d "$JOURNAL_DIR.done" && -z "${NET_PLAN_ASK:-}" ]]; then
  journal_cleanup
fi
if [[ -d "$JOURNAL_DIR" ]]; then
  NET_PLAN_JOURNAL="$(journal_classify)"
  case "$NET_PLAN_JOURNAL" in
    fail\ *) net_fail "${NET_PLAN_JOURNAL#fail }: setup cannot tell what the bridge step that left its journal in $JOURNAL_DIR changed." ;;
    bad\ *) net_fail "${NET_PLAN_JOURNAL#bad }. Put the network as you want it, remove $JOURNAL_DIR (its files/ holds the originals of what the step changed), and run this again." ;;
    changed\ *)
      net_fail "a bridge step that did not finish left its journal in $JOURNAL_DIR, and since then someone else changed ${NET_PLAN_JOURNAL#changed }: setup does not undo over that. Put each back as the step wrote it or as it was (its files/ holds the originals), or remove $JOURNAL_DIR once the network is as you want it, and run this again." ;;
  esac
  if [[ -n "${NET_PLAN_ASK:-}" ]]; then
    # The asking phase changes nothing, so it cannot plan on a host the work
    # will first undo or commit: it asks from the journal's own record.
    _journal_read || true
    case "$NET_PLAN_JOURNAL" in
      restore)
        NET_TOOL="$J_TOOL" UPLINK="$J_UPLINK" UPLINK_ADDR="$J_ADDR" BRIDGE="$J_BRIDGE" BRIDGE_CREATE=yes
        return 0 ;;
      finished)
        NET_TOOL="$J_TOOL" UPLINK="$J_BRIDGE" UPLINK_ADDR="$J_ADDR" BRIDGE="$J_BRIDGE" BRIDGE_CREATE=no
        return 0 ;;
    esac
  else
    case "$NET_PLAN_JOURNAL" in
      finished)
        echo "A bridge step that was not recorded as done had in fact finished: committing it." >&2
        journal_commit >&2 || net_fail "cannot commit the journal in $JOURNAL_DIR" ;;
      untouched)
        echo "A bridge step left a journal but changed nothing: dropping it." >&2
        journal_drop || net_fail "cannot remove $JOURNAL_DIR" ;;
      restore)
        echo "A bridge step that did not finish left its journal in $JOURNAL_DIR: undoing it first." >&2
        journal_restore || net_fail "undoing the earlier bridge step did not complete; its journal stays in $JOURNAL_DIR for the next run (docs/specs/DEPLOYMENT.md, The bridge, says what to do at the console)."
        echo "  The network is as it was before that step." >&2 ;;
    esac
  fi
fi

_route="$(net_read ip -4 route show default)" || exit 1
UPLINK="$(awk '!done { for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); done = 1; break } }' <<<"$_route")"
[[ -n "$UPLINK" ]] || net_refuse "this host has no IPv4 default route, so no uplink to bridge."
_addrs="$(net_read ip -4 -o addr show dev "$UPLINK" scope global)" || exit 1
UPLINK_ADDR="$(awk '!done { print $4; done = 1 }' <<<"$_addrs")"

# Which tool runs the uplink: ask the daemons. systemd-networkd names the file
# it runs a link from (netplan renders its own under /run); NetworkManager
# reports the link connected.
NET_TOOL=""
_netfile=""
if systemctl is-active --quiet systemd-networkd; then
  _json="$(net_read networkctl status "$UPLINK" --json=short)" || exit 1
  _netfile="$(json_string "$_json" NetworkFile || true)"
  case "$_netfile" in
    /run/systemd/network/10-netplan-*) NET_TOOL=netplan ;;
    /*) NET_TOOL=networkd ;;
  esac
fi
if [[ -z "$NET_TOOL" ]] && systemctl is-active --quiet NetworkManager; then
  _status="$(net_read nmcli -g GENERAL.STATE device show "$UPLINK")" || exit 1
  # "100 (connected)": through one of NetworkManager's profiles, not merely
  # seen configured by something else ("connected (externally)").
  case "$_status" in
    "100 (connected)") NET_TOOL=networkmanager ;;
    100*) net_refuse "$UPLINK is up, but not through a NetworkManager profile ($_status)." ;;
  esac
fi
if [[ -z "$NET_TOOL" ]] && grep -qsE "^[[:space:]]*iface[[:space:]]+$UPLINK([[:space:]]|$)" /etc/network/interfaces /etc/network/interfaces.d/*; then
  net_refuse "$UPLINK is run by ifupdown (/etc/network/interfaces), which setup does not configure."
fi
[[ -n "$NET_TOOL" ]] || net_refuse "$UPLINK is run by none of netplan, NetworkManager or systemd-networkd."

# cloud-init managing the network: setup never edits what cloud-init writes
# nor changes cloud-init's own configuration, so such a host is refused. It
# manages the network when it is installed, not switched off as a whole
# (/etc/cloud/cloud-init.disabled, cloud-init=disabled on the kernel command
# line), and its merged configuration (/etc/cloud/cloud.cfg, then
# cloud.cfg.d/*.cfg in name order, the last word winning) does not say
# `network: {config: disabled}` — nor network-config=disabled on the command
# line. An installer that writes the host's own netplan file (Ubuntu Server's)
# switches it off that way. cloud-init's own runtime, python3 and its yaml
# module, reads the files.
refuse_cloud_init_network() {
  if command -v cloud-init >/dev/null && [[ ! -e /etc/cloud/cloud-init.disabled ]] \
    && ! grep -qwE 'cloud-init=disabled|network-config=disabled' /proc/cmdline; then
    _ci="$(python3 -c '
import glob, sys, yaml
state = "managed"
for path in ["/etc/cloud/cloud.cfg"] + sorted(glob.glob("/etc/cloud/cloud.cfg.d/*.cfg")):
    try:
        doc = yaml.safe_load(open(path)) or {}
    except FileNotFoundError:
        continue
    net = doc.get("network") if isinstance(doc, dict) else None
    if isinstance(net, dict) and "config" in net:
        state = "managed" if net["config"] != "disabled" else "off:" + path
print(state)
')" || net_fail "cannot read cloud-init's configuration in /etc/cloud"
    if [[ "$_ci" != off:* ]]; then
      echo "ERROR: cloud-init manages this host's network, and setup does not edit what cloud-init writes." >&2
      echo "       Switch its networking off with the one documented line, network: {config: disabled}," >&2
      echo "       in a file under /etc/cloud/cloud.cfg.d/ (for example 99-disable-network-config.cfg)," >&2
      echo "       keep the network's definition as a file of your own, and run this again." >&2
      exit 1
    fi
    unset _ci
  fi
}

# Port 53 on the stub address: Wisp's container DNS forwarder binds it, and a
# backend that cannot fails its start. Another DNS server listening there, or
# on every IPv4 address (AdGuard Home, Pi-hole, unbound, bind9, dnsmasq), is refused
# before anything changes. Wisp's own backend holding it is not another.
_listeners="$(net_read ss -Hlnup '( sport = :53 )')" || exit 1
_listeners+=$'\n'"$(net_read ss -Hlntp '( sport = :53 )')" || exit 1
while read -r _l; do
  [[ -n "$_l" ]] || continue
  _local="$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /:53$/) { print $i; exit } }' <<<"$_l")"
  case "$_local" in
    # A wildcard bound to one device takes the port from the stub too (the
    # forwarder's UDP bind then fails with EADDRINUSE); [::]:53 is IPv6 only
    # and leaves it free.
    169.254.53.53:53 | 0.0.0.0:53 | 0.0.0.0%*:53 | '*:53' | '*%'*:53) ;;
    *) continue ;;
  esac
  _pid="$(grep -o 'pid=[0-9]*' <<<"$_l" | head -n 1 | cut -d= -f2 || true)"
  if [[ -n "$_pid" ]] && grep -q '/wisp\.service' "/proc/$_pid/cgroup" 2>/dev/null; then continue; fi
  _who="$(grep -o '(("[^"]*"' <<<"$_l" | head -n 1 | tr -d '("' || true)"
  echo "ERROR: ${_who:-a process}${_pid:+ (pid $_pid)} listens on $_local, where Wisp's container DNS forwarder" >&2
  echo "       listens (169.254.53.53:53). Bind that server to the addresses it serves, not to every" >&2
  echo "       address, and run this again." >&2
  exit 1
done <<<"$_listeners"
unset _listeners _l _local _pid _who

if [[ -d "/sys/class/net/$UPLINK/bridge" ]]; then
  BRIDGE="$UPLINK"
  BRIDGE_CREATE=no
else
  BRIDGE=br0
  BRIDGE_CREATE=yes
  # What follows matters only when setup makes the bridge.
  refuse_cloud_init_network
  [[ ! -d "/sys/class/net/$UPLINK/bonding" ]] || net_refuse "the uplink $UPLINK is a bond."
  [[ ! -d "/sys/class/net/$UPLINK/wireless" ]] || net_refuse "the uplink $UPLINK is a Wi-Fi interface."
  [[ ! -e "/proc/net/vlan/$UPLINK" ]] || net_refuse "the uplink $UPLINK is a VLAN."
  [[ -e "/sys/class/net/$UPLINK/device" && "$(cat "/sys/class/net/$UPLINK/type")" == 1 ]] \
    || net_refuse "the uplink $UPLINK is not a physical Ethernet interface."
  [[ ! -e "/sys/class/net/$BRIDGE" ]] \
    || net_refuse "$BRIDGE exists but does not carry the uplink $UPLINK; Wisp would bridge $UPLINK as $BRIDGE."
  [[ -n "$UPLINK_ADDR" ]] || net_refuse "the uplink $UPLINK has no IPv4 address."
  UPLINK_MAC="$(cat "/sys/class/net/$UPLINK/address")"
  UPLINK_MTU="$(cat "/sys/class/net/$UPLINK/mtu")"

  case "$NET_TOOL" in
    netplan)
      # python3, its yaml module and netplan's own Python module are netplan's
      # runtime.
      _status="$(net_read netplan status "$UPLINK" --format json)" || exit 1
      UPLINK_NETPLAN_ID="$(python3 -c 'import json, sys; print(json.loads(sys.argv[2]).get(sys.argv[1], {}).get("id") or "")' "$UPLINK" "$_status")" \
        || net_fail "cannot read netplan's status for $UPLINK"
      [[ -n "$UPLINK_NETPLAN_ID" ]] || net_refuse "netplan has no definition for the uplink $UPLINK."
      # The file the definition comes from, as netplan's parser reads it.
      NETPLAN_ORIGIN="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" python3 -c '
import sys
from netplan import Parser, State
p = Parser(); p.load_yaml_hierarchy("/")
s = State(); s.import_parser_results(p)
print(s[sys.argv[1]].filepath)
' "$UPLINK_NETPLAN_ID")" || net_fail "netplan cannot parse its configuration"
      [[ "$NETPLAN_ORIGIN" == /etc/netplan/*.yaml ]] \
        || net_refuse "netplan defines $UPLINK in $NETPLAN_ORIGIN, outside /etc/netplan, where setup cannot edit it."
      _json="$(net_read networkctl status "$UPLINK" --json=short)" || exit 1
      UPLINK_CLIENT_ID="$(client_id "$UPLINK" "$NET_TOOL")"
      _def="$NET_PLAN_DIR/uplink.yaml"
      net_read netplan get "ethernets.$UPLINK_NETPLAN_ID" > "$_def" || exit 1
      # The uplink's definition, checked; what moves to the bridge worked out;
      # the edits written as `netplan set` arguments (one per line: the origin
      # hint, a tab, key=value), all in the operator's file that defines the
      # uplink: its layer-3 keys removed, and the bridge defined with them.
      IFS= read -r -d '' _py <<'PY' || true
import json
import sys
import yaml

def_file, nid, uplink, mac, bridge, client_id, origin, out, mtu = sys.argv[1:10]
d = yaml.safe_load(open(def_file))

def refuse(why):
    print(why)
    sys.exit(3)

if not isinstance(d, dict):
    refuse(f'netplan defines {uplink} ({nid}) elsewhere than "ethernets"')
# Who the definition applies to: the uplink alone.
match = d.get('match')
if match is not None:
    by = sorted(set(match) - {'macaddress', 'name'})
    if by:
        refuse(f'netplan definition {nid} matches by {", ".join(by)}')
    if 'macaddress' in match and str(match['macaddress']).lower() != mac:
        refuse(f'netplan definition {nid} matches {match["macaddress"]}, not {uplink} ({mac})')
    if 'name' in match and match['name'] != uplink:
        refuse(f'netplan definition {nid} matches the name "{match["name"]}", not {uplink} alone')
elif nid != uplink:
    refuse(f'netplan definition {nid} does not name {uplink}')
if d.get('renderer', 'networkd') != 'networkd':
    refuse(f'{uplink}\'s netplan definition names the renderer {d["renderer"]}')

# Layer 3 moves to the bridge and leaves the interface. What stays with the
# interface: how it is matched and named, and its link settings. Copied to the
# bridge and kept: whether the boot waits for it.
MOVED = {'dhcp4', 'dhcp6', 'dhcp-identifier', 'dhcp4-overrides', 'dhcp6-overrides', 'accept-ra',
         'ra-overrides', 'ipv6-privacy', 'ipv6-address-generation', 'ipv6-address-token', 'ipv6-mtu',
         'link-local', 'addresses', 'gateway4', 'gateway6', 'routes', 'routing-policy', 'nameservers',
         'optional-addresses'}
COPIED = {'optional'}
KEPT = {'match', 'set-name', 'wakeonlan', 'mtu', 'macaddress', 'emit-lldp', 'renderer',
        'receive-checksum-offload', 'transmit-checksum-offload', 'tcp-segmentation-offload',
        'tcp6-segmentation-offload', 'generic-segmentation-offload', 'generic-receive-offload',
        'large-receive-offload'}
if d.get('critical'):
    refuse(f'{uplink}\'s netplan definition is critical: true, which keeps its address on the interface')
other = sorted(set(d) - MOVED - COPIED - KEPT - {'critical'})
if other:
    refuse(f'{uplink}\'s netplan definition has {", ".join(other)}, which setup does not carry over to a bridge')

def has_ipv4(addrs):
    for a in addrs or []:
        a = next(iter(a)) if isinstance(a, dict) else a
        if ':' not in str(a):
            return True
    return False
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
dropin = ''
if dhcp:
    cid = [int(b, 16) for b in client_id.split(':')] if client_id else []
    if not cid:
        refuse(f'{uplink} is on DHCP but has no lease')
    if cid[0] == 1:
        bridge_def['dhcp-identifier'] = 'mac'
    elif cid[0] == 255 and len(cid) > 5:
        # netplan has no IAID key: networkd's drop-in on netplan's unit for the
        # bridge pins it, for DHCPv6 too — the uplink had networkd's default for
        # its name, the same for both.
        bridge_def['dhcp-identifier'] = 'duid'
        iaid = int.from_bytes(bytes(cid[1:5]), 'big')
        dropin = (
            f'# Written by Wisp setup: {bridge} keeps the DHCP identity {uplink} had\n'
            f'# (DUID with IAID {iaid}), so the DHCP server hands it the same lease.\n'
            f'[DHCPv4]\nClientIdentifier=duid\nIAID={iaid}\n\n[DHCPv6]\nIAID={iaid}\n'
        )
    else:
        refuse(f'{uplink}\'s DHCPv4 client identifier is of type {cid[0]}, which setup does not carry over')

hint = origin.rsplit('/', 1)[-1][:-len('.yaml')]
with open(f'{out}/netplan-set.args', 'w') as f:
    # Off the interface; dhcp4 stays, as false, so the interface keeps a
    # definition of its own when nothing else is left in it.
    for k in sorted((MOVED & set(d)) - {'dhcp4'}):
        f.write(f'{hint}\tethernets.{nid}.{k}=null\n')
    f.write(f'{hint}\tethernets.{nid}.dhcp4=false\n')
    f.write(f'{hint}\tbridges.{bridge}={json.dumps(bridge_def, sort_keys=True)}\n')
with open(f'{out}/50-wisp-dhcp-identity.conf', 'w') as f:
    f.write(dropin)
print('dhcp' if dhcp else 'static')
PY
      UPLINK_MODE="$(python3 -c "$_py" "$_def" "$UPLINK_NETPLAN_ID" "$UPLINK" "$UPLINK_MAC" "$BRIDGE" "$UPLINK_CLIENT_ID" "$NETPLAN_ORIGIN" "$NET_PLAN_DIR" "$UPLINK_MTU")" \
        || { _rc=$?; if (( _rc == 3 )); then net_refuse "$UPLINK_MODE."; fi; net_fail "cannot work out the bridge for netplan: $UPLINK_MODE"; }
      # netplan set writes the file back from its parsed state, merged lists
      # included: a definition of that file that another file defines too would
      # come back with that file's entries in it.
      _why="$(python3 -c '
import glob, os, sys, yaml
origin = sys.argv[1]
files = {}
for d in ("/lib/netplan", "/etc/netplan", "/run/netplan"):
    for f in glob.glob(d + "/*.yaml"):
        files[os.path.basename(f)] = f
def ids(path):
    net = (yaml.safe_load(open(path)) or {}).get("network") or {}
    return {(k, i) for k, v in net.items() if isinstance(v, dict) for i in v}
mine = ids(origin)
for name, path in sorted(files.items()):
    if path != origin:
        both = sorted(i for _, i in mine & ids(path))
        if both:
            print(f"{origin} defines {both[0]}, which {path} defines too"); break
' "$NETPLAN_ORIGIN")" || net_fail "cannot read netplan's files"
      [[ -z "$_why" ]] || net_refuse "$_why; setup would write that definition back merged."
      # The edits made in a staged copy of /etc/netplan, generated, and the
      # merged definitions read back: the interface must keep no layer 3, the
      # bridge must be what setup wrote.
      _stage="$NET_PLAN_DIR/stage"
      for _d in /lib/netplan /etc/netplan /run/netplan; do
        [[ ! -d "$_d" ]] && continue
        mkdir -p "$_stage$(dirname "$_d")" && cp -a "$_d" "$_stage$_d" || net_fail "cannot stage $_d"
      done
      while IFS=$'\t' read -r _hint _kv; do
        net_read netplan set --root-dir "$_stage" --origin-hint "$_hint" "$_kv" || exit 1
      done < "$NET_PLAN_DIR/netplan-set.args"
      # netplan set touches the origin file alone: every other file in the stage
      # must still be its live one, and none new, so what is checked is what
      # goes live.
      for _d in /lib/netplan /etc/netplan /run/netplan; do
        for _f in "$_d"/* "$_stage$_d"/*; do
          [[ -e "$_f" || -L "$_f" ]] || continue
          _f="${_f#"$_stage"}"
          [[ "$_f" == "$NETPLAN_ORIGIN" ]] && continue
          if [[ -e "$_f" && -e "$_stage$_f" ]]; then
            cmp -s "$_f" "$_stage$_f" || net_fail "netplan set changed $_f in the stage, beside $NETPLAN_ORIGIN"
          elif [[ -e "$_stage$_f" ]]; then
            net_fail "netplan set made $_f in the stage, beside $NETPLAN_ORIGIN"
          else
            net_fail "netplan set removed $_f in the stage, beside $NETPLAN_ORIGIN"
          fi
        done
      done
      net_read netplan generate --root-dir "$_stage" >/dev/null || exit 1
      _merged="$(net_read netplan get --root-dir "$_stage")" || exit 1
      _why="$(python3 -c '
import json, sys, yaml
nid, bridge, wanted = sys.argv[1:4]
net = yaml.safe_load(sys.stdin) or {}
net = net.get("network", net)
port = (net.get("ethernets") or {}).get(nid) or {}
br = (net.get("bridges") or {}).get(bridge) or {}
l3 = {"dhcp4", "dhcp6", "addresses", "routes", "routing-policy", "nameservers", "gateway4", "gateway6",
      "accept-ra", "link-local", "dhcp4-overrides", "dhcp6-overrides"}
left = sorted(k for k in l3 & set(port) if port[k] not in (False, None, [], {}))
want = json.loads(wanted)
# netplan leaves out what has its default value.
defaults = {"dhcp-identifier": "duid"}
missing = sorted(k for k in want if k not in br and defaults.get(k) != want[k])
if left:
    print(nid + " still has " + ", ".join(left))
elif missing or br.get("interfaces") != [nid] or str(br.get("macaddress")).lower() != want["macaddress"]:
    print(bridge + " is not the bridge setup wrote (" + (", ".join(missing) or "interfaces or hardware address") + ")")
' "$UPLINK_NETPLAN_ID" "$BRIDGE" "$(awk -F'\t' -v k="bridges.$BRIDGE=" 'index($2, k) == 1 { print substr($2, length(k) + 1) }' "$NET_PLAN_DIR/netplan-set.args")" <<<"$_merged")" \
        || net_fail "cannot read the staged netplan configuration back"
      [[ -z "$_why" ]] || net_refuse "with setup's edits, netplan's merged configuration is not what setup wrote: $_why."
      # The DUID drop-in attaches to the unit netplan renders for the bridge.
      if [[ -s "$NET_PLAN_DIR/50-wisp-dhcp-identity.conf" && ! -f "$_stage/run/systemd/network/10-netplan-$BRIDGE.network" ]]; then
        net_refuse "netplan renders no 10-netplan-$BRIDGE.network for the DHCP identity's drop-in."
      fi
      # What was checked is what goes live: the edited file, as the stage holds it.
      cp -a "$_stage$NETPLAN_ORIGIN" "$NET_PLAN_DIR/netplan-origin.yaml" || net_fail "cannot keep the checked $NETPLAN_ORIGIN"
      rm -rf "$_stage"
      unset _hint _kv
      ;;

    networkd)
      # The uplink's own file becomes its definition as the bridge's port: the
      # same name under /etc/systemd/network — in place, or, for a vendor file
      # under /usr/lib or /lib, the networkd way of overriding it. A file under
      # /run is generated by something else, which would write it back.
      case "$_netfile" in
        /etc/systemd/network/*.network) NETWORKD_PORT_FILE="$_netfile" ;;
        /usr/lib/systemd/network/*.network | /lib/systemd/network/*.network)
          NETWORKD_PORT_FILE="/etc/systemd/network/${_netfile##*/}" ;;
        /run/*) net_refuse "$UPLINK is run from $_netfile, which something on this host generates: setup does not edit it." ;;
        *) net_refuse "$UPLINK is run from $_netfile, outside systemd-networkd's own directories." ;;
      esac
      journal_root_ok "$NETWORKD_PORT_FILE" || net_refuse "$UPLINK is run from $_netfile, which setup cannot record to undo."
      _json="$(net_read networkctl status "$UPLINK" --json=short)" || exit 1
      # A drop-in applies to whichever file has its name: left alone, it would
      # put its settings back on the port, and moving it means editing several
      # files whose meaning depends on their order. Folded into the file by the
      # operator, it moves with the rest.
      _dropins="$(json_array "$_json" NetworkFileDropins || true)"
      [[ -z "${_dropins//[[:space:]]/}" ]] \
        || net_refuse "$UPLINK's $_netfile has drop-ins (${_dropins//\"/}): fold them into the file, which setup then carries over whole."
      _sources=("$_netfile")
      UPLINK_CLIENT_ID="$(client_id "$UPLINK" "$NET_TOOL")"
      # The uplink's settings: its layer 3 moves to the bridge — [Network],
      # [Address], [Route] and DNS settings, its DHCP ones — with the DHCP
      # identity pinned below; its match and link settings ([Match], [Link])
      # stay with it, in its own file, now the port's definition. Refused,
      # naming it: a match on anything but the uplink alone, a setting that
      # ties the link to another device, a section of neither kind.
      _why="$(awk -v uplink="$UPLINK" -v mac="$UPLINK_MAC" -v out="$NET_PLAN_DIR/bridge.network.body" -v link_out="$NET_PLAN_DIR/port.link" -v match_out="$NET_PLAN_DIR/port.match" '
        function refuse(why) { print why; bad = 1; exit 3 }
        BEGIN {
          split("Bridge Bond VRF VLAN IPVLAN IPVTAP MACVLAN MACVTAP VXLAN Tunnel MACsec Xfrm KeepMaster " \
            "BindCarrier ActiveSlave PrimarySlave", k, " ")
          for (i in k) network_tied[k[i]] = 1
          split("Network Address Route RoutingPolicyRule NextHop DHCP DHCPv4 DHCPv6 DHCPPrefixDelegation " \
            "IPv6AcceptRA Link", s, " ")
          for (i in s) section_ok[s[i]] = 1
        }
        /^[ \t]*($|[#;])/ { next }
        /^[ \t]*\[.*\][ \t]*$/ {
          sect = $0; gsub(/^[ \t]*\[|\][ \t]*$/, "", sect)
          if (sect != "Match" && !(sect in section_ok)) refuse(FILENAME " has a [" sect "] section, which setup does not carry over to a bridge")
          if (sect == "Link") { if (!port_link++) print "\n[Link]" > link_out }
          else if (sect != "Match") { print "\n[" sect "]" > out; out_sect = sect }
          next
        }
        {
          key = $0; sub(/=.*/, "", key); gsub(/[ \t]/, "", key)
          val = $0; sub(/^[^=]*=[ \t]*/, "", val); sub(/[ \t]+$/, "", val)
          if (sect == "") refuse(FILENAME ": a setting outside any section")
          if (sect == "Match") {
            if (key == "Name") { if (val != uplink) refuse(FILENAME " matches the name \"" val "\", not " uplink " alone"); by_name = 1 }
            else if (key == "MACAddress" || key == "PermanentMACAddress") {
              if (tolower(val) != mac) refuse(FILENAME " matches " val ", not " uplink " (" mac ") alone")
              if (key == "MACAddress") by_mac = 1
            }
            else refuse(FILENAME " matches by " key)
            print $0 > match_out
            next
          }
          if (sect == "Network" && (key in network_tied)) refuse(FILENAME " sets " key " in [Network], which ties " uplink " to another device")
          if (key == "IAID") refuse(FILENAME " pins an IAID, which setup does not carry over")
          if (sect == "Network" && key == "DHCP") dhcp = val
          if ((sect == "Network" || sect == "Address") && key == "Address" && val !~ /:/) static4 = 1
          if (sect ~ /^DHCP(v4)?$/ && key == "ClientIdentifier") next
          # What the boot waits for goes with the address; the rest of the link
          # stays on the port (which only reaches "enslaved").
          if (sect == "Link" && key ~ /^Required(Family)?ForOnline$/) {
            if (out_sect != "Link") { print "\n[Link]" > out; out_sect = "Link" }
            print $0 > out
          }
          else if (sect == "Link") print $0 > link_out
          else print $0 > out
        }
        END {
          if (bad) exit 3
          # The bridge takes the uplink'"'"'s hardware address: a match on it alone
          # would take the bridge too.
          if (by_mac && !by_name) { print FILENAME " matches " uplink " by its hardware address alone, which the bridge takes too"; exit 3 }
          if (dhcp ~ /^(yes|true|on|1|ipv4|both)$/) { print "dhcp"; exit 0 }
          if (static4) { print "static"; exit 0 }
          print uplink " has neither DHCPv4 nor a static IPv4 address in " FILENAME; exit 3
        }
      ' "${_sources[@]}")" || { _rc=$?; if (( _rc == 3 )); then net_refuse "$_why."; fi; net_fail "cannot read ${_sources[*]}: $_why"; }
      UPLINK_MODE="$_why"
      _identity=""
      if [[ "$UPLINK_MODE" == dhcp ]]; then
        _cid_type="${UPLINK_CLIENT_ID%%:*}"
        case "$_cid_type" in
          01) _identity=$'ClientIdentifier=mac\n' ;;
          ff)
            IFS=: read -r _ _a _b _c _d _ <<<"$UPLINK_CLIENT_ID"
            _iaid=$((16#$_a$_b$_c$_d))
            _identity=$'ClientIdentifier=duid\n'"IAID=$_iaid"$'\n\n[DHCPv6]\n'"IAID=$_iaid"$'\n'
            ;;
          "") net_refuse "$UPLINK is on DHCP but has no lease." ;;
          *) net_refuse "$UPLINK's DHCPv4 client identifier is of type 0x$_cid_type, which setup does not carry over." ;;
        esac
      fi
      {
        echo "# Written by Wisp setup: $BRIDGE, the bridge on $UPLINK, with its hardware address."
        printf '[NetDev]\nName=%s\nKind=bridge\nMACAddress=%s\n\n[Bridge]\nSTP=no\nForwardDelaySec=0\n' "$BRIDGE" "$UPLINK_MAC"
      } > "$NET_PLAN_DIR/bridge.netdev"
      {
        echo "# Written by Wisp setup: $BRIDGE holds the address $UPLINK had, with the settings of"
        echo "# ${_sources[*]}."
        printf '[Match]\nName=%s\n' "$BRIDGE"
        cat "$NET_PLAN_DIR/bridge.network.body"
        if [[ -n "$_identity" ]]; then
          echo ""
          echo "# The DHCP identity $UPLINK had, so the DHCP server hands $BRIDGE the same lease."
          printf '[DHCPv4]\n%s' "$_identity"
        fi
        echo ""
        echo "# The uplink's MTU, set on the bridge itself, so ports that join keep it."
        printf '[Link]\nMTUBytes=%s\n' "$UPLINK_MTU"
      } > "$NET_PLAN_DIR/bridge.network"
      rm -f "$NET_PLAN_DIR/bridge.network.body"
      {
        echo "# Written by Wisp setup: $UPLINK is $BRIDGE's port, with no addressing of its own;"
        echo "# $BRIDGE holds its address (00-wisp-$BRIDGE.network). What this file held before"
        echo "# is kept in $KEPT_DIR."
        echo "[Match]"
        cat "$NET_PLAN_DIR/port.match"
        printf '\n[Network]\nBridge=%s\nLinkLocalAddressing=no\nIPv6AcceptRA=no\n' "$BRIDGE"
        if [[ -s "$NET_PLAN_DIR/port.link" ]]; then
          cat "$NET_PLAN_DIR/port.link"
        fi
      } > "$NET_PLAN_DIR/port.network"
      rm -f "$NET_PLAN_DIR/port.link" "$NET_PLAN_DIR/port.match"
      unset _sources _dropins _cid_type _identity _a _b _c _d _iaid
      ;;

    networkmanager)
      UPLINK_CONNECTION="$(net_read nmcli -g GENERAL.CON-UUID device show "$UPLINK")" || exit 1
      [[ -n "$UPLINK_CONNECTION" ]] || net_refuse "NetworkManager names no connection for the uplink $UPLINK."
      _con="$(net_read nmcli -t connection show "$UPLINK_CONNECTION")" || exit 1
      # One property of the uplink's connection; empty when unset.
      _prop() {
        local v
        v="$(awk -v k="$1:" 'index($0, k) == 1 && !done { print substr($0, length(k) + 1); done = 1 }' <<<"$_con")"
        [[ "$v" == -- ]] && v=""
        printf '%s' "$v"
      }
      [[ "$(_prop connection.type)" == 802-3-ethernet ]] \
        || net_refuse "$UPLINK's connection is of type $(_prop connection.type)."
      [[ -z "$(_prop match.interface-name)" ]] \
        || net_refuse "$UPLINK's connection matches the interfaces \"$(_prop match.interface-name)\", not $UPLINK alone."
      _mac="$(_prop 802-3-ethernet.mac-address)"
      if [[ "$(_prop connection.interface-name)" != "$UPLINK" && "${_mac,,}" != "$UPLINK_MAC" ]]; then
        net_refuse "$UPLINK's connection is not bound to $UPLINK by name or hardware address, so it applies to other interfaces too."
      fi
      # The uplink's connection is deleted as the bridge step's last change,
      # its stored definition kept with the originals: a keyfile under /etc, or
      # the file netplan keeps for a connection NetworkManager made. The
      # default one NetworkManager makes for a wired device and holds in memory
      # needs nothing kept. A definition stored anywhere else, or one netplan
      # renders from an operator's own file, is refused.
      _files="$(net_read nmcli -t -f UUID,NAME,FILENAME connection show)" || exit 1
      NM_PROFILE_FILE="$(awk -F: -v u="$UPLINK_CONNECTION" '$1 == u { print $3 }' <<<"$_files")"
      case "$NM_PROFILE_FILE" in
        /etc/NetworkManager/system-connections/*) ;;
        /run/NetworkManager/system-connections/netplan-NM-"$UPLINK_CONNECTION".nmconnection)
          NM_PROFILE_FILE="/etc/netplan/90-NM-$UPLINK_CONNECTION.yaml"
          [[ -f "$NM_PROFILE_FILE" ]] || net_refuse "${UPLINK}'s connection is rendered by netplan, but $NM_PROFILE_FILE is missing." ;;
        /run/NetworkManager/system-connections/netplan-*)
          net_refuse "${UPLINK}'s connection is rendered by netplan from an operator's file in /etc/netplan: setup does not change it through NetworkManager." ;;
        "" | /run/NetworkManager/*) NM_PROFILE_FILE="" ;;
        *) net_refuse "${UPLINK}'s connection is stored in $NM_PROFILE_FILE, where setup cannot keep it to undo its removal." ;;
      esac
      [[ -z "$NM_PROFILE_FILE" ]] || journal_root_ok "$NM_PROFILE_FILE" \
        || net_refuse "${UPLINK}'s connection is stored in $NM_PROFILE_FILE, where setup cannot keep it to undo its removal."
      # Names setup would give its connections, and the files it would write
      # them to, already taken while no bridge is in use.
      for _n in "$BRIDGE" "${BRIDGE}-port-${UPLINK}"; do
        ! awk -F: -v n="$_n" '$2 == n { found = 1 } END { exit !found }' <<<"$_files" \
          || net_refuse "a NetworkManager connection named $_n exists already, and no bridge is in use: remove it, or bring up the bridge it belongs to."
      done
      NM_BRIDGE_FILE="/etc/NetworkManager/system-connections/${BRIDGE}.nmconnection"
      NM_PORT_FILE="/etc/NetworkManager/system-connections/${BRIDGE}-port-${UPLINK}.nmconnection"
      for _n in "$NM_BRIDGE_FILE" "$NM_PORT_FILE"; do
        [[ ! -e "$_n" ]] || net_refuse "$_n exists already, and no bridge is in use: remove it."
      done
      # The port comes up on the uplink at boot ahead of the uplink's own
      # connection: autoconnect priority above it.
      _prio="$(_prop connection.autoconnect-priority)"
      [[ "$_prio" =~ ^-?[0-9]+$ ]] || _prio=0
      (( _prio < 999 )) || net_refuse "${UPLINK}'s connection has the highest autoconnect priority (999): no port could come up ahead of it."
      NM_PORT_PRIORITY=$(( _prio + 1 > 0 ? _prio + 1 : 0 ))
      NM_BRIDGE_UUID="$(cat /proc/sys/kernel/random/uuid)"
      NM_PORT_UUID="$(cat /proc/sys/kernel/random/uuid)"
      case "$(_prop ipv4.method)" in
        auto) UPLINK_MODE=dhcp ;;
        manual) UPLINK_MODE=static ;;
        *) net_refuse "$UPLINK's connection has IPv4 method '$(_prop ipv4.method)': neither DHCP nor a static address." ;;
      esac
      for _p in 802-1x.eap connection.master connection.controller; do
        _v="$(_prop "$_p")"
        [[ -z "$_v" ]] || net_refuse "$UPLINK's connection sets $_p ($_v), which setup does not carry over to a bridge."
      done
      if [[ "$UPLINK_MODE" == dhcp ]]; then
        UPLINK_CLIENT_ID="$(client_id "$UPLINK" "$NET_TOOL")"
        [[ -n "$UPLINK_CLIENT_ID" ]] || net_refuse "$UPLINK is on DHCP but NetworkManager reports no client identifier for its lease."
      fi
      # NetworkManager gives a bridge another default route metric than an
      # Ethernet interface: the metric the uplink's routes have is kept.
      _routes4="$(net_read ip -4 route show default dev "$UPLINK")" || exit 1
      _routes6="$(net_read ip -6 route show default dev "$UPLINK")" || exit 1
      _metric_of() { awk '$1 == "default" && !done { for (i = 1; i < NF; i++) if ($i == "metric") { print $(i + 1); done = 1; break } }' <<<"$1"; }
      _metric4="$(_metric_of "$_routes4")"
      _metric6="$(_metric_of "$_routes6")"
      # The bridge connection: the uplink connection's whole layer 3 — every
      # ipv4.* and ipv6.* property it holds, static addresses, routes, name
      # servers and DHCP settings alike — its route metrics, the client
      # identifier it sent on DHCP, exactly (NM takes it as bytes), and its
      # hardware address. The port connection: no addressing of its own, and
      # the uplink connection's link settings (every 802-3-ethernet.* and
      # ethtool.* property). Both connect by themselves from the moment they
      # are added (see the bridge step).
      {
        printf '%s\n' type bridge ifname "$BRIDGE" con-name "$BRIDGE" connection.uuid "$NM_BRIDGE_UUID" \
          bridge.mac-address "$UPLINK_MAC" bridge.stp no connection.autoconnect yes connection.autoconnect-ports true \
          802-3-ethernet.mtu "$UPLINK_MTU"
        awk -v m4="$_metric4" -v m6="$_metric6" '/^ipv[46]\./ {
          k = $0; sub(/:.*/, "", k); v = substr($0, length(k) + 2)
          if (v == "" || v == "--" || k == "ipv4.dhcp-client-id" || k ~ /-deprecated$/) next
          if (k == "ipv4.route-metric" && v == "-1" && m4 != "") v = m4
          if (k == "ipv6.route-metric" && v == "-1" && m6 != "") v = m6
          print k; print v
        }' <<<"$_con"
        [[ -z "${UPLINK_CLIENT_ID:-}" ]] || printf '%s\n' ipv4.dhcp-client-id "$UPLINK_CLIENT_ID"
      } > "$NET_PLAN_DIR/bridge.args"
      {
        printf '%s\n' type ethernet ifname "$UPLINK" con-name "${BRIDGE}-port-${UPLINK}" connection.uuid "$NM_PORT_UUID" \
          controller "$BRIDGE" port-type bridge connection.autoconnect yes \
          connection.autoconnect-priority "$NM_PORT_PRIORITY"
        awk '/^(802-3-ethernet|ethtool)\./ {
          k = $0; sub(/:.*/, "", k); v = substr($0, length(k) + 2)
          if (v == "" || v == "--") next
          print k; print v
        }' <<<"$_con"
      } > "$NET_PLAN_DIR/port.args"
      # Both rendered as keyfiles and checked by NetworkManager itself,
      # offline: nothing is added.
      if ! timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli --offline connection add --help >/dev/null 2>&1; then
        net_refuse "this nmcli has no --offline, with which setup checks the connections it adds before adding them."
      fi
      for _f in bridge port; do
        mapfile -t _args < "$NET_PLAN_DIR/$_f.args"
        _why="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli --offline connection add "${_args[@]}" 2>&1 >"$NET_PLAN_DIR/$_f.nmconnection")" \
          || net_refuse "NetworkManager does not accept the $_f connection setup would add: ${_why:-nmcli --offline failed}."
      done
      unset -f _metric_of
      unset _routes4 _routes6 _args _f _files _n _prio
      unset -f _prop
      unset _con _mac _p _v _metric4 _metric6
      ;;
  esac

  # What the uplink holds now, which the bridge must hold after.
  l3_state "$UPLINK" "$NET_TOOL" > "$NET_PLAN_DIR/uplink.state" || net_fail "cannot read what $UPLINK holds"
fi

if [[ "$BRIDGE_CREATE" == yes ]]; then
  plan_sources > "$NET_PLAN_DIR/sources" || net_fail "cannot read what the plan was made from"
fi
for _var in NET_TOOL UPLINK UPLINK_ADDR BRIDGE BRIDGE_CREATE UPLINK_MAC UPLINK_MODE UPLINK_CLIENT_ID \
    UPLINK_MTU UPLINK_NETPLAN_ID NETPLAN_ORIGIN NETWORKD_PORT_FILE UPLINK_CONNECTION NM_PROFILE_FILE \
    NM_BRIDGE_UUID NM_PORT_UUID NM_BRIDGE_FILE NM_PORT_FILE NET_PLAN_JOURNAL; do
  [[ -z "${!_var:-}" ]] || printf '%s=%q\n' "$_var" "${!_var}"
done > "$NET_PLAN_DIR/plan.env"
unset _route _addrs _status _netfile _json _def _py _rc _stage _merged _why _var
