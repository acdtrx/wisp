#!/usr/bin/env bash
# Setup step: the system packages Wisp needs — Node.js 24+, the QEMU/KVM/libvirt
# stack, containerd 2.x, and the tools the backend and its helpers run. Run as
# root.
#
# Queries first, without the package manager or its lock (dpkg-query, pacman
# -Q): the package manager runs only for what is missing. When it does run, apt
# waits up to 5 min for a lock another package run holds (unattended-upgrades,
# apt-daily) instead of failing at once.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

# Suppress interactive prompts during installs: debconf menus, and Ubuntu's
# `needrestart` asking which services to restart (the usual hang).
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

NODE_MAJOR_MIN=24
LOCK_WAIT_SEC=300

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= NODE_MAJOR_MIN ))
}

containerd_ok() {
  command -v containerd >/dev/null 2>&1 || return 1
  local major
  major="$(containerd --version 2>/dev/null | grep -oP ' v\K[0-9]+' | head -1 || true)"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 2 ))
}

echo "--- System packages (distro: $WISP_DISTRO) ---"

if [[ "$WISP_DISTRO" == "arch" ]]; then
  # Node.js and containerd 2.x come from the official repos.
  PACKAGES=(nodejs npm qemu-full libvirt libvirt-dbus edk2-ovmf swtpm avahi hwdata
    smartmontools dmidecode cifs-utils cloud-utils cdrtools unzip rsync curl containerd)
  missing=()
  for p in "${PACKAGES[@]}"; do
    pacman -Q "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  node_ok || [[ " ${missing[*]} " == *" nodejs "* ]] || missing+=(nodejs)
  containerd_ok || [[ " ${missing[*]} " == *" containerd "* ]] || missing+=(containerd)
  if (( ${#missing[@]} > 0 )); then
    pacman -Sy --needed --noconfirm "${missing[@]}"
    changed "installed ${missing[*]}"
  fi
  step_done
  exit 0
fi

# Debian / Ubuntu. Node.js 24 comes from NodeSource's apt repo and containerd 2.x
# from Docker's (containerd.io): each repo's signing key is pinned under
# /etc/apt/keyrings, so apt verifies every package against it — nothing is
# piped from the network into a root shell.
PACKAGES=(qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients libvirt-dbus ovmf
  swtpm swtpm-tools avahi-daemon hwdata smartmontools dmidecode cifs-utils cloud-image-utils
  genisoimage unzip rsync curl ca-certificates gnupg)

deb_installed() {
  [[ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" == installed ]]
}

APT=(apt-get -o "DPkg::Lock::Timeout=$LOCK_WAIT_SEC")

missing=()
for p in "${PACKAGES[@]}"; do
  deb_installed "$p" || missing+=("$p")
done
need_node=0
need_containerd=0
node_ok || need_node=1
containerd_ok || need_containerd=1

if (( ${#missing[@]} == 0 && need_node == 0 && need_containerd == 0 )); then
  step_done
  exit 0
fi

if (( ${#missing[@]} > 0 )); then
  "${APT[@]}" update -qq
  "${APT[@]}" install -y -qq "${missing[@]}"
  changed "installed ${missing[*]}"
fi

# Docker publishes separate apt repos for Debian and Ubuntu, each keyed by that
# distro's own codename, so the repo is picked from ID/ID_LIKE. Ubuntu
# derivatives (Mint, Pop!_OS, ...) carry their own VERSION_CODENAME (Mint 22 is
# "wilma") and the Ubuntu base in UBUNTU_CODENAME; Debian derivatives may carry
# the Debian base in DEBIAN_CODENAME. Prints "<repo> <codename>", nothing when
# the distro is neither.
docker_apt_repo() {
  (
    # shellcheck disable=SC1091
    . /etc/os-release
    case " ${ID:-} ${ID_LIKE:-} " in
      *" ubuntu "*) echo "ubuntu ${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ;;
      *" debian "*) echo "debian ${DEBIAN_CODENAME:-${VERSION_CODENAME:-}}" ;;
    esac
  )
}

# apt_repo <name> <key-url> <list-line>: the signing key under /etc/apt/keyrings
# and the source list, each written only when missing or different.
apt_repo() {
  local name="$1" key_url="$2" line="$3" keyring="/etc/apt/keyrings/$1.gpg"
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f "$keyring" ]]; then
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 60 "$key_url" | gpg --dearmor -o "$keyring"
    chmod a+r "$keyring"
    changed "$keyring"
  fi
  if printf '%s\n' "$line" | write_if_changed "/etc/apt/sources.list.d/$name.list" 0644; then
    changed "/etc/apt/sources.list.d/$name.list"
  fi
}

repo_packages=()
if (( need_node )); then
  apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main"
  repo_packages+=(nodejs)
fi
if (( need_containerd )); then
  read -r DOCKER_REPO CODENAME <<<"$(docker_apt_repo)" || true
  if [[ -z "${DOCKER_REPO:-}" || -z "${CODENAME:-}" ]]; then
    echo "ERROR: Could not determine the Docker apt repo from /etc/os-release (need an Ubuntu or Debian base with a release codename)." >&2
    exit 1
  fi
  DOCKER_URL="https://download.docker.com/linux/$DOCKER_REPO"
  apt_repo docker "$DOCKER_URL/gpg" \
    "deb [arch=$(sys_arch) signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_URL $CODENAME stable"
  repo_packages+=(containerd.io)
fi

if (( ${#repo_packages[@]} > 0 )); then
  # A list apt cannot fetch fails every later `apt-get update` on the host, so
  # Docker's does not stay behind when this one fails.
  if ! "${APT[@]}" update -qq; then
    rm -f /etc/apt/sources.list.d/docker.list
    echo "ERROR: apt-get update failed with the NodeSource / Docker repos added; removed docker.list so apt keeps working." >&2
    exit 1
  fi
  "${APT[@]}" install -y -qq "${repo_packages[@]}"
  changed "installed ${repo_packages[*]}"
fi

node_ok || { echo "ERROR: Node.js $NODE_MAJOR_MIN+ is still missing after the install." >&2; exit 1; }
containerd_ok || { echo "ERROR: containerd 2.x is still missing after the install." >&2; exit 1; }
step_done
