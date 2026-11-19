# Shared by the setup steps; source it, do not execute it. A step checks first
# and changes only what is missing: it reports each change with `changed`, and
# `step_done` says "in place" when there was none.

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STEP_CHANGED=0
# One temp directory per step, made here in the step's own shell (staged_file
# runs in a command substitution, a subshell) and removed when the step ends.
STEP_TMP_DIR="$(mktemp -d -t wisp-setup.XXXXXX)" || { echo "ERROR: cannot create a temp directory" >&2; exit 1; }
trap 'rm -rf "$STEP_TMP_DIR"' EXIT

changed() {
  echo "  changed: $*"
  STEP_CHANGED=1
}

step_done() {
  if (( STEP_CHANGED == 0 )); then echo "  in place"; fi
}

# fail <message>: end the step. An explicit exit, so it holds where `set -e`
# does not: inside a function called as an `if` condition.
fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# staged_file: a new file in the step's temp directory, removed when the step
# ends. Render content into it first (under `set -e`, so a missing template fails
# the step), then pass it to write_if_changed.
staged_file() {
  mktemp "$STEP_TMP_DIR/f.XXXXXX" || fail "cannot create a temp file"
}

# write_if_changed <dest> <mode> <content-file> [owner:group, default root:root]:
# put <content-file>'s content at <dest> unless <dest> already has that content,
# mode and owner. Returns 0 when it wrote, 1 when <dest> was already that; any
# failure ends the step, and so does empty content: nothing Wisp writes this way
# may be empty. Written by install_file (lib.sh).
write_if_changed() {
  local dest="$1" mode="$2" src="$3" owner="${4:-root:root}"
  [[ -s "$src" ]] || fail "refusing to write $dest: the content is empty"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest" \
    && [[ "$(stat -c '%a %U:%G' "$dest")" == "${mode#0} $owner" ]]; then
    return 1
  fi
  [[ -d "$(dirname "$dest")" ]] || fail "cannot write $dest: $(dirname "$dest") does not exist"
  install_file "$dest" "$src" "$mode" "$owner" || fail "cannot write $dest"
  return 0
}

# in_group <user> <group>: whether <user> is in <group>. Captured, then
# matched: a `grep -q` at the end of a pipeline can exit before its writer, whose
# SIGPIPE under `pipefail` would read as "not there".
in_group() {
  local groups
  groups="$(id -nG "$1")"
  [[ " $groups " == *" $2 "* ]]
}

# unit_on <name>: <name>'s socket, when the unit has one (the daemon starts on
# demand and idles out behind it), else its service, enabled and active.
unit_on() {
  local unit="$1"
  if systemctl cat --no-pager "$1.socket" &>/dev/null; then
    unit="$1.socket"
  fi
  if systemctl is-enabled --quiet "$unit" 2>/dev/null && systemctl is-active --quiet "$unit"; then
    return 0
  fi
  systemctl enable --now --quiet "$unit" || fail "cannot enable and start $unit"
  changed "$unit enabled and started"
}

# idle_run <secs> <cmd...>: cmd with its output passed through, stopped after
# <secs> seconds without a line of output (returns 124) — an inactivity bound
# for a step that shows progress (CODING-RULES §6). cmd runs in a session of its
# own, so a stall, or a stop of the step (TERM, INT; returns 143), stops the
# whole group, its children with it: TERM, and KILL IDLE_RUN_GRACE_SEC later.
IDLE_RUN_GRACE_SEC=10
idle_run() {
  local secs="$1"; shift
  local fifo fd line r rc=0 why="" pid signalled=0
  fifo="$(mktemp -u "$STEP_TMP_DIR/fifo.XXXXXX")"
  mkfifo -m 600 "$fifo"
  IDLE_RUN_STOPPED=0
  trap 'IDLE_RUN_STOPPED=1' TERM INT
  setsid "$@" > "$fifo" 2>&1 &
  pid=$!
  exec {fd}< "$fifo"
  rm -f -- "$fifo"
  while :; do
    IFS= read -r -t "$secs" -u "$fd" line && r=0 || r=$?
    if (( IDLE_RUN_STOPPED )); then why=stopped; break; fi
    if (( r == 0 )); then printf '%s\n' "$line"; continue; fi
    if (( r > 128 )); then why=idle; break; fi
    [[ -n "$line" ]] && printf '%s\n' "$line"
    break
  done
  exec {fd}<&-
  # wait returns early for a signal; cmd is gone once kill -0 fails.
  while :; do
    if [[ -z "$why" ]] && (( IDLE_RUN_STOPPED )); then why=stopped; fi
    if [[ -n "$why" ]] && (( ! signalled )); then
      kill -TERM -- "-$pid" 2>/dev/null
      kill_later "$IDLE_RUN_GRACE_SEC" "$pid"
      signalled=1
    fi
    rc=0
    wait "$pid" 2>/dev/null || rc=$?
    kill -0 "$pid" 2>/dev/null || break
  done
  if (( signalled )); then kill -USR1 "$KILLER" 2>/dev/null; wait "$KILLER" 2>/dev/null; fi
  trap - TERM INT
  case "$why" in
    idle) echo "ERROR: printed nothing for ${secs} s and was stopped: $*" >&2; return 124 ;;
    stopped) echo "  stopped: $*" >&2; return 143 ;;
  esac
  return "$rc"
}
