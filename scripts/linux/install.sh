#!/usr/bin/env bash
# Wisp install: copy app dirs, server setup, config, password, build, permissions, optional systemd and bridge.
# Run as normal user (not root). Linux only.
#
# Usage: ./scripts/install.sh [install-dir] [--restart-svc]
#   install-dir    — target directory (default: prompt, or /opt/wisp)
#   --restart-svc  — auto-restart (or install+start) systemd services without prompting
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
  echo "ERROR: This script is for Linux only. Use package.sh to build, then run install.sh on the target server."
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  echo "ERROR: Do not run this script as root. Run as a normal user; the script will use sudo only when needed (install directory, setup-server.sh)."
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
SETUP_SERVER="$INSTALL_DIR/scripts/setup-server.sh"
SETUP_DIR="$INSTALL_DIR/scripts/linux/setup"

# --- Server setup (requires root) ---
echo ""
echo "--- Server setup (packages, groups, libvirt) ---"
if [[ ! -x "$SETUP_SERVER" ]]; then
  echo "ERROR: $SETUP_SERVER not found or not executable."
  exit 1
fi
WISP_SKIP_BRIDGE=1 sudo -E "$SETUP_SERVER"

# --- Node check ---
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. setup-server.sh should have installed it. Please install Node.js 24+ and re-run this script."
  exit 1
fi

# --- Config and password ---
"$SETUP_DIR/config.sh" "$INSTALL_DIR"
"$SETUP_DIR/password.sh" "$INSTALL_DIR"

# --- Build ---
echo ""
echo "--- Build ---"
"$WISPCTL" build

# --- Permissions ---
echo ""
"$SETUP_DIR/permissions.sh" "$INSTALL_DIR"

# --- System services ---
echo ""
WISP_BACKEND_UNIT="/etc/systemd/system/wisp-backend.service"
WISP_FRONTEND_UNIT="/etc/systemd/system/wisp-frontend.service"
if [[ "$RESTART_SVC" -eq 1 ]]; then
  if [[ -f "$WISP_BACKEND_UNIT" ]] && [[ -f "$WISP_FRONTEND_UNIT" ]]; then
    "$WISPCTL" svc restart
    echo "  Services restarted."
  else
    "$WISPCTL" svc install
    "$WISPCTL" svc start
    echo "  Services installed and started."
  fi
elif [[ -f "$WISP_BACKEND_UNIT" ]] && [[ -f "$WISP_FRONTEND_UNIT" ]]; then
  read -r -p "Wisp systemd services are already installed. Restart them to apply this update? [Y/n] " ans || true
  if [[ ! "${ans:-Y}" =~ ^[nN] ]]; then
    "$WISPCTL" svc restart
    echo "  Services restarted."
  fi
else
  read -r -p "Install and start systemd services? [y/N] " ans || true
  if [[ "${ans:-n}" =~ ^[yY] ]]; then
    "$WISPCTL" svc install
    "$WISPCTL" svc start
    echo "  Services installed and started."
  fi
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
FRONTEND_PORT="8080"
if [[ -f "$RUNTIME_ENV" ]] && grep -q '^WISP_FRONTEND_PORT=' "$RUNTIME_ENV" 2>/dev/null; then
  FRONTEND_PORT="$(grep '^WISP_FRONTEND_PORT=' "$RUNTIME_ENV" | head -1 | cut -d= -f2- | tr -d '\r')"
fi

echo ""
echo "=== Install complete ==="
echo ""
echo "  Install path: $INSTALL_DIR"
echo "  Access:       http://$(hostname -f 2>/dev/null || hostname):${FRONTEND_PORT}"
echo ""
echo "  If you were added to libvirt/kvm groups, log out and back in (or run: newgrp libvirt)"
echo ""
echo "  Manage app:   $WISPCTL { build | password | local start|stop | svc start|stop|restart|logs }"
echo ""
