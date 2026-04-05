#!/usr/bin/env bash
# Package wisp, upload to a remote server, and install/update.
#
# Usage: ./scripts/push.sh user@server /remote/path [--restart-svc]
#   --restart-svc  auto-restart systemd services after install (no prompt)
set -euo pipefail

RESTART_SVC=0
TARGET=""
REMOTE_PATH=""

for arg in "$@"; do
  case "$arg" in
    --restart-svc) RESTART_SVC=1 ;;
    -*)  echo "ERROR: Unknown flag: $arg"; exit 1 ;;
    *)
      if [[ -z "$TARGET" ]]; then
        TARGET="$arg"
      elif [[ -z "$REMOTE_PATH" ]]; then
        REMOTE_PATH="$arg"
      else
        echo "ERROR: Unexpected argument: $arg"
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$TARGET" ]] || [[ -z "$REMOTE_PATH" ]]; then
  echo "Usage: $0 user@server /remote/path [--restart-svc]"
  echo "Example: $0 deploy@192.168.1.100 /opt/wisp --restart-svc"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Wisp Push ==="
echo "Target: $TARGET:$REMOTE_PATH"
echo ""

# --- Package ---
echo "--- Packaging ---"
"$SCRIPT_DIR/package.sh"

VERSION="$(node -e "console.log(require('$PROJECT_DIR/frontend/package.json').version)")"
ZIP_NAME="wisp-${VERSION}.zip"
ZIP_PATH="$PROJECT_DIR/build/$ZIP_NAME"

if [[ ! -f "$ZIP_PATH" ]]; then
  echo "ERROR: Expected package not found at $ZIP_PATH"
  exit 1
fi

echo ""

# --- Upload ---
echo "--- Uploading $ZIP_NAME to $TARGET:/tmp ---"
scp "$ZIP_PATH" "$TARGET:/tmp/$ZIP_NAME"

echo ""

# --- Remote install ---
INSTALL_FLAGS="$REMOTE_PATH"
if [[ "$RESTART_SVC" -eq 1 ]]; then
  INSTALL_FLAGS="$REMOTE_PATH --restart-svc"
fi

echo "--- Installing on $TARGET ---"
ssh -t "$TARGET" "set -e; rm -rf /tmp/wisp-update; mkdir -p /tmp/wisp-update; unzip -q '/tmp/$ZIP_NAME' -d /tmp/wisp-update; cd /tmp/wisp-update; bash ./scripts/install.sh $INSTALL_FLAGS; rm -rf /tmp/wisp-update '/tmp/$ZIP_NAME'"

echo ""
echo "=== Push complete ==="
