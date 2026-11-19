#!/usr/bin/env bash
# Setup step: the system packages Wisp needs — Node.js (NODE_MAJOR_MIN or
# newer), the QEMU/KVM/libvirt stack, containerd 2.x, and the tools the backend
# and its helpers run. Run as root.
#
# Queries first, with dpkg-query and dpkg --audit, without the package manager
# or its lock: the package manager runs only for what is missing. When it does
# run, apt and dpkg wait up to APT_LOCK_WAIT_SEC for a lock another package run
# holds (unattended-upgrades, apt-daily) instead of failing at once, and keep a
# config file the host edited (avahi-daemon.conf) instead of stopping at
# dpkg's question, which no one is there to answer. apt, dpkg and the downloads
# run through step_run, stopped after APT_IDLE_SEC without a line of output
# (apt prints each package it fetches, unpacks and sets up): longer than the
# lock wait, during which apt says it waits once.
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
step_begin

# Suppress interactive prompts during installs: debconf menus, and Ubuntu's
# `needrestart` asking which services to restart (the usual hang).
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

NODE_MAJOR_MIN=24
APT_LOCK_WAIT_SEC=300
APT_IDLE_SEC=600

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= NODE_MAJOR_MIN ))
}

# containerd 2.x, by the package database rather than the binary's banner, whose
# format differs between builds: Docker's containerd.io or the distro's containerd.
containerd_ok() {
  local version major
  for pkg in containerd.io containerd; do
    [[ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null)" == installed ]] || continue
    version="$(dpkg-query -W -f='${Version}' "$pkg")"
    break
  done
  major="${version:-}"
  major="${major#*:}"
  major="${major%%.*}"
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 2 ))
}

echo "--- System packages ---"

# Node.js comes from NodeSource's apt repo and containerd 2.x
# from Docker's (containerd.io): each repo's signing key is pinned under
# /etc/apt/keyrings, so apt verifies every package against it — nothing is
# piped from the network into a root shell.
PACKAGES=(qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients libvirt-dbus ovmf
  swtpm swtpm-tools avahi-daemon hwdata smartmontools dmidecode cifs-utils cloud-image-utils
  genisoimage unzip rsync curl ca-certificates gnupg)

