#!/usr/bin/env bash
# The installer's root process (scripts/linux/install.sh runs it under sudo, in
# a session of its own, once every question is answered): copy the tree, run
# setup, write the answers, install the backend's dependencies, and start Wisp,
# waiting until it is ready. Asks nothing. The password, when the install has
# none yet, is the first line on stdin.
#
# Usage: install-root.sh <source-dir> <install-dir> <user> <group> <server-name or "">
set -euo pipefail

if [[ $EUID -ne 0 || $# -ne 5 ]]; then
  echo "Usage (as root, from install.sh): $0 <source-dir> <install-dir> <user> <group> <server-name or \"\">" >&2
  exit 1
fi

SOURCE_DIR="$1"
INSTALL_DIR="$2"
DEPLOY_USER="$3"
DEPLOY_GROUP="$4"
SERVER_NAME="$5"
IFS= read -r PASSWORD || true

as_user() { runuser -u "$DEPLOY_USER" -- "$@"; }

echo "--- Installing the tree ---"
"$SOURCE_DIR/scripts/linux/setup/copy.sh" "$SOURCE_DIR" "$INSTALL_DIR"
chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"
SETUP_DIR="$INSTALL_DIR/scripts/linux/setup"

echo ""
"$SETUP_DIR/common-steps.sh" "$INSTALL_DIR" "$DEPLOY_USER"

echo ""
if [[ -n "$SERVER_NAME" ]]; then
  as_user "$SETUP_DIR/config.sh" "$INSTALL_DIR" "$SERVER_NAME"
fi
if [[ -n "$PASSWORD" ]]; then
  printf '%s\n' "$PASSWORD" | as_user "$SETUP_DIR/password.sh" "$INSTALL_DIR" --stdin
fi
unset PASSWORD

echo ""
echo "--- Backend dependencies (the tree ships without node_modules) ---"
as_user bash -c "cd '$INSTALL_DIR/backend' && npm ci --omit=dev --omit=optional"

echo ""
as_user "$SETUP_DIR/permissions.sh" "$INSTALL_DIR"

echo ""
echo "--- Starting Wisp ---"
# shellcheck source=setup/service.sh
source "$SETUP_DIR/service.sh"
wisp_service restart

# shellcheck source=../../backend/scripts/wisp-port.sh
source "$INSTALL_DIR/backend/scripts/wisp-port.sh"
WISP_PORT="$(wisp_port "$INSTALL_DIR/config/runtime.env")"
echo ""
echo "=== Install complete ==="
echo ""
echo "  Install path: $INSTALL_DIR"
echo "  Access:       http://$(hostname -f 2>/dev/null || hostname):${WISP_PORT}"
echo ""
