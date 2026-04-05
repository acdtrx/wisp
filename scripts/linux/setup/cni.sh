#!/usr/bin/env bash
# Install CNI plugins and create macvlan config for container networking. Run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"

echo "--- CNI plugins setup ---"

CNI_BIN_DIR="/opt/cni/bin"
CNI_CONF_DIR="/etc/cni/net.d"
CNI_VERSION="v1.9.1"
ARCH="$(sys_arch)"

# Install CNI plugins if not present
if [[ ! -x "$CNI_BIN_DIR/macvlan" ]]; then
  echo "  Downloading CNI plugins ${CNI_VERSION}..."
  mkdir -p "$CNI_BIN_DIR"

  TMP_DIR="$(mktemp -d)"
  TARBALL="cni-plugins-linux-${ARCH}-${CNI_VERSION}.tgz"
  curl -fsSL "https://github.com/containernetworking/plugins/releases/download/${CNI_VERSION}/${TARBALL}" \
    -o "$TMP_DIR/$TARBALL"
  tar -xzf "$TMP_DIR/$TARBALL" -C "$CNI_BIN_DIR"
  rm -rf "$TMP_DIR"
  echo "  CNI plugins installed to $CNI_BIN_DIR"
else
  echo "  CNI plugins already installed."
fi

# Macvlan master for CNI: must be the interface macvlan attaches to.
# If the default route uses a *bridge* (e.g. br0), use that bridge as master — not the
# physical port under it. Macvlan on a bridge slave (enp0s31f6 enslaved to br0) typically
# fails with "device or resource busy"; macvlan on br0 shares the same L2 segment as the host.
detect_interface() {
  local iface
  iface="$(ip route show default 2>/dev/null | awk '/default/ { print $5; exit }')"
  if [[ -z "$iface" ]]; then
    echo "eth0"
    return
  fi
  if [[ -d "/sys/class/net/$iface/bridge" ]]; then
    echo "$iface"
    return
  fi
  echo "$iface"
}

# Create / overwrite macvlan CNI config every run (no partial edits — same as fresh install).
mkdir -p "$CNI_CONF_DIR"
CONF_FILE="$CNI_CONF_DIR/10-wisp-macvlan.conflist"
MASTER_IFACE="$(detect_interface)"
echo "  Writing macvlan config to $CONF_FILE (master=$MASTER_IFACE)"

cat > "$CONF_FILE" <<CNIEOF
{
  "cniVersion": "1.0.0",
  "name": "wisp-macvlan",
  "plugins": [
    {
      "type": "macvlan",
      "master": "$MASTER_IFACE",
      "mode": "bridge",
      "ipam": {
        "type": "dhcp"
      }
    }
  ]
}
CNIEOF

# Enable the CNI DHCP daemon (needed for DHCP IPAM)
DHCP_SERVICE="/etc/systemd/system/cni-dhcp.service"
if [[ ! -f "$DHCP_SERVICE" ]]; then
  cat > "$DHCP_SERVICE" <<SVCEOF
[Unit]
Description=CNI DHCP daemon
After=network.target

[Service]
Type=simple
ExecStart=/opt/cni/bin/dhcp daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable --now cni-dhcp
  echo "  CNI DHCP daemon enabled."
else
  systemctl enable --now cni-dhcp 2>/dev/null || true
  echo "  CNI DHCP daemon already configured."
fi
