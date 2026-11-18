#!/usr/bin/env bash
# Prompt for password, hash with scrypt, write to config/wisp-password.
# Usage: password.sh <install-dir> [--force | --stdin]
#   --force  ask and replace an existing password file (wispctl password --force)
#   --stdin  take the password as one line on stdin, unasked (the installer's root
#            process; the installer has already checked it)
# Without either, skips if password file already exists.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <install-dir> [--force]"
  exit 1
fi

INSTALL_DIR="$1"
# shellcheck source=install-state.sh
source "$(dirname "$0")/install-state.sh"
FORCE=0
FROM_STDIN=0
case "${2:-}" in
  --force) FORCE=1 ;;
  --stdin) FROM_STDIN=1 ;;
  "") ;;
  *) echo "Usage: $0 <install-dir> [--force | --stdin]"; exit 1 ;;
esac

CONFIG_DIR="$INSTALL_DIR/config"
PASSWORD_FILE="$CONFIG_DIR/wisp-password"

echo "--- Password (config/wisp-password) ---"

mkdir -p "$CONFIG_DIR"

if has_password "$INSTALL_DIR" && [[ "$FORCE" -eq 0 ]]; then
  echo "  Password file already exists. Skipping. Use: wispctl password --force"
  exit 0
fi

if (( FROM_STDIN )); then
  IFS= read -r PASSWORD || true
  if ! password_ok "$PASSWORD"; then
    echo "ERROR: the password must have $PASSWORD_RULE." >&2
    exit 1
  fi
fi

while (( ! FROM_STDIN )); do
  read -r -s -p "Enter password: " PASSWORD
  echo ""
  if ! password_ok "$PASSWORD"; then
    echo "  The password needs $PASSWORD_RULE. Try again."
    continue
  fi
  read -r -s -p "Confirm password: " PASSWORD2
  echo ""
  if [[ "$PASSWORD" != "$PASSWORD2" ]]; then
    echo "  Passwords do not match. Try again."
    continue
  fi
  break
done

# The password reaches node on stdin, never as an argument (visible to `ps`).
printf '%s' "$PASSWORD" | node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  const path = process.argv[1];
  const password = fs.readFileSync(0, "utf8");
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  const line = "scrypt:" + salt.toString("hex") + ":" + key.toString("hex") + "\n";
  fs.writeFileSync(path, line, { mode: 0o600, encoding: "utf8" });
' "$PASSWORD_FILE"
echo "  Wrote hashed password to config/wisp-password"
