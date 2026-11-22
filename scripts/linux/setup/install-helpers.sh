#!/usr/bin/env bash
# Setup step: Wisp's privileged helpers in /usr/local/bin, each with the sudoers
# rule that lets the deploy user run it, their shared file, and wisp-updater with
# its unit and its one sudoers rule. Run as root. Copies only what differs from
# the install tree; the packages the helpers run (dmidecode, smartmontools,
# cifs-utils, rsync) come from the packages step.
#
# Exactly this release's set (docs/specs/DEPLOYMENT.md, Privileged helpers):
# setup owns every wisp-* entry in /usr/local/bin and /etc/sudoers.d, and
# removes any its set does not hold, an earlier release's, after the set is in
# place. The helpers are the folder: every backend/scripts/wisp-* that starts
# with a shebang, but the updater (scripts/check-shell.mjs holds the folder to
# that shape).
#
# Usage: install-helpers.sh <project-root> <deploy-user>
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: install-helpers.sh must run as root (e.g. sudo $0 ...)."
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <project-root> <deploy-user>"
  exit 1
fi

PROJECT_ROOT="$(cd "$1" && pwd)"
DEPLOY_USER="$2"
SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
step_begin

HELPER_SRC="$PROJECT_ROOT/backend/scripts"
BIN_DIR=/usr/local/bin
RULES_DIR=/etc/sudoers.d
HELPER_LIB=wisp-helper-lib.sh

HELPERS=()
for src in "$HELPER_SRC"/wisp-*; do
  name="${src##*/}"
  [[ -f "$src" && "$name" != wisp-updater ]] || continue
  first=""
  read -r -n 2 first < "$src" || true
  [[ "$first" == '#!' ]] && HELPERS+=("$name")
done
(( ${#HELPERS[@]} > 0 )) || fail "no helpers in $HELPER_SRC"

# What the set holds, by name, in each folder.
declare -A IN_SET_BIN=([$HELPER_LIB]=1 [wisp-updater]=1) IN_SET_RULE=([wisp-updater]=1)

echo "--- Privileged helpers (/usr/local/bin) ---"

# install_sudoers <file> <line>: the rule checked by visudo while still staged,
# then put in place only when it differs. A rule visudo rejects never goes live,
# and the one already in place stays. sudo-rs's visudo (Ubuntu from 25.10) says
# "parsed OK" on stdout despite -q; its errors are on stderr.
install_sudoers() {
  local file="$1" line="$2" staged
  staged="$(staged_file)"
  printf '%s\n' "$line" > "$staged"
  visudo -cqf "$staged" >/dev/null || fail "$file: the rule \"$line\" is not valid sudoers syntax"
  if write_if_changed "$file" 0440 "$staged"; then changed "$file"; fi
}

# Written by atomic rename (write_if_changed): wisp-updater runs this step
# mid-update, and the running updater must keep its inode to finish.
# The helpers' shared file first, which each sources from its own folder: not
# a command (0644), no sudoers rule. Then each helper, then its rule.
[[ -f "$HELPER_SRC/$HELPER_LIB" ]] || fail "backend/scripts/$HELPER_LIB missing from the install tree"
if write_if_changed "$BIN_DIR/$HELPER_LIB" 0644 "$HELPER_SRC/$HELPER_LIB"; then
  changed "$BIN_DIR/$HELPER_LIB"
fi
for name in "${HELPERS[@]}"; do
  dest="$BIN_DIR/$name"
  rule="${name//[^a-z0-9-]/}"
  if write_if_changed "$dest" 0755 "$HELPER_SRC/$name"; then changed "$dest"; fi
  install_sudoers "$RULES_DIR/$rule" "$DEPLOY_USER ALL=(root) NOPASSWD: $dest"
  IN_SET_BIN[$name]=1
  IN_SET_RULE[$rule]=1
done

echo "--- wisp-updater (self-update applier, run as wisp-updater.service) ---"

[[ -f "$PROJECT_ROOT/backend/scripts/wisp-updater" ]] || fail "backend/scripts/wisp-updater missing from the install tree"
if write_if_changed /usr/local/bin/wisp-updater 0755 "$PROJECT_ROOT/backend/scripts/wisp-updater"; then
  changed /usr/local/bin/wisp-updater
fi

# WISP_PATH → the install dir, which the updater reads as $WISP_INSTALL_DIR.
UPDATER_UNIT="$(staged_file)"
sed -e "s|WISP_PATH|$PROJECT_ROOT|g" "$PROJECT_ROOT/systemd/linux/wisp-updater.service" > "$UPDATER_UNIT"
if write_if_changed /etc/systemd/system/wisp-updater.service 0644 "$UPDATER_UNIT"; then
  systemd_call daemon-reload
  changed /etc/systemd/system/wisp-updater.service
fi

# The deploy user may trigger the unit, and only that: argv must match the
# backend's invocation exactly (sudo -n /usr/bin/systemctl start --no-block wisp-updater.service).
install_sudoers /etc/sudoers.d/wisp-updater \
  "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service"

# Last, with the set in place: any other wisp-* is an earlier release's (or a
# release this host was rolled back from). Its rule goes before its file, so no
# rule names a removed command for a moment longer than it must.
echo "--- Helpers and rules no longer in the set ---"
for dir in "$RULES_DIR" "$BIN_DIR"; do
  for entry in "$dir"/wisp-*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="${entry##*/}"
    if [[ "$dir" == "$RULES_DIR" ]]; then
      [[ -z "${IN_SET_RULE[$name]:-}" ]] || continue
    else
      [[ -z "${IN_SET_BIN[$name]:-}" ]] || continue
    fi
    rm -f -- "$entry" || fail "cannot remove $entry"
    changed "removed $entry"
  done
done

step_done
