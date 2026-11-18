#!/usr/bin/env bash
# Setup step: the backend's dependencies — the tree ships without node_modules —
# installed with `npm ci` as the deploy user. Before the bridge step, so nothing
# that needs the network comes after it. Checks first: a marker in node_modules
# records the package-lock.json and the Node.js version it was installed for
# (native modules follow Node's ABI); a match runs no package manager.
# Usage: backend-deps.sh <project-root> <deploy-user>   (as root)
set -euo pipefail

if [[ $EUID -ne 0 || $# -ne 2 ]]; then
  echo "Usage (as root): $0 <project-root> <deploy-user>" >&2
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"

echo "--- Backend dependencies ---"

BACKEND="$1/backend"
DEPLOY_USER="$2"
MARKER="$BACKEND/node_modules/.wisp-installed-for"
# npm ci logs each fetch at --loglevel=http: its progress, watched by idle_run.
NPM_IDLE_SEC=600

LOCK_SUM="$(sha256sum "$BACKEND/package-lock.json")" || fail "cannot read $BACKEND/package-lock.json"
NODE_VERSION="$(timeout 10 node --version)" || fail "node does not run"
WANT="${LOCK_SUM%% *} node $NODE_VERSION"

if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$WANT" ]]; then
  step_done
  exit 0
fi
idle_run "$NPM_IDLE_SEC" runuser -u "$DEPLOY_USER" -- env -C "$BACKEND" npm ci --omit=dev --omit=optional --loglevel=http \
  || fail "npm ci failed in $BACKEND"
# Written as the deploy user, in the deploy user's directory.
printf '%s\n' "$WANT" | runuser -u "$DEPLOY_USER" -- tee "$MARKER" >/dev/null || fail "cannot write $MARKER"
changed "backend dependencies installed (npm ci, $NODE_VERSION)"
step_done
