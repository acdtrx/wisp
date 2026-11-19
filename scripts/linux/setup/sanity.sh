#!/usr/bin/env bash
# Setup step: what the backend needs from libvirt is there — virsh answers,
# /dev/kvm exists, libvirt's socket and its D-Bus service respond. Read-only;
# a check that fails fails the step. Run as root.
set -euo pipefail

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin

echo "--- Sanity checks ---"

FAILED=0
check() {
  if "${@:2}" &>/dev/null; then echo "  PASS: $1"; else echo "  FAIL: $1" >&2; FAILED=1; fi
}

check "virsh list --all" timeout -k 10 30 virsh list --all
check "/dev/kvm exists" test -e /dev/kvm
check "libvirt socket at /var/run/libvirt/libvirt-sock" test -S /var/run/libvirt/libvirt-sock
# libvirt-dbus starts on demand: the call activates it. busctl's own timeout.
check "org.libvirt D-Bus service reachable (libvirt-dbus)" \
  timeout -k 10 30 busctl call --system org.libvirt /org/libvirt/QEMU org.freedesktop.DBus.Properties Get "ss" "org.libvirt.Connect" "LibVersion"

(( FAILED == 0 )) || fail "a sanity check failed (above): Wisp cannot run VMs on this host as it is"
step_done
