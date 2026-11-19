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

# --- Upload, into a directory of the push's own on the host ---
# The installer accepts only a directory of this name for --remove-source
# (scripts/linux/install-root.sh, PUSH_DIR_PREFIX; scripts/check-bounds.mjs
# keeps the two the same).
PUSH_DIR_TEMPLATE=/tmp/wisp-push.XXXXXX
REMOTE_DIR="$(ssh -n "${SSH_OPTS[@]}" "$TARGET" "mktemp -d $PUSH_DIR_TEMPLATE")" \
  || { echo "ERROR: cannot make a directory for the push on $TARGET" >&2; exit 1; }
echo "--- Uploading $TARBALL_NAME to $TARGET:$REMOTE_DIR ---"
if ! scp "${SSH_OPTS[@]}" "$TARBALL" "$TARGET:$REMOTE_DIR/$TARBALL_NAME"; then
  ssh -n "${SSH_OPTS[@]}" "$TARGET" "rm -rf '$REMOTE_DIR'" || true
  echo "ERROR: the upload to $TARGET failed." >&2
  exit 1
fi

echo ""

# --- Remote install: tar is all the host needs ---

echo "--- Installing on $TARGET ---"
# Once the install has started (its root process marks the push's directory),
# it removes the directory itself when it is done with it (--remove-source),
# however this side ends: Ctrl-C and a dropped connection stop only the
# following. Until then the directory is the push's, removed here when the
# install never started.
if ! ssh "${SSH_OPTS[@]}" -t "$TARGET" "trap '' HUP; tar -xzf '$REMOTE_DIR/$TARBALL_NAME' -C '$REMOTE_DIR' && cd '$REMOTE_DIR/wisp' && bash ./scripts/install.sh $REMOTE_PATH --remove-source"; then
  ssh -n "${SSH_OPTS[@]}" "$TARGET" "[ -e '$REMOTE_DIR/.install-started' ] || rm -rf '$REMOTE_DIR'" || true
  echo ""
  echo "ERROR: the install on $TARGET failed or was stopped following (see above)." >&2
  exit 1
fi

echo ""
echo "=== Push complete ==="
