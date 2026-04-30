#!/usr/bin/env bash
# Install Node.js 24+ and QEMU/KVM/libvirt stack. Run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

# Suppress interactive prompts during apt installs:
# - DEBIAN_FRONTEND=noninteractive: stop debconf from popping menus (e.g. for libvirt apparmor)
# - NEEDRESTART_MODE=a / NEEDRESTART_SUSPEND=1: stop Ubuntu 22.04+ `needrestart` from
#   asking which services to restart after the install (this is the usual hang).
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"

echo "--- Installing system packages (distro: $WISP_DISTRO) ---"

if [[ "$WISP_DISTRO" == "arch" ]]; then
  # Sync package databases once before installing
  pacman -Sy --noconfirm

  # Node.js is in the official repos on Arch; no NodeSource needed
  if command -v node &>/dev/null; then
    NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "$NODE_MAJOR" -ge 24 ]]; then
      echo "Node.js $(node -v) already installed, skipping."
    else
      echo "Node.js $(node -v) is too old (need >= 24). Installing from official repos..."
      pacman -S --needed --noconfirm nodejs npm
    fi
  else
    echo "Installing Node.js..."
    pacman -S --needed --noconfirm nodejs npm
  fi

  # swtpm is in AUR; attempt install via pacman and warn if unavailable
  SWTPM_PKGS=()
  if pacman -Si swtpm &>/dev/null 2>&1; then
    SWTPM_PKGS=(swtpm)
  else
    echo "  NOTE: 'swtpm' is not in the official Arch repos (it is in AUR)."
    echo "        Software TPM (vTPM) will not be available until swtpm is installed."
    echo "        Install manually with an AUR helper, e.g.: yay -S swtpm"
  fi

  pacman -S --needed --noconfirm \
    qemu-full \
    libvirt \
    libvirt-dbus \
    edk2-ovmf \
    "${SWTPM_PKGS[@]}" \
    avahi \
    hwdata \
    smartmontools \
    cloud-utils \
    cdrtools \
    unzip \
    curl

else
  # Debian / Ubuntu path
  if ! command -v curl &>/dev/null; then
    apt-get update -qq
    apt-get install -y -qq curl
  fi

  # Require Node.js >= 24
  if command -v node &>/dev/null; then
    NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "$NODE_MAJOR" -ge 24 ]]; then
      echo "Node.js $(node -v) already installed, skipping."
    else
      echo "Node.js $(node -v) is too old (need >= 24). Installing Node.js 24..."
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
      apt-get install -y -qq nodejs
    fi
  else
    echo "Installing Node.js 24..."
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y -qq nodejs
  fi

  # qemu-system-x86 is the concrete package on modern Debian/Ubuntu.
  # The old `qemu-kvm` transitional package was dropped in Ubuntu 24.04.
  apt-get install -y -qq \
    qemu-system-x86 \
    libvirt-daemon-system \
    libvirt-clients \
    libvirt-dbus \
    ovmf \
    swtpm \
    swtpm-tools \
    avahi-daemon \
    hwdata \
    smartmontools \
    cloud-image-utils \
    genisoimage \
    qemu-utils \
    unzip
fi

echo "  Node: $(node -v)"
echo "  npm: $(npm -v)"
echo "  QEMU: $(qemu-system-x86_64 --version | head -1)"
