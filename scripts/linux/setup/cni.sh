#!/usr/bin/env bash
# Setup step: container networking — the CNI plugins in /opt/cni/bin, the bridge
# config every container joins, written for the bridge setup chose (it may be
# applied only later, as setup's last step; nothing here waits for it), and the
# CNI DHCP daemon its IPAM needs. Run as root.
# Usage: cni.sh <bridge>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)."
  exit 1
fi

BRIDGE="${1:-}"
if [[ -z "$BRIDGE" ]]; then
  echo "Usage: $0 <bridge>"
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=distro.sh
source "$SETUP_DIR/distro.sh"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin

echo "--- Container networking (CNI, bridge $BRIDGE) ---"

CNI_BIN_DIR="/opt/cni/bin"
CNI_CONF_DIR="/etc/cni/net.d"
CNI_VERSION="v1.9.1"
ARCH="$(sys_arch)"

# Pinned SHA-256 of the CNI plugin tarballs for CNI_VERSION, per arch. These are
# committed to the repo so a tampered/MITM'd download is rejected. Do NOT verify
# against the sibling .tgz.sha256 from the same release — anyone able to alter
# the release can regenerate a matching sidecar. Update these when bumping
# CNI_VERSION (values come from the upstream release .sha256 files).
declare -A CNI_SHA256=(
  [amd64]="b98f74a0f8522f0a83867178729c1aa70f2158f90c45a2ca8fa791db1c76b303"
  [arm64]="56171987d3947707c3563db2f4001bccaf50fd63468611b9f3cbecb1375ee7ec"
  [arm]="21416880bea0541d78afaf106373d6dbb471edb92c0114fa263494fe4aec8d3b"
)

# The plugins, by the version the bridge plugin reports: a bump in CNI_VERSION
# reaches installed hosts too.
# (The plugins print it on stderr.)
installed="$(timeout -k 10 10 "$CNI_BIN_DIR/bridge" --version 2>&1 | awk 'NR == 1 { print $NF }' || true)"
if [[ "$installed" != "$CNI_VERSION" ]]; then
  EXPECTED_SHA="${CNI_SHA256[$ARCH]:-}"
  [[ -n "$EXPECTED_SHA" ]] || fail "no pinned CNI checksum for arch '$ARCH' (version $CNI_VERSION)"
  TARBALL="$(staged_file)"
  # curl's own bound: under 1 KiB/s for 60 s.
  step_run 0 curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 60 \
    "https://github.com/containernetworking/plugins/releases/download/${CNI_VERSION}/cni-plugins-linux-${ARCH}-${CNI_VERSION}.tgz" \
    -o "$TARBALL" || fail "cannot download the CNI plugins ${CNI_VERSION}"
  echo "${EXPECTED_SHA}  $TARBALL" | sha256sum -c - >/dev/null 2>&1 \
    || fail "CNI plugin checksum mismatch for ${CNI_VERSION}/${ARCH} — refusing to install"
  # Unpacked beside the step, then each plugin put in place by install_file;
  # the bridge plugin last, as its version is what the check above reads.
  UNPACKED="$STEP_TMP_DIR/cni"
  mkdir -p "$UNPACKED" "$CNI_BIN_DIR"
  tar -xzf "$TARBALL" -C "$UNPACKED" || fail "cannot unpack the CNI plugins"
  for plugin in "$UNPACKED"/*; do
    [[ -f "$plugin" && "${plugin##*/}" != bridge ]] || continue
    install_file "$CNI_BIN_DIR/${plugin##*/}" "$plugin" 0755 || fail "cannot write $CNI_BIN_DIR/${plugin##*/}"
  done
  [[ -f "$UNPACKED/bridge" ]] || fail "the CNI plugins ${CNI_VERSION} hold no bridge plugin"
  install_file "$CNI_BIN_DIR/bridge" "$UNPACKED/bridge" 0755 || fail "cannot write $CNI_BIN_DIR/bridge"
  changed "CNI plugins ${CNI_VERSION} in $CNI_BIN_DIR (checksum verified)"
fi

# The legacy macvlan conflist of earlier installs.
if [[ -e "$CNI_CONF_DIR/10-wisp-macvlan.conflist" ]]; then
  rm -f "$CNI_CONF_DIR/10-wisp-macvlan.conflist"
  changed "removed legacy $CNI_CONF_DIR/10-wisp-macvlan.conflist"
fi

mkdir -p "$CNI_CONF_DIR"
CONFLIST="$(staged_file)"
cat > "$CONFLIST" <<CNIEOF
{
  "cniVersion": "1.0.0",
  "name": "wisp-bridge",
  "plugins": [
    {
      "type": "bridge",
      "bridge": "$BRIDGE",
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
if write_if_changed "$CNI_CONF_DIR/10-wisp-bridge.conflist" 0644 "$CONFLIST"; then
  changed "$CNI_CONF_DIR/10-wisp-bridge.conflist (bridge $BRIDGE)"
fi

# The CNI DHCP daemon, which the bridge plugin's DHCP IPAM talks to.
DHCP_UNIT="$(staged_file)"
cat > "$DHCP_UNIT" <<SVCEOF
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
if write_if_changed /etc/systemd/system/cni-dhcp.service 0644 "$DHCP_UNIT"; then
  systemctl daemon-reload
  changed /etc/systemd/system/cni-dhcp.service
fi
unit_on cni-dhcp
step_done
