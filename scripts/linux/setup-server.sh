#!/usr/bin/env bash
# Wisp server setup: packages, groups, dirs, libvirt, optional bridge, sanity checks, helper scripts, RAPL.
# Run as root (sudo). Invoked from install.sh or standalone.
# Each step is run independently so a single failure does not skip remaining steps.
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

DEPLOY_USER="${SUDO_USER:-}"
if [[ -z "$DEPLOY_USER" ]]; then
  echo "ERROR: Could not detect invoking user. Run with: sudo ./setup-server.sh"
  exit 1
fi

SKIP_BRIDGE=0
for arg in "$@"; do
  case "$arg" in
    --skip-bridge) SKIP_BRIDGE=1 ;;
    *) echo "ERROR: unknown argument: $arg"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
SETUP_DIR="$SCRIPT_DIR/setup"

FAILED_STEPS=()

run_step() {
  local label="$1"
  shift
  if "$@"; then
    return 0
  else
    echo "  WARNING: $label failed (exit $?). Continuing..."
    FAILED_STEPS+=("$label")
    return 0
  fi
}

echo "=== Wisp Server Setup ==="
echo "Deploy user: $DEPLOY_USER"
echo ""

run_step "Packages" "$SETUP_DIR/packages.sh"
echo ""

run_step "Groups" "$SETUP_DIR/groups.sh" "$DEPLOY_USER"
echo ""

run_step "Directories" "$SETUP_DIR/dirs.sh" "$DEPLOY_USER"
echo ""

run_step "Libvirt" "$SETUP_DIR/libvirt.sh"
echo ""

# Optional: Bridged networking — skipped when --skip-bridge is passed (e.g. from install.sh; bridge offered at end)
echo "--- Optional: Bridged networking (br0) ---"
if [[ "$SKIP_BRIDGE" == "1" ]]; then
  echo "  Skipped (bridge can be configured at end of install or later with: sudo scripts/linux/setup/bridge.sh)"
else
  has_real_bridge() {
    for d in /sys/class/net/*/bridge; do
      [[ -d "$d" ]] || continue
      name="$(basename "$(dirname "$d")")"
      [[ "$name" == virbr* ]] && continue
      return 0
    done
    return 1
  }
  if has_real_bridge; then
    echo "  A bridge (non-NAT) already exists. Skipping bridge setup."
  else
    read -r -p "Set up bridged networking (br0) so VMs join the host network? [Y/n] " ans || true
    if [[ "${ans:-y}" =~ ^[yY]?$ ]]; then
      if [[ -x "$SETUP_DIR/bridge.sh" ]]; then
        run_step "Bridge" "$SETUP_DIR/bridge.sh"
      else
        echo "  Skipped (bridge.sh not found or not executable at $SETUP_DIR/bridge.sh)"
      fi
    else
      echo "  Skipped."
    fi
  fi
fi
echo ""

run_step "containerd" "$SETUP_DIR/containerd.sh" "$DEPLOY_USER"
echo ""

run_step "CNI plugins" "$SETUP_DIR/cni.sh"
echo ""

run_step "Container DNS" "$SETUP_DIR/container-dns.sh"
echo ""

run_step "Sanity checks" "$SETUP_DIR/sanity.sh"
echo ""

run_step "Privileged helpers" "$SETUP_DIR/install-helpers.sh" "$PROJECT_ROOT" "$DEPLOY_USER"
echo ""

run_step "RAPL permissions" "$SETUP_DIR/rapl.sh" "$DEPLOY_USER"

echo ""
if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
  echo "=== Setup complete (with warnings) ==="
  echo ""
  echo "  The following steps had errors:"
  for step in "${FAILED_STEPS[@]}"; do
    echo "    - $step"
  done
  echo ""
  echo "  The steps above may need to be re-run individually. See scripts/linux/setup/ for standalone scripts."
else
  echo "=== Setup complete ==="
fi
echo ""
echo "IMPORTANT: Group changes require you to log out and back in,"
echo "or run: newgrp libvirt"
echo ""
