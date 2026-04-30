#!/usr/bin/env bash
# Enable libvirt daemons (modular or monolithic) + virtlogd; disable default NAT network. Run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

echo "--- Enabling libvirt services ---"

unit_exists() { systemctl cat "$1" &>/dev/null; }

# Modular daemons (virtqemud + sidecars) replace the monolithic libvirtd on
# distros that opt in (Fedora 35+, recent Arch). Ubuntu 26.04 ships libvirt 12
# but still packages it monolithically, so this branch is for forward-compat
# and non-Debian distros. virtproxyd provides the legacy
# /var/run/libvirt/libvirt-sock for clients that hardcode that path
# (libvirt-dbus, sanity.sh).
if unit_exists virtqemud.socket; then
  for sock in virtqemud.socket virtnetworkd.socket virtstoraged.socket \
              virtnodedevd.socket virtsecretd.socket virtproxyd.socket \
              virtinterfaced.socket virtnwfilterd.socket; do
    if unit_exists "$sock"; then
      systemctl enable --now "$sock" >/dev/null
    fi
  done
  echo "  libvirt modular daemons: socket-activated (virtqemud + virtnetworkd + virtstoraged + virtproxyd + ...)"
elif unit_exists libvirtd.service; then
  systemctl enable --now libvirtd
  echo "  libvirtd: $(systemctl is-active libvirtd)"
else
  echo "  ERROR: neither virtqemud.socket nor libvirtd.service is installed"
  exit 1
fi

# virtlogd persists in both monolithic and modular setups
systemctl enable --now virtlogd
echo "  virtlogd: $(systemctl is-active virtlogd)"
echo "  libvirt-dbus: installed (activates on demand via D-Bus)"

# Prevent libvirt default (NAT) network from starting now or on reboot
AUTOSTART_LINK="/etc/libvirt/qemu/networks/autostart/default.xml"
if [[ -L "$AUTOSTART_LINK" ]]; then
  rm -f "$AUTOSTART_LINK"
  echo "  Default NAT network: autostart disabled (virbr0 will not start)"
fi
virsh net-destroy default 2>/dev/null && echo "  Default NAT network stopped (virbr0 removed)." || true
