#!/usr/bin/env bash
# chmod 600 on config secrets; chmod 755 on scripts.
# Usage: permissions.sh <install-dir>
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <install-dir>"
  exit 1
fi

INSTALL_DIR="$1"
CONFIG_DIR="$INSTALL_DIR/config"
RUNTIME_ENV="$CONFIG_DIR/runtime.env"
CONFIG_FILE="$CONFIG_DIR/wisp-config.json"
PASSWORD_FILE="$CONFIG_DIR/wisp-password"

echo "--- Permissions ---"

[[ -f "$RUNTIME_ENV" ]] && chmod 600 "$RUNTIME_ENV"
[[ -f "$CONFIG_FILE" ]] && chmod 600 "$CONFIG_FILE"
[[ -f "$PASSWORD_FILE" ]] && chmod 600 "$PASSWORD_FILE"
chmod 755 "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true
chmod 755 "$INSTALL_DIR/scripts/linux/"*.sh 2>/dev/null || true
[[ -d "$INSTALL_DIR/scripts/linux/setup" ]] && chmod 755 "$INSTALL_DIR/scripts/linux/setup/"*.sh 2>/dev/null || true
echo "  config/runtime.env, config/wisp-config.json, config/wisp-password: 600 (if present); scripts: 755"
