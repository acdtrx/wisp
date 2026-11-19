#!/usr/bin/env bash
# Setup's network plan, run as a step by setup and by the installer, as root.
# Works out, changing nothing, how this host's network is run and which bridge
# Wisp uses, and refuses a host setup cannot serve — before anything changes.
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
# through the host's tool, with exactly one definition, its own (no wildcard or
# multi-interface match, no second definition that could take it). Its whole
# layer 3 moves to the bridge and leaves the interface, in the tool's own
# files, edited through the tool; its link settings stay on it. Every other
# shape, and every setting setup neither carries over nor keeps, is refused
# here, naming what was found (each tool's file, net-<tool>.sh, says how). So is
# a host none of the three tools runs, and another DNS server on the stub's
# port 53.
#
# Usage: network-plan.sh <plan-dir> [--ask]
#   Writes the plan's record and the bridge's configuration, worked out and
#   checked, into <plan-dir>, which the caller made and removes
#   (plan-record.sh). A bridge step's journal must have been decided on first
#   (bridge-recover.sh). With --ask (the installer's asking phase, which
#   changes nothing), a journal is only classified, and the plan is the
#   journal's own when the work will undo or commit it first.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: the network plan runs as root (use sudo)." >&2
  exit 1
fi
NET_PLAN_DIR="${1:-}"
ASK="${2:-}"
[[ -d "$NET_PLAN_DIR" && ( -z "$ASK" || "$ASK" == --ask ) ]] || { echo "Usage: $0 <plan-dir> [--ask]" >&2; exit 1; }

# The plan parses the output of the tools it runs: one locale for all of it.
export LC_ALL=C
NET_SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$NET_SETUP_DIR/step.sh"
# shellcheck source=bridge-journal.sh
source "$NET_SETUP_DIR/bridge-journal.sh"
# shellcheck source=net-uplink.sh
source "$NET_SETUP_DIR/net-uplink.sh"
# shellcheck source=plan-record.sh
source "$NET_SETUP_DIR/plan-record.sh"

step_begin
refuse_no_python

NET_PLAN_JOURNAL=""
if [[ -d "$JOURNAL_DIR" ]]; then
  [[ -n "$ASK" ]] || net_fail "a bridge step's journal is in $JOURNAL_DIR: setup's bridge-journal step decides on it before the plan."
  # The asking phase changes nothing, so it cannot plan on a host the work will
  # first undo or commit: it plans from the journal's own record.
  # journal_classify sets the journal's plan, and J_CLASS.
  journal_classify
  journal_refuse_class
  NET_PLAN_JOURNAL="$J_CLASS"
  case "$J_CLASS" in
    restore | finished)
      [[ "$J_CLASS" == restore ]] || BRIDGE_CREATE=no
      plan_record_write "$NET_PLAN_DIR/plan" || net_fail "cannot write the plan in $NET_PLAN_DIR"
      exit 0 ;;
  esac
fi

detect_uplink
refuse_dns_port

if [[ -d "/sys/class/net/$UPLINK/bridge" ]]; then
  BRIDGE="$UPLINK"
  BRIDGE_CREATE=no
  echo "  $NET_TOOL; the uplink $UPLINK is a bridge, which Wisp uses"
else
  BRIDGE=br0
  BRIDGE_CREATE=yes
  # What follows matters only when setup makes the bridge.
  refuse_uplink_shape
  "plan_$NET_TOOL"
  # What the uplink holds now, which the bridge must hold after: the check's
  # reference.
  l3_state "$UPLINK" "$NET_TOOL" > "$NET_PLAN_DIR/uplink.state" || net_fail "cannot read what $UPLINK holds"
  plan_sources > "$NET_PLAN_DIR/sources" || net_fail "cannot read what the plan was made from"
  echo "  $NET_TOOL; $BRIDGE to be created on the uplink $UPLINK ($UPLINK_ADDR, $UPLINK_MODE)"
fi
plan_record_write "$NET_PLAN_DIR/plan" || net_fail "cannot write the plan in $NET_PLAN_DIR"
