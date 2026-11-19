#!/usr/bin/env bash
# Converge avahi-daemon's config to what Wisp needs: publish-aaaa-on-ipv4=no.
#
# Why: avahi 0.8 renames the host to `<host>-2` when an address is withdrawn
# while it is still probing its host name — the kernel loops its own probe back,
# avahi no longer recognises it as its own, and counts it as a rival claim
# (avahi#117, unfixed upstream). The usual trigger is IPv6 link-local
# withdrawal: unattended-upgrades restarting avahi-daemon and systemd-networkd in
# the same second (needrestart after a library upgrade), or a reboot. The
# conflict was observed on the IPv4 probe, which by default also carries the
# host's AAAA records. With them off IPv4, restarting both (observed 2026-10-23
# on an Ubuntu 24.04 guest) went from a conflict on the first try to none in
# ten. AAAA records are still published over IPv6.
#
# avahi has no drop-in directory, so the one key is set in place in
# avahi-daemon.conf and the rest of the file stays the distro's. The file is a
# conffile: wisp-os-update keeps the local version (--force-confold), and an
# interactive apt or unattended-upgrades holds avahi back if the package ever
# ships a changed one — the next run of this step re-applies the key either way.
#
# Setup step: rewrites the file and restarts avahi-daemon only when the key is
# not already set. Must run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin

echo "--- avahi-daemon config ---"

CONF="/etc/avahi/avahi-daemon.conf"
KEY="publish-aaaa-on-ipv4"
VALUE="no"

if [[ ! -f "$CONF" ]]; then
  echo "ERROR: $CONF not found (the packages step installs avahi-daemon)." >&2
  exit 1
fi

# Set KEY=VALUE in [publish]: replace the first line naming the key there,
# commented or not, and drop any later ones; insert it at the end of the
# section if absent; append the section if the file has none.
tmp="$(staged_file)"
awk -v key="$KEY" -v val="$VALUE" '
  function emit() { if (!done) { print key "=" val; done = 1 } }
  /^\[/ { if (insec) emit(); insec = ($0 ~ /^\[publish\][ \t]*$/); seen = seen || insec }
  insec && $0 ~ "^#?[ \t]*" key "[ \t]*=" { emit(); next }
  { print }
  END { if (!seen) print "\n[publish]"; emit() }
' "$CONF" > "$tmp"

# Staged and renamed, with the file's own mode and owner; nothing when it holds
# the key already.
if ! write_if_changed "$CONF" "$(stat -c %a "$CONF")" "$tmp" "$(stat -c %U:%G "$CONF")"; then
  step_done
  exit 0
fi
changed "$KEY=$VALUE in $CONF"

# Only when running: a stopped avahi picks the file up on its next start. The
# backend re-registers everything when avahi comes back (NameOwnerChanged).
step_run 0 systemctl try-restart avahi-daemon.service || fail "avahi-daemon did not restart"
changed "avahi-daemon restarted (if it was running)"
