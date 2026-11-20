#!/usr/bin/env bash
# Setup's network plan, run as a step by setup and by the installer, as root.
# Works out, changing nothing, which bridge Wisp uses, and refuses a host setup
# cannot serve — before anything changes (bridge-plan.sh says what is refused).
#
# A Wisp host needs a bridge: without one no VM or container has a network.
# The bridge is the one carrying the uplink (the default route's interface), or
# else `br0`, which the bridge step, setup's last change, makes on the uplink
# through netplan. Either way netplan must run the uplink. Another DNS server on
# the container DNS stub's port 53 is refused too, and so is a configuration
# netplan rejects with the stub's definition in it.
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
# shellcheck source=bridge-plan.sh
source "$NET_SETUP_DIR/bridge-plan.sh"
# shellcheck source=plan-record.sh
source "$NET_SETUP_DIR/plan-record.sh"

step_begin
# Whether the host can run VMs: a fact setup cannot change, read once, here.
HOST_KVM_NOW=no
[[ -e /dev/kvm ]] && HOST_KVM_NOW=yes

# A committed journal in another format is refused here too, so the asking
# phase refuses it before the install changes anything.
[[ ! -d "$JOURNAL_DIR.done" ]] || journal_refuse_done_format
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
      HOST_KVM="$HOST_KVM_NOW"
      plan_record_write "$NET_PLAN_DIR/plan" || net_fail "cannot write the plan in $NET_PLAN_DIR"
      step_done
      exit 0 ;;
  esac
fi

detect_uplink
refuse_dns_port
# The stub's netplan file, rendered once and checked with the host's files.
dns_stub_render "$NET_PLAN_DIR/$DNS_STUB_PLANNED" || net_fail "cannot write the plan in $NET_PLAN_DIR"
netplan_stage "$NET_PLAN_DIR/stub-stage"
refuse_dns_stub "$NET_PLAN_DIR/stub-stage"
rm -rf "$NET_PLAN_DIR/stub-stage"

if [[ -d "/sys/class/net/$UPLINK/bridge" ]]; then
  BRIDGE="$UPLINK"
  BRIDGE_CREATE=no
  echo "  netplan; the uplink $UPLINK is a bridge, which Wisp uses"
else
  BRIDGE=br0
  BRIDGE_CREATE=yes
  # What follows matters only when setup makes the bridge.
  refuse_uplink_shape
  plan_bridge
  # What the uplink holds now, which the bridge must hold after: the check's
  # reference.
  l3_state "$UPLINK" > "$NET_PLAN_DIR/uplink.state" || net_fail "cannot read what $UPLINK holds"
  plan_sources > "$NET_PLAN_DIR/sources" || net_fail "cannot read what the plan was made from"
  echo "  netplan; $BRIDGE to be created on the uplink $UPLINK ($UPLINK_ADDR, $UPLINK_MODE)"
fi
HOST_KVM="$HOST_KVM_NOW"
plan_record_write "$NET_PLAN_DIR/plan" || net_fail "cannot write the plan in $NET_PLAN_DIR"
step_done
