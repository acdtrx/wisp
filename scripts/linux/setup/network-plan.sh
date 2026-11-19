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

NET_SETUP_DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=net-state.sh
source "$NET_SETUP_DIR/net-state.sh"
# shellcheck source=bridge-journal.sh
source "$NET_SETUP_DIR/bridge-journal.sh"
# shellcheck source=net-uplink.sh
source "$NET_SETUP_DIR/net-uplink.sh"
# shellcheck source=container-dns-plan.sh
source "$NET_SETUP_DIR/container-dns-plan.sh"
# shellcheck source=plan-record.sh
source "$NET_SETUP_DIR/plan-record.sh"

NET_PLAN_DIR="$(mktemp -d -t wisp-net-plan.XXXXXX)" || net_fail "cannot create a temp directory"
export NET_PLAN_DIR
# A step's own temp directory (step.sh) goes too, as its trap is replaced here.
trap 'rm -rf "$NET_PLAN_DIR" ${STEP_TMP_DIR:+"$STEP_TMP_DIR"}' EXIT

# A bridge step that died left its journal: decided on first, from what the
# host holds now (bridge-journal.sh), before anything is worked out. In the
# asking phase it is only classified, and the plan is the journal's record.
NET_PLAN_JOURNAL=""
journal_recover || return 0

detect_uplink
refuse_dns_port

if [[ -d "/sys/class/net/$UPLINK/bridge" ]]; then
  BRIDGE="$UPLINK"
  BRIDGE_CREATE=no
else
  BRIDGE=br0
  BRIDGE_CREATE=yes
  # What follows matters only when setup makes the bridge.
  refuse_uplink_shape
  "plan_$NET_TOOL"
  # What the uplink holds now, which the bridge must hold after.
  l3_state "$UPLINK" "$NET_TOOL" > "$NET_PLAN_DIR/uplink.state" || net_fail "cannot read what $UPLINK holds"
fi

if [[ "$BRIDGE_CREATE" == yes ]]; then
  plan_sources > "$NET_PLAN_DIR/sources" || net_fail "cannot read what the plan was made from"
fi
plan_record_write "$NET_PLAN_DIR/plan.env"
