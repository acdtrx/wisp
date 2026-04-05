#!/usr/bin/env bash
# Verify virsh, /dev/kvm, libvirt socket, D-Bus. Run as root (or with libvirt group). Read-only.
set -euo pipefail

echo "--- Sanity checks ---"

check_pass() { echo "  PASS: $1"; }
check_fail() { echo "  FAIL: $1"; }

if virsh list --all &>/dev/null; then
  check_pass "virsh list --all"
else
  check_fail "virsh list --all"
fi

if [[ -e /dev/kvm ]]; then
  check_pass "/dev/kvm exists"
else
  check_fail "/dev/kvm does not exist"
fi

SOCK="/var/run/libvirt/libvirt-sock"
if [[ -S "$SOCK" ]]; then
  check_pass "libvirt socket exists"
else
  check_fail "libvirt socket not found at $SOCK"
fi

# Trigger on-demand activation and verify org.libvirt responds (libvirt-dbus starts when first used)
if busctl call --system org.libvirt /org/libvirt/QEMU org.freedesktop.DBus.Properties Get "ss" "org.libvirt.Connect" "LibVersion" &>/dev/null; then
  check_pass "org.libvirt DBus service reachable"
else
  check_fail "org.libvirt DBus service not reachable (is libvirt-dbus installed?)"
fi
