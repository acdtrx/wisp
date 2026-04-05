#!/usr/bin/env bash
# Prompt for password, hash with scrypt, write to config/wisp-password.
# Usage: password.sh <install-dir> [--force]
# Without --force, skips if password file already exists (install flow).
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <install-dir> [--force]"
  exit 1
fi

INSTALL_DIR="$1"
FORCE=0
if [[ "${2:-}" == "--force" ]]; then
  FORCE=1
fi

CONFIG_DIR="$INSTALL_DIR/config"
PASSWORD_FILE="$CONFIG_DIR/wisp-password"

echo "--- Password (config/wisp-password) ---"

mkdir -p "$CONFIG_DIR"

if [[ -f "$PASSWORD_FILE" ]] && [[ "$FORCE" -eq 0 ]]; then
  echo "  Password file already exists. Skipping. Use: wispctl password --force"
  exit 0
fi

while true; do
  read -r -s -p "Enter password: " PASSWORD
  echo ""
  if [[ "${#PASSWORD}" -lt 6 ]]; then
    echo "  Password must be at least 6 characters. Try again."
    continue
  fi
  if [[ "$PASSWORD" == "changeme" ]]; then
    echo "  Do not use the placeholder password 'changeme'. Choose a different password."
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

node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  const path = process.argv[1];
  const password = process.argv[2];
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  const line = "scrypt:" + salt.toString("hex") + ":" + key.toString("hex") + "\n";
  fs.writeFileSync(path, line, { mode: 0o600, encoding: "utf8" });
' "$PASSWORD_FILE" "$PASSWORD"
echo "  Wrote hashed password to config/wisp-password"
