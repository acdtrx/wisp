#!/usr/bin/env bash
# Enable libvirtd + virtlogd; disable default NAT network. Run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

echo "--- Enabling libvirt services ---"

systemctl enable --now libvirtd
systemctl enable --now virtlogd
echo "  libvirtd: $(systemctl is-active libvirtd)"
echo "  virtlogd: $(systemctl is-active virtlogd)"
echo "  libvirt-dbus: installed (activates on demand via D-Bus)"

# Prevent libvirt default (NAT) network from starting now or on reboot
AUTOSTART_LINK="/etc/libvirt/qemu/networks/autostart/default.xml"
if [[ -L "$AUTOSTART_LINK" ]]; then
  rm -f "$AUTOSTART_LINK"
  echo "  Default NAT network: autostart disabled (virbr0 will not start)"
fi
virsh net-destroy default 2>/dev/null && echo "  Default NAT network stopped (virbr0 removed)." || true
