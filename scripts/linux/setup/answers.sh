#!/usr/bin/env bash
# Setup step: the install's answers, and the modes of the files that hold
# secrets. Given WISP_INSTALL_ANSWERS (the installer's directory of answers:
# `server-name`, `password`), the server name and the password go into the
# config, as the deploy user — before the bridge step, so only the start comes
# after it. An update gives none, and nothing is asked here. Then
# config/runtime.env, config/wisp-config.json and config/wisp-password are
# 0600 wherever they exist.
# Usage: answers.sh <project-root> <deploy-user>   (as root)
set -euo pipefail

if [[ $EUID -ne 0 || $# -ne 2 ]]; then
  echo "Usage (as root): $0 <project-root> <deploy-user>" >&2
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
# shellcheck source=install-state.sh
source "$SETUP_DIR/install-state.sh"

echo "--- Install answers and secret files ---"

INSTALL_DIR="$1"
DEPLOY_USER="$2"
ANSWERS="${WISP_INSTALL_ANSWERS:-}"
as_user() { runuser -u "$DEPLOY_USER" -- "$@"; }

if [[ -n "$ANSWERS" ]]; then
  if [[ -s "$ANSWERS/server-name" ]] && ! has_server_name "$INSTALL_DIR"; then
    as_user "$SETUP_DIR/config.sh" "$INSTALL_DIR" "$(cat "$ANSWERS/server-name")" >/dev/null
    changed "server name in config/wisp-config.json"
  fi
  if [[ -s "$ANSWERS/password" ]] && ! has_password "$INSTALL_DIR"; then
    as_user "$SETUP_DIR/password.sh" "$INSTALL_DIR" --stdin < "$ANSWERS/password" >/dev/null
    changed "password in config/wisp-password"
  fi
fi

# The answers, the password in plain text among them, go once they are written.
if [[ -n "$ANSWERS" ]]; then
  rm -rf -- "$ANSWERS"
fi

for file in runtime.env wisp-config.json wisp-password; do
  path="$INSTALL_DIR/config/$file"
  [[ -f "$path" ]] || continue
  if [[ "$(stat -c '%a' "$path")" != 600 ]]; then
    chmod 600 "$path"
    changed "config/$file is 0600"
  fi
done
step_done
