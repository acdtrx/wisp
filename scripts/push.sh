#!/usr/bin/env bash
# Stage the release-shaped tarball (scripts/stage-release.sh), upload it to a
# remote server, and install/update from it there.
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

# REMOTE_PATH is spliced into a remote shell command below. Constrain it to a
# plain absolute path so it cannot inject shell metacharacters server-side.
if [[ ! "$REMOTE_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "ERROR: Remote path must be an absolute path containing only [A-Za-z0-9._/-]: $REMOTE_PATH"
  exit 1
fi

# CODING-RULES §6: a dead host fails the connect in 10 s, and a link that stops
# answering for a minute (4 missed keepalives, 15 s apart) drops — the install
# itself may run long, but sshd answers keepalives throughout.
SSH_OPTS=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Wisp Push ==="
echo "Target: $TARGET:$REMOTE_PATH"
echo ""

# --- Stage: the release-shaped tarball, as a release ships it ---
echo "--- Staging ---"
STAGE_OUT="$PROJECT_DIR/build/push"
"$SCRIPT_DIR/stage-release.sh" "$STAGE_OUT"

VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
TARBALL_NAME="wisp-${VERSION}.tar.gz"
TARBALL="$STAGE_OUT/$TARBALL_NAME"

echo ""

# --- Upload ---
echo "--- Uploading $TARBALL_NAME to $TARGET:/tmp ---"
scp "${SSH_OPTS[@]}" "$TARBALL" "$TARGET:/tmp/$TARBALL_NAME"

echo ""

# --- Remote install: tar is all the host needs ---
INSTALL_FLAGS="$REMOTE_PATH"
if [[ "$RESTART_SVC" -eq 1 ]]; then
  INSTALL_FLAGS="$REMOTE_PATH --restart-svc"
fi

echo "--- Installing on $TARGET ---"
# The staging directory and the tarball go whatever the install's outcome.
if ! ssh "${SSH_OPTS[@]}" -t "$TARGET" "set -e; trap 'rm -rf /tmp/wisp-update /tmp/$TARBALL_NAME' EXIT; rm -rf /tmp/wisp-update; mkdir -p /tmp/wisp-update; tar -xzf '/tmp/$TARBALL_NAME' -C /tmp/wisp-update; cd /tmp/wisp-update/wisp; bash ./scripts/install.sh $INSTALL_FLAGS"; then
  echo ""
  echo "ERROR: the install on $TARGET failed (see above)." >&2
  exit 1
fi

echo ""
echo "=== Push complete ==="
