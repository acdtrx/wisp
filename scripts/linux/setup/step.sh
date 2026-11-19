# Shared by the setup steps; source it, do not execute it. A step checks first
# and changes only what is missing: it reports each change with `changed`, and
# `step_done` says "in place" when there was none.

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STEP_CHANGED=0

# step_begin: the step's own temp directory (staged_file runs in a command
# substitution, a subshell, so it is made here), removed when the step ends,
# and the step's handler for a stop (step_stop). Every step calls it first:
# the traps are the step's own, set by the step.
step_begin() {
  STEP_TMP_DIR="$(mktemp -d -t wisp-setup.XXXXXX)" || { echo "ERROR: cannot create a temp directory" >&2; exit 1; }
  trap 'rm -rf "$STEP_TMP_DIR"' EXIT
  STEP_HELD=0 STEP_STOP_HELD=0 STEP_ON_STOP=""
  trap step_stop TERM INT
}

# step_stop: a stop (TERM, INT), which setup sends to the step alone — the step
# knows which of what it runs may be cut short. TERM to the rest of the step's
# session (the command it waits for, what that started), then STEP_ON_STOP when
# the step set one (the bridge step's undo), then exit 143; setup waits until
# the session is empty. A step runs no foreground command that can outlast
# NET_CMD_SEC (anything longer goes through step_run), so a stop is acted on
# within that. Inside a section that must finish (step_hold), the stop waits
# for step_release.
step_stop() {
  if (( STEP_HELD )); then STEP_STOP_HELD=1; return 0; fi
  # From here a further stop only waits: the undo's tools keep their own
  # signals' defaults (an ignored TERM would be theirs too).
  STEP_HELD=1
  pkill -TERM -s "$$" 2>/dev/null
  if [[ -n "$STEP_ON_STOP" ]]; then "$STEP_ON_STOP"; fi
  exit 143
}
# step_hold, step_release: a section that must finish (the bridge's apply
# call, its finish and undo, the journal's restore). A stop meanwhile waits:
# the tools the section runs run to their end, each under its own bound, and
# step_release then acts on it.
step_hold() { STEP_HELD=1; }
step_release() {
  STEP_HELD=0
  if (( STEP_STOP_HELD )); then STEP_STOP_HELD=0; step_stop; fi
}

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
  staged_leftovers_remove "$dest"
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
  step_run 0 systemctl enable --now --quiet "$unit" || fail "cannot enable and start $unit"
  changed "$unit enabled and started"
}

# step_run <idle-secs> <cmd...>: cmd in the background, waited for, so a stop
# of the step is acted on at once (step_stop) — how a step runs anything that
# can outlast NET_CMD_SEC. With <idle-secs> above 0, cmd's output is passed
# through and cmd is stopped after that many seconds without a line, returning
# 124: the inactivity bound for a command that shows progress (CODING-RULES
# §6); cmd runs in a process group of its own inside the step's session, which
# gets TERM, and KILL STEP_RUN_GRACE_SEC later. With 0, cmd carries its own
# bound (its `timeout`, or the systemd job's). Returns cmd's exit status.
STEP_RUN_GRACE_SEC=10
step_run() {
  local secs="$1"; shift
  local fifo fd line r pid rc=0 idle=0 deadline
  if (( secs == 0 )); then
    "$@" &
    pid=$!
  else
    fifo="$(mktemp -u "$STEP_TMP_DIR/fifo.XXXXXX")"
    mkfifo -m 600 "$fifo" || fail "cannot make a fifo in $STEP_TMP_DIR"
    set -m
    "$@" > "$fifo" 2>&1 &
    pid=$!
    set +m
    exec {fd}< "$fifo"
    rm -f -- "$fifo"
    # A held stop does not end the read: bash runs the handler and reads on.
    while :; do
      IFS= read -r -t "$secs" -u "$fd" line && r=0 || r=$?
      if (( r == 0 )); then printf '%s\n' "$line"; continue; fi
      if [[ -n "$line" ]]; then printf '%s\n' "$line"; fi
      (( r > 128 )) && idle=1
      break
    done
    exec {fd}<&-
    if (( idle )); then
      kill -TERM -- "-$pid" 2>/dev/null
      deadline=$(( SECONDS + STEP_RUN_GRACE_SEC ))
      while pgrep -g "$pid" >/dev/null && (( SECONDS < deadline )); do sleep 1; done
      kill -KILL -- "-$pid" 2>/dev/null
    fi
  fi
  # wait returns early for a held stop; once cmd is gone (reaped by bash), wait
  # gives its status.
  while kill -0 "$pid" 2>/dev/null; do wait "$pid" 2>/dev/null || true; done
  wait "$pid" 2>/dev/null || rc=$?
  if (( idle )); then
    echo "ERROR: printed nothing for ${secs} s and was stopped: $*" >&2
    return 124
  fi
  return "$rc"
}
