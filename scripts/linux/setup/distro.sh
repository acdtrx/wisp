#!/usr/bin/env bash
# Distro detection helper. Source this file; do not execute directly.
# Exports:
#   WISP_DISTRO   — "debian" (Ubuntu/Debian) or "arch"
#   sys_arch()    — prints GitHub-release arch name (amd64, arm64, arm)
#   pkg_install() — installs packages with the appropriate package manager

# Detect distro from /etc/os-release
if [[ -z "${WISP_DISTRO:-}" ]]; then
  if [[ -f /etc/os-release ]]; then
    _ID="$(. /etc/os-release && echo "${ID:-}")"
    _ID_LIKE="$(. /etc/os-release && echo "${ID_LIKE:-}")"
  else
    _ID=""
    _ID_LIKE=""
  fi

  case "${_ID}:${_ID_LIKE}" in
    arch:*|*:*arch*)
      WISP_DISTRO="arch"
      ;;
    ubuntu:*|debian:*|*:*debian*|*:*ubuntu*)
      WISP_DISTRO="debian"
      ;;
    *)
      echo "ERROR: Unsupported distro (ID=${_ID}, ID_LIKE=${_ID_LIKE})."
      echo "       Wisp setup supports Debian/Ubuntu and Arch Linux."
      exit 1
      ;;
  esac
  export WISP_DISTRO
fi

# Map uname -m to GitHub release architecture names (amd64, arm64, arm)
sys_arch() {
  case "$(uname -m)" in
    x86_64)  echo "amd64" ;;
    aarch64) echo "arm64" ;;
    armv7l|armv6l) echo "arm" ;;
    *)
      echo "ERROR: Unsupported architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

# Install packages with the distro-appropriate package manager
pkg_install() {
  if [[ "$WISP_DISTRO" == "arch" ]]; then
    pacman -S --needed --noconfirm "$@"
  else
    apt-get install -y -qq "$@"
  fi
}
