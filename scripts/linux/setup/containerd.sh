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

# Docker publishes separate apt repos for Debian and Ubuntu, each keyed by that
# distro's own codename, so the repo is picked from ID/ID_LIKE. Ubuntu
# derivatives (Mint, Pop!_OS, ...) carry their own VERSION_CODENAME (Mint 22 is
# "wilma") and the Ubuntu base in UBUNTU_CODENAME; Debian derivatives may carry
# the Debian base in DEBIAN_CODENAME. Prints "<repo> <codename>", nothing when
# the distro is neither.
docker_apt_repo() {
  local os_release="$1"
  (
    # shellcheck disable=SC1090
    . "$os_release"
    case " ${ID:-} ${ID_LIKE:-} " in
      *" ubuntu "*) echo "ubuntu ${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ;;
      *" debian "*) echo "debian ${DEBIAN_CODENAME:-${VERSION_CODENAME:-}}" ;;
    esac
  )
}

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
    DOCKER_REPO=""
    CODENAME=""
    read -r DOCKER_REPO CODENAME <<<"$(docker_apt_repo /etc/os-release)" || true
    if [[ -z "$DOCKER_REPO" || -z "$CODENAME" ]]; then
      echo "ERROR: Could not determine the Docker apt repo from /etc/os-release (need an Ubuntu or Debian base with a release codename)." >&2
      exit 1
    fi
    DOCKER_URL="https://download.docker.com/linux/$DOCKER_REPO"
    DOCKER_LIST=/etc/apt/sources.list.d/docker.list
    echo "  Docker apt repo: $DOCKER_URL $CODENAME"

    # The list is rewritten below; an existing one pointing at the wrong repo
    # would fail this first update before it gets the chance.
    rm -f "$DOCKER_LIST"
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg

    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL "$DOCKER_URL/gpg" | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
    fi

    ARCH="$(sys_arch)"

    echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_URL $CODENAME stable" \
      > "$DOCKER_LIST"

    # A list apt cannot fetch fails every later `apt-get update` on the host,
    # so it does not stay behind when this one fails.
    if ! apt-get update -qq; then
      rm -f "$DOCKER_LIST"
      echo "ERROR: apt-get update failed after adding Docker's repo ($DOCKER_URL $CODENAME)." >&2
      echo "       Removed $DOCKER_LIST so apt keeps working. Docker may not publish" >&2
      echo "       containerd.io for this release; install containerd 2.x another way and re-run." >&2
      exit 1
    fi
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

# runc 1.2+ is required for per-mount idmapped mounts (used when runAsRoot is set on a container
# with non-default mount owner UID/GID). Older runc will fail at task create with a confusing
# OCI error — fail loudly here instead.
if command -v runc &>/dev/null; then
  RUNC_VER="$(runc --version 2>/dev/null | awk '/^runc version/ { print $3; exit }')"
  RUNC_MAJOR="$(echo "$RUNC_VER" | cut -d. -f1)"
  RUNC_MINOR="$(echo "$RUNC_VER" | cut -d. -f2)"
  if [[ -z "$RUNC_VER" ]] || ! [[ "$RUNC_MAJOR" =~ ^[0-9]+$ && "$RUNC_MINOR" =~ ^[0-9]+$ ]]; then
    echo "  WARN: Could not parse runc version (got: '$RUNC_VER'). Idmapped mounts require runc >= 1.2.0."
  elif [[ "$RUNC_MAJOR" -lt 1 ]] || { [[ "$RUNC_MAJOR" -eq 1 ]] && [[ "$RUNC_MINOR" -lt 2 ]]; }; then
    echo "  WARN: runc $RUNC_VER is older than 1.2.0 — per-mount idmapped mounts (runAsRoot + custom owner UID/GID) will fail."
    echo "        Upgrade containerd.io / runc, or avoid setting non-default mount owner UID/GID."
  else
    echo "  runc $RUNC_VER (>= 1.2.0): idmapped mounts supported."
  fi
else
  echo "  WARN: runc not found in PATH — containerd will be unable to start containers."
fi
