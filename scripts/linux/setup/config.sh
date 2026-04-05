#!/usr/bin/env bash
# Create config/wisp-config.json from example if missing; prompt and write serverName.
# Usage: config.sh <install-dir> [server-name]
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <install-dir> [server-name]"
  exit 1
fi

INSTALL_DIR="$1"
CONFIG_DIR="$INSTALL_DIR/config"
CONFIG_FILE="$CONFIG_DIR/wisp-config.json"
EXAMPLE="$CONFIG_DIR/wisp-config.json.example"
SERVER_NAME="${2:-}"

echo "--- Server name (config/wisp-config.json) ---"

mkdir -p "$CONFIG_DIR"

if [[ -f "$CONFIG_FILE" ]] && grep -q '"serverName"' "$CONFIG_FILE" 2>/dev/null; then
  echo "  config/wisp-config.json already has serverName. Skipping."
  exit 0
fi

if [[ -z "$SERVER_NAME" ]]; then
  DEFAULT_NAME="$(hostname 2>/dev/null || echo 'My Server')"
  read -r -p "Server name [$DEFAULT_NAME]: " SERVER_NAME
  SERVER_NAME="${SERVER_NAME:-$DEFAULT_NAME}"
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  if [[ ! -f "$EXAMPLE" ]]; then
    echo "ERROR: $EXAMPLE not found."
    exit 1
  fi
  cp "$EXAMPLE" "$CONFIG_FILE"
fi

node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const serverName = process.argv[2];
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  data.serverName = serverName;
  delete data._comment;
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
' "$CONFIG_FILE" "$SERVER_NAME"
echo "  Wrote serverName to config/wisp-config.json"
