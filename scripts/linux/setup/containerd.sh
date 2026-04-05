#!/usr/bin/env bash
# Install containerd 2.0+ and grant socket access to the deploy user. Run as root.
# Usage: containerd.sh [deploy-user]
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"

DEPLOY_USER="${1:-${SUDO_USER:-}}"

echo "--- containerd setup (distro: $WISP_DISTRO) ---"

NEED_INSTALL=true

# Check if containerd is already installed and >= 2.0
if command -v containerd &>/dev/null; then
  CURRENT_VER="$(containerd --version 2>/dev/null | grep -oP 'v\K[0-9]+' | head -1 || echo 0)"
  if [[ "$CURRENT_VER" -ge 2 ]]; then
    echo "  containerd 2.x already installed."
    NEED_INSTALL=false
  else
    echo "  Found containerd <2.0, upgrading..."
  fi
fi

if $NEED_INSTALL; then
  if [[ "$WISP_DISTRO" == "arch" ]]; then
    # containerd is in the official Arch repos; no Docker repo needed
    pacman -Sy --needed --noconfirm containerd
  else
    # Debian / Ubuntu: install from the official Docker apt repo
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg

    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
    fi

    ARCH="$(sys_arch)"
    CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"

    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $CODENAME stable" \
      > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq containerd.io
  fi
fi

# Generate default config if missing
if [[ ! -f /etc/containerd/config.toml ]]; then
  mkdir -p /etc/containerd
  containerd config default > /etc/containerd/config.toml
fi

# Grant socket access to deploy user via a containerd group.
# containerd reads [grpc].gid and chowns the socket on startup.
NEEDS_RESTART=false

if [[ -n "$DEPLOY_USER" ]]; then
  if ! getent group containerd &>/dev/null; then
    groupadd --system containerd
    echo "  Created system group 'containerd'."
  fi
  if ! id -nG "$DEPLOY_USER" 2>/dev/null | grep -qw containerd; then
    usermod -aG containerd "$DEPLOY_USER"
    echo "  Added $DEPLOY_USER to containerd group."
  fi

  CTD_GID="$(getent group containerd | cut -d: -f3)"
  CONFIG="/etc/containerd/config.toml"

  # Set gid in [grpc] section so the socket is group-owned
  if grep -qE '^\s*gid\s*=' "$CONFIG" 2>/dev/null; then
    CURRENT_GID="$(grep -E '^\s*gid\s*=' "$CONFIG" | head -1 | sed 's/.*=\s*//' | tr -d ' ')"
    if [[ "$CURRENT_GID" != "$CTD_GID" ]]; then
      sed -i "s/^\(\s*gid\s*=\s*\).*/\1${CTD_GID}/" "$CONFIG"
      echo "  Set containerd socket gid=$CTD_GID (group containerd)."
      NEEDS_RESTART=true
    fi
  else
    # gid line missing; append under [grpc] or at end of file
    if grep -q '^\[grpc\]' "$CONFIG" 2>/dev/null; then
      sed -i "/^\[grpc\]/a\\  gid = ${CTD_GID}" "$CONFIG"
    else
      printf '\n[grpc]\n  gid = %s\n' "$CTD_GID" >> "$CONFIG"
    fi
    echo "  Set containerd socket gid=$CTD_GID (group containerd)."
    NEEDS_RESTART=true
  fi
else
  echo "  WARN: No deploy user specified — socket permissions not configured."
  echo "  Re-run with: sudo $0 <username>"
fi

# Enable and start (or restart if config changed)
systemctl enable --now containerd
if $NEEDS_RESTART; then
  systemctl restart containerd
  echo "  containerd restarted to apply socket permissions."
else
  echo "  containerd installed and started."
fi

# Create wisp namespace (best-effort — backend also ensures it)
if command -v ctr &>/dev/null; then
  ctr namespaces create wisp 2>/dev/null || true
  echo "  Namespace 'wisp' ready."
fi
