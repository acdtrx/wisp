#!/usr/bin/env bash
# Install CNI plugins and create bridge config for container networking. Run as root.
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
if [[ ! -x "$CNI_BIN_DIR/bridge" ]]; then
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

# Bridge master for CNI: must be an **existing Linux bridge**. The CNI bridge plugin will
# silently create a new orphan bridge if the name doesn't resolve to one, so we abort instead.
# We pick the bridge that carries the default route (typically br0, which setup-server.sh creates).
#
# Poll for up to ~30s. setup-server.sh runs bridge.sh immediately before this script, and
# `netplan apply` only swaps the default route to br0 *after* the bridge acquires its DHCP
# lease — without waiting, a fresh install silently skipped the conflist + cni-dhcp.service
# install and containers came up with no IP.
detect_bridge_with_wait() {
  local timeout_s=30
  local interval_s=2
  local elapsed=0
  local iface
  while :; do
    iface="$(ip route show default 2>/dev/null | awk '/default/ { print $5; exit }')"
    if [[ -n "$iface" ]] && [[ -d "/sys/class/net/$iface/bridge" ]]; then
      echo "$iface"
      return 0
    fi
    if (( elapsed >= timeout_s )); then
      return 1
    fi
    if (( elapsed == 0 )); then
      echo "  Waiting up to ${timeout_s}s for default route to land on a Linux bridge..." >&2
    fi
    sleep "$interval_s"
    elapsed=$((elapsed + interval_s))
  done
}

MASTER_IFACE="$(detect_bridge_with_wait || true)"
if [[ -z "$MASTER_IFACE" ]]; then
  echo "ERROR: default-route interface is not a Linux bridge after 30s wait." >&2
  echo "       If bridge.sh just configured br0, its DHCP lease may not have completed yet." >&2
  echo "       Run scripts/linux/setup/bridge.sh if br0 is missing, then re-run: sudo $0" >&2
  exit 1
fi

# Remove legacy macvlan conflist from earlier installs (setup script is idempotent).
mkdir -p "$CNI_CONF_DIR"
rm -f "$CNI_CONF_DIR/10-wisp-macvlan.conflist"

CONF_FILE="$CNI_CONF_DIR/10-wisp-bridge.conflist"
echo "  Writing bridge config to $CONF_FILE (bridge=$MASTER_IFACE)"

cat > "$CONF_FILE" <<CNIEOF
{
  "cniVersion": "1.0.0",
  "name": "wisp-bridge",
  "plugins": [
    {
      "type": "bridge",
      "bridge": "$MASTER_IFACE",
      "isGateway": false,
      "isDefaultGateway": false,
      "ipMasq": false,
      "hairpinMode": false,
      "promiscMode": false,
      "forceAddress": false,
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
