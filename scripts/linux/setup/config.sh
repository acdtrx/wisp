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
# shellcheck source=install-state.sh
source "$(dirname "$0")/install-state.sh"

echo "--- Server name (config/wisp-config.json) ---"

mkdir -p "$CONFIG_DIR"

if has_server_name "$INSTALL_DIR"; then
  echo "  config/wisp-config.json already has serverName. Skipping."
  exit 0
fi

if [[ -z "$SERVER_NAME" ]]; then
  DEFAULT_NAME="$(hostname 2>/dev/null || echo 'My Server')"
  read -r -p "Server name [$DEFAULT_NAME]: " SERVER_NAME
  SERVER_NAME="${SERVER_NAME:-$DEFAULT_NAME}"
fi

if [[ ! -f "$CONFIG_FILE" && ! -f "$EXAMPLE" ]]; then
  echo "ERROR: $EXAMPLE not found." >&2
  exit 1
fi

# From the file, or the example when there is none; written whole, staged
# beside it, synced and renamed, so a power loss leaves the old file or the new.
node -e '
  const fs = require("fs");
  const [path, example, serverName] = process.argv.slice(1);
  const data = JSON.parse(fs.readFileSync(fs.existsSync(path) ? path : example, "utf8"));
  data.serverName = serverName;
  delete data._comment;
  const dir = require("path").dirname(path);
  const tmp = `${dir}/.${require("path").basename(path)}.wisp-new.${process.pid}`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, path);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* not made, or gone with the rename */ }
    throw err;
  }
  const dfd = fs.openSync(dir, "r");
  fs.fsyncSync(dfd);
  fs.closeSync(dfd);
' "$CONFIG_FILE" "$EXAMPLE" "$SERVER_NAME"
echo "  Wrote serverName to config/wisp-config.json"
