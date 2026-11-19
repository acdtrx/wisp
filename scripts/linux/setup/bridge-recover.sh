#!/usr/bin/env bash
# Setup step, the first: a bridge step that died (a power loss, a KILL) left
# its journal, decided on before setup works out anything else
# (bridge-journal.sh, journal_recover): committed when it had in fact finished,
# dropped when it changed nothing, undone otherwise, refused when someone else
# changed what it wrote since. Read-only while it decides, so a stop then ends
# it at once; deaf to a stop while it commits or undoes. Run as root.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (use sudo)." >&2
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=step.sh
source "$SETUP_DIR/step.sh"
# shellcheck source=bridge-journal.sh
source "$SETUP_DIR/bridge-journal.sh"
step_begin
# The tools' output is parsed: one locale for all of it.
export LC_ALL=C

echo "--- Bridge journal ---"
journal_recover
step_done
