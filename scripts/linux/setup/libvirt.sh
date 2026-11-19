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
step_begin

echo "--- libvirt ---"

unit_exists() { systemctl cat --no-pager "$1" &>/dev/null; }

# Modular daemons (virtqemud + sidecars) replace the monolithic libvirtd where
# the packaging opts in. Ubuntu 26.04 ships libvirt 12 but still packages it
# monolithically. virtproxyd provides the legacy
# /var/run/libvirt/libvirt-sock for clients that hardcode that path
# (libvirt-dbus, and this step's check below).
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
ACTIVE_NETWORKS="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" virsh -q net-list --name)" || fail "virsh cannot list libvirt's networks"
if grep -qx default <<<"$ACTIVE_NETWORKS"; then
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" virsh net-destroy default >/dev/null || fail "virsh cannot stop the default NAT network"
  changed "default NAT network stopped (virbr0 removed)"
fi

# What the backend needs of libvirt answers: virsh, the socket, and libvirt's
# D-Bus service (libvirt-dbus starts on demand: the call activates it).
timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" virsh list --all >/dev/null || fail "libvirt does not answer (virsh list --all)"
[[ -S /var/run/libvirt/libvirt-sock ]] || fail "libvirt's socket /var/run/libvirt/libvirt-sock is missing"
timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" busctl call --system org.libvirt /org/libvirt/QEMU org.freedesktop.DBus.Properties Get ss \
  org.libvirt.Connect LibVersion >/dev/null || fail "libvirt's D-Bus service (libvirt-dbus) does not answer"
step_done
