#!/usr/bin/env bash
# Setup step: containerd (installed by the packages step) configured for Wisp —
# its socket group-owned by `containerd` with the deploy user in that group, the
# service enabled and running, and the `wisp` namespace. Run as root.
# Usage: containerd.sh <deploy-user>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

DEPLOY_USER="${1:-}"
if [[ -z "$DEPLOY_USER" ]]; then
  echo "Usage: $0 <deploy-user>"
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin

echo "--- containerd ---"

CONFIG=/etc/containerd/config.toml
NEEDS_RESTART=false

# containerd reads [grpc].gid and chowns its socket to it on startup.
if ! getent group containerd >/dev/null; then
  groupadd --system containerd
  changed "system group containerd created"
fi
if ! in_group "$DEPLOY_USER" containerd; then
  usermod -aG containerd "$DEPLOY_USER"
  changed "$DEPLOY_USER added to containerd"
fi
CTD_GID="$(getent group containerd | cut -d: -f3)"

# The configuration, worked out in a staged copy (containerd's default when
# there is none) and written by write_if_changed. The gid is set by a line
# edit: docs/BACKLOG.md, "containerd's config.toml edited by line".
STAGED="$(staged_file)"
if [[ -f "$CONFIG" ]]; then
  cp "$CONFIG" "$STAGED"
else
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" containerd config default > "$STAGED" || fail "containerd cannot print its default configuration"
fi
if grep -qE '^\s*gid\s*=' "$STAGED"; then
  sed -i "s/^\(\s*gid\s*=\s*\).*/\1${CTD_GID}/" "$STAGED"
elif grep -q '^\[grpc\]' "$STAGED"; then
  sed -i "/^\[grpc\]/a\\  gid = ${CTD_GID}" "$STAGED"
else
  printf '\n[grpc]\n  gid = %s\n' "$CTD_GID" >> "$STAGED"
fi
mkdir -p /etc/containerd
mode=0644 owner=root:root
if [[ -f "$CONFIG" ]]; then mode="$(stat -c %a "$CONFIG")" owner="$(stat -c %U:%G "$CONFIG")"; fi
if write_if_changed "$CONFIG" "$mode" "$STAGED" "$owner"; then
  changed "$CONFIG (socket gid $CTD_GID)"
  NEEDS_RESTART=true
fi

unit_on containerd
if $NEEDS_RESTART; then
  step_run 0 systemctl restart containerd || fail "containerd did not restart"
  changed "containerd restarted for the socket gid"
fi

NAMESPACES="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ctr namespaces ls -q)" || fail "ctr cannot list containerd's namespaces"
if ! grep -qx wisp <<<"$NAMESPACES"; then
  timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ctr namespaces create wisp || fail "ctr cannot create the namespace wisp"
  changed "namespace wisp created"
fi

# runc, which containerd starts containers with. Its version needs no check:
# setup accepts containerd 2.x only, from Docker's containerd.io, which bundles
# the runc containerd's release names (1.2.1 or newer since containerd 2.0),
# or from the distro, whose runc beside it is newer still; per-mount idmapped
# mounts need 1.2.
command -v runc >/dev/null || fail "runc not found in PATH: containerd cannot start containers"
step_done
