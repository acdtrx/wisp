#!/usr/bin/env bash
# Setup step: libvirt's daemons enabled and running (modular or monolithic) with
# virtlogd, and libvirt's default NAT network off — Wisp's VMs use a host
# bridge. Run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

echo "--- libvirt ---"

unit_exists() { systemctl cat --no-pager "$1" &>/dev/null; }

# Modular daemons (virtqemud + sidecars) replace the monolithic libvirtd where
# the packaging opts in. Ubuntu 26.04 ships libvirt 12 but still packages it
# monolithically. virtproxyd provides the legacy
# /var/run/libvirt/libvirt-sock for clients that hardcode that path
# (libvirt-dbus, sanity.sh).
if unit_exists virtqemud.socket; then
  for sock in virtqemud.socket virtnetworkd.socket virtstoraged.socket \
              virtnodedevd.socket virtsecretd.socket virtproxyd.socket \
              virtinterfaced.socket virtnwfilterd.socket; do
    if unit_exists "$sock"; then unit_on "$sock"; fi
  done
elif unit_exists libvirtd.service; then
  unit_on libvirtd
else
  echo "ERROR: neither virtqemud.socket nor libvirtd.service is installed" >&2
  exit 1
fi

unit_on virtlogd

# The default NAT network neither autostarts nor runs.
AUTOSTART_LINK="/etc/libvirt/qemu/networks/autostart/default.xml"
if [[ -L "$AUTOSTART_LINK" ]]; then
  rm -f "$AUTOSTART_LINK"
  changed "default NAT network no longer autostarts"
fi
ACTIVE_NETWORKS="$(timeout -k 10 30 virsh -q net-list --name)" || fail "virsh cannot list libvirt's networks"
if grep -qx default <<<"$ACTIVE_NETWORKS"; then
  timeout -k 10 30 virsh net-destroy default >/dev/null
  changed "default NAT network stopped (virbr0 removed)"
fi
step_done
