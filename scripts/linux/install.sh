#!/usr/bin/env bash
# Wisp install, from a release-shaped tree (a release tarball, or what push.sh
# ships — scripts/stage-release.sh builds both): copy the tree, run setup,
# config, password, backend dependencies, permissions, start, and offer the
# bridge. Run as normal user (not root). Linux only. Hosts never build.
#
# Usage: ./scripts/install.sh [install-dir] [--restart-svc]
#   install-dir    — target directory (default: prompt, or /opt/wisp)
#   --restart-svc  — (re)start wisp.service without prompting
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
SOURCE_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

RESTART_SVC=0
INSTALL_DIR=""

for arg in "$@"; do
  case "$arg" in
    --restart-svc) RESTART_SVC=1 ;;
    -*) echo "ERROR: Unknown flag: $arg"; exit 1 ;;
    *) INSTALL_DIR="$arg" ;;
  esac
done

# --- Pre-flight ---
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: This script is for Linux only. Build a release-shaped tree with scripts/stage-release.sh (push.sh does), then run its install.sh on the target server."
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  echo "ERROR: Do not run this script as root. Run as a normal user; the script will use sudo only when needed (install directory, setup)."
  exit 1
fi

if [[ ! -f "$SOURCE_DIR/frontend/dist/index.html" ]]; then
  echo "ERROR: $SOURCE_DIR is not a release-shaped tree (no frontend/dist). Install from a release tarball, or push one with scripts/push.sh."
  exit 1
fi

echo "=== Wisp Install ==="
echo "Source: $SOURCE_DIR"
echo ""

# --- Install directory ---
if [[ -z "$INSTALL_DIR" ]]; then
  DEFAULT_INSTALL="/opt/wisp"
  read -r -p "Install directory [$DEFAULT_INSTALL]: " INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL}"
fi
INSTALL_DIR="$(echo "$INSTALL_DIR" | sed 's:/*$::')"

if [[ -z "$INSTALL_DIR" ]]; then
  echo "ERROR: Install directory cannot be empty."
  exit 1
fi

# --- Copy app payload ---
echo ""
"$SCRIPT_DIR/setup/copy.sh" "$SOURCE_DIR" "$INSTALL_DIR"

cd "$INSTALL_DIR"
RUNTIME_ENV="$INSTALL_DIR/config/runtime.env"
WISPCTL="$INSTALL_DIR/scripts/wispctl.sh"
SETUP_DIR="$INSTALL_DIR/scripts/linux/setup"

# --- Setup (requires root): stops here, naming the step, if one fails ---
echo ""
sudo "$SETUP_DIR/common-steps.sh" "$INSTALL_DIR" "$(whoami)"

# --- Config and password ---
"$SETUP_DIR/config.sh" "$INSTALL_DIR"
"$SETUP_DIR/password.sh" "$INSTALL_DIR"

# --- Backend dependencies (the tree ships without node_modules) ---
echo ""
echo "--- Backend dependencies ---"
(cd "$INSTALL_DIR/backend" && npm ci --omit=dev --omit=optional)

# --- Permissions ---
echo ""
"$SETUP_DIR/permissions.sh" "$INSTALL_DIR"

# --- System service ---
# The backend brings its stored state up to date itself, at every start.
echo ""
START_SVC=0
if [[ "$RESTART_SVC" -eq 1 ]]; then
  START_SVC=1
elif systemctl is-active --quiet wisp; then
  read -r -p "Wisp is running. Restart it to apply this update? [Y/n] " ans || true
  if [[ ! "${ans:-Y}" =~ ^[nN] ]]; then START_SVC=1; fi
else
  read -r -p "Start wisp.service now? [y/N] " ans || true
  if [[ "${ans:-n}" =~ ^[yY] ]]; then START_SVC=1; fi
fi

# Setup has rendered and enabled the unit; this (re)starts it.
if [[ "$START_SVC" -eq 1 ]]; then
  sudo systemctl restart wisp
  echo "  Service started."
fi

# --- Optional: Bridged networking (skip in non-interactive mode) ---
if [[ "$RESTART_SVC" -eq 0 ]] && [[ -x "$SETUP_DIR/bridge.sh" ]]; then
  has_real_bridge() {
    for d in /sys/class/net/*/bridge; do
      [[ -d "$d" ]] || continue
      name="$(basename "$(dirname "$d")")"
      [[ "$name" == virbr* ]] && continue
      return 0
    done
    return 1
  }
  if ! has_real_bridge; then
    echo ""
    read -r -p "Set up bridged networking (br0) so VMs join the host network? [y/N] " ans || true
    if [[ "${ans:-n}" =~ ^[yY] ]]; then
      echo "  Applying bridge config may briefly disconnect SSH. You can reconnect and run: sudo $SETUP_DIR/bridge.sh"
      if sudo "$SETUP_DIR/bridge.sh"; then
        echo "  Bridge configured."
      else
        echo "  Bridge setup failed or reverted. Run manually later: sudo $SETUP_DIR/bridge.sh"
      fi
    fi
  fi
fi

# --- Summary ---
# shellcheck source=../../backend/scripts/wisp-port.sh
source "$INSTALL_DIR/backend/scripts/wisp-port.sh"
if ! WISP_PORT="$(wisp_port "$RUNTIME_ENV")"; then
  echo "  Wisp will not start until WISP_PORT is fixed." >&2
  WISP_PORT="<WISP_PORT>"
fi

echo ""
echo "=== Install complete ==="
echo ""
echo "  Install path: $INSTALL_DIR"
echo "  Access:       http://$(hostname -f 2>/dev/null || hostname):${WISP_PORT}"
echo ""
echo "  If you were added to libvirt/kvm groups, log out and back in (or run: newgrp libvirt)"
echo ""
echo "  Manage app:   $WISPCTL { password | local start|stop | svc start|stop|restart|logs }"
echo ""
