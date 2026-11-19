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
  timeout -k 10 30 containerd config default > "$STAGED" || fail "containerd cannot print its default configuration"
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

NAMESPACES="$(timeout -k 10 30 ctr namespaces ls -q)" || fail "ctr cannot list containerd's namespaces"
if ! grep -qx wisp <<<"$NAMESPACES"; then
  timeout -k 10 30 ctr namespaces create wisp
  changed "namespace wisp created"
fi

# runc 1.2+ is required for per-mount idmapped mounts (used when runAsRoot is set
# on a container with non-default mount owner UID/GID). Older runc fails at task
# create with a confusing OCI error, so warn here; everything else still works.
if command -v runc &>/dev/null; then
  # Every line read, no early exit: under pipefail a reader that quits first
  # turns runc's SIGPIPE into a failure.
  RUNC_VER="$(runc --version 2>/dev/null | awk '/^runc version/ && !done { print $3; done = 1 }')"
  RUNC_MAJOR="$(echo "$RUNC_VER" | cut -d. -f1)"
  RUNC_MINOR="$(echo "$RUNC_VER" | cut -d. -f2)"
  if [[ -z "$RUNC_VER" ]] || ! [[ "$RUNC_MAJOR" =~ ^[0-9]+$ && "$RUNC_MINOR" =~ ^[0-9]+$ ]]; then
    echo "  WARN: Could not parse runc version (got: '$RUNC_VER'). Idmapped mounts require runc >= 1.2.0."
  elif [[ "$RUNC_MAJOR" -lt 1 ]] || { [[ "$RUNC_MAJOR" -eq 1 ]] && [[ "$RUNC_MINOR" -lt 2 ]]; }; then
    echo "  WARN: runc $RUNC_VER is older than 1.2.0 — per-mount idmapped mounts (runAsRoot + custom owner UID/GID) will fail."
  fi
else
  echo "ERROR: runc not found in PATH — containerd cannot start containers." >&2
  exit 1
fi
step_done
