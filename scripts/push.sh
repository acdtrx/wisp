#!/usr/bin/env bash
# Stage the release-shaped tarball (scripts/stage-release.sh), upload it to a
# remote server, and install/update from it there.
#
# Usage: ./scripts/push.sh user@server /remote/path
# The installer on the server asks only what the install does not have yet (on
# a fresh host: the server name, the password, the bridge), over this terminal.
set -euo pipefail

TARGET=""
REMOTE_PATH=""

for arg in "$@"; do
  case "$arg" in
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
  echo "Usage: $0 user@server /remote/path"
  echo "Example: $0 deploy@192.168.1.100 /opt/wisp"
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

echo "--- Installing on $TARGET ---"
# Each push extracts into a directory of its own, so a second push never
# touches the tree a running install copies from. The directory and the
# tarball go once the install has returned, whatever its outcome; not on a
# hangup: an install whose connection drops goes on, copying from there.
if ! ssh "${SSH_OPTS[@]}" -t "$TARGET" "d=\$(mktemp -d /tmp/wisp-push.XXXXXX) && tar -xzf '/tmp/$TARBALL_NAME' -C \"\$d\" || exit 1; rm -f '/tmp/$TARBALL_NAME'; cd \"\$d/wisp\" && bash ./scripts/install.sh $REMOTE_PATH; rc=\$?; rm -rf \"\$d\"; exit \$rc"; then
  echo ""
  echo "ERROR: the install on $TARGET failed (see above)." >&2
  exit 1
fi

echo ""
echo "=== Push complete ==="