deb_installed() {
  [[ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" == installed ]]
}

APT=(apt-get -o "DPkg::Lock::Timeout=$APT_LOCK_WAIT_SEC")
# As wisp-os-update installs.
CONFFILES=(--force-confdef --force-confold)
APT_INSTALL=("${APT[@]}" -o "Dpkg::Options::=${CONFFILES[0]}" -o "Dpkg::Options::=${CONFFILES[1]}" install -y -q)

missing=()
for p in "${PACKAGES[@]}"; do
  deb_installed "$p" || missing+=("$p")
done
need_node=0
need_containerd=0
node_ok || need_node=1
containerd_ok || need_containerd=1

# A package run that was stopped (a stop reaches apt and dpkg too) leaves
# packages unpacked but not configured, or half installed, which dpkg --audit
# names (without the lock), and apt refuses to work past: dpkg configures what
# it left, waiting for the lock as apt does (dpkg-locked.py), then apt
# completes it (install -f), removing nothing.
# dpkg --audit is a check: exit 1 when it found something, 2 when it failed.
audit_rc=0
audit="$(dpkg --audit)" || audit_rc=$?
(( audit_rc <= 1 )) || fail "dpkg --audit failed (exit $audit_rc)"
(( audit_rc == 0 )) || audit="${audit:-dpkg --audit found a problem}"
if [[ -z "$audit" && ${#missing[@]} -eq 0 && $need_node -eq 0 && $need_containerd -eq 0 ]]; then
  step_done
  exit 0
fi
if [[ -n "$audit" ]]; then
  step_run "$APT_IDLE_SEC" "${SETUP_PYTHON[@]}" "$SETUP_DIR/dpkg-locked.py" "$APT_LOCK_WAIT_SEC" dpkg "${CONFFILES[@]}" --configure -a \
    || fail "dpkg --configure -a failed: the packages an interrupted package run left are not configured"
  step_run "$APT_IDLE_SEC" "${APT_INSTALL[@]}" --no-remove -f \
    || fail "apt-get install -f failed: the packages an interrupted package run left are not complete"
  changed "completed the packages an interrupted package run left"
fi

if (( ${#missing[@]} > 0 )); then
  step_run "$APT_IDLE_SEC" "${APT[@]}" update -q || fail "apt-get update failed"
  step_run "$APT_IDLE_SEC" "${APT_INSTALL[@]}" "${missing[@]}" || fail "apt-get could not install ${missing[*]}"
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

# What this run wrote of the repos, taken back when apt cannot use them: a file
# it created is removed, one it replaced gets its earlier content back.
REPO_FILES_CREATED=()
REPO_FILES_REPLACED=()   # "<path>|<saved copy>"

# write_repo_file <dest> <content-file>: write_if_changed, remembering what to
# take back. Returns 0 when it wrote.
write_repo_file() {
  local dest="$1" src="$2" saved=""
  if [[ -f "$dest" ]]; then
    saved="$(staged_file)"
    cp -p "$dest" "$saved" || fail "cannot keep a copy of $dest"
  fi
  write_if_changed "$dest" 0644 "$src" || return 1
  if [[ -n "$saved" ]]; then REPO_FILES_REPLACED+=("$dest|$saved"); else REPO_FILES_CREATED+=("$dest"); fi
}

restore_repo_files() {
  local entry
  for entry in "${REPO_FILES_CREATED[@]}"; do remove_file "$entry" || fail "cannot remove $entry"; done
  for entry in "${REPO_FILES_REPLACED[@]}"; do
    install_file "${entry%%|*}" "${entry#*|}" 0644 || fail "cannot put back ${entry%%|*}"
  done
}

# apt_repo <name> <key-url> <list-line>: the signing key under /etc/apt/keyrings
# and the source list, each written only when missing or different. The key is
# downloaded and dearmored beside the keyring and checked before it goes in, so
# a cut-off download never leaves a keyring that later runs would trust.
apt_repo() {
  local name="$1" key_url="$2" line="$3" keyring="/etc/apt/keyrings/$1.gpg" armored dearmored list
  install -m 0755 -d /etc/apt/keyrings
  if ! gpg --batch --show-keys "$keyring" >/dev/null 2>&1; then
    armored="$(staged_file)"
    dearmored="$(staged_file)"
    # curl's own bound: under 1 KiB/s for 60 s.
    step_run 0 curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 60 -o "$armored" "$key_url" \
      || fail "cannot download $key_url"
    gpg --batch --yes --dearmor -o "$dearmored" "$armored" || fail "$key_url is not a signing key gpg can read"
    gpg --batch --show-keys "$dearmored" >/dev/null 2>&1 || fail "$key_url is not a usable signing key"
    if write_repo_file "$keyring" "$dearmored"; then changed "$keyring"; fi
  fi
  list="$(staged_file)"
  printf '%s\n' "$line" > "$list"
  if write_repo_file "/etc/apt/sources.list.d/$name.list" "$list"; then
    changed "/etc/apt/sources.list.d/$name.list"
  fi
}

repo_packages=()
if (( need_node )); then
  apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_MIN}.x nodistro main"
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
  # what this run wrote does not stay behind when the update fails.
  if ! step_run "$APT_IDLE_SEC" "${APT[@]}" update -q; then
    restore_repo_files
    fail "apt-get update failed with the NodeSource / Docker repos; took back what this run wrote to them so apt keeps working"
  fi
  step_run "$APT_IDLE_SEC" "${APT_INSTALL[@]}" "${repo_packages[@]}" || fail "apt-get could not install ${repo_packages[*]}"
  changed "installed ${repo_packages[*]}"
fi

node_ok || { echo "ERROR: Node.js $NODE_MAJOR_MIN+ is still missing after the install." >&2; exit 1; }
containerd_ok || { echo "ERROR: containerd 2.x is still missing after the install." >&2; exit 1; }
step_done
