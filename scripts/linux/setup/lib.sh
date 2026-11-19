# Sourced by setup, its steps and the installer; do not execute it. Helpers
# they share, with no state of their own. Nothing here sets a trap of its
# caller's.

# refuse <CODE> <message> [<line>...]: this host is refused, before anything
# changes. The message names what was found and what to do, further lines
# indented below it; CODE (the error-code style of
# docs/specs/ERROR-HANDLING.md) is the row of docs/specs/DEPLOYMENT.md's
# refusals table that says more, and scripts/check-refusals.mjs keeps the two in
# step. An explicit exit, so it holds where `set -e` does not.
refuse() {
  local code="$1" line; shift
  echo "ERROR $code: $1" >&2
  shift
  for line in "$@"; do echo "       $line" >&2; done
  exit 1
}

# install_file <dest> <src> <mode> [owner:group, default root:root]: <src>'s
# content in place as <dest>, staged beside it, synced, renamed, and the
# directory synced — so a power loss leaves the old file or the new one, never
# an empty one, and a process running the old file (wisp-updater refreshing
# itself) keeps its inode. Returns non-zero, leaving <dest> as it was, on any
# failure. A stage an earlier run left behind (cut short between stage and
# rename) is removed first: under the install lock, only setup makes them.
install_file() {
  local tmp
  rm -f -- "$1".wisp-new.* || return 1
  tmp="$(mktemp "$1.wisp-new.XXXXXX")" || return 1
  { cp "$2" "$tmp" && chmod "$3" "$tmp" && chown "${4:-root:root}" "$tmp" && sync "$tmp" \
    && mv -f "$tmp" "$1" && sync "$(dirname "$1")"; } || { rm -f "$tmp"; return 1; }
}
# remove_file <path>: gone, and the directory synced — when the directory is
# still there: an undo run again after it removed the directory too succeeds.
remove_file() { rm -f "$1" && { [[ ! -d "$(dirname "$1")" ]] || sync "$(dirname "$1")"; }; }

# Processes are stopped by session: a step, and each command a caller bounds,
# runs as the leader of a session of its own (`setsid cmd &`, its pid the
# session's id), and every process it starts stays in that session — `timeout`
# among them, which moves to a process group of its own, out of reach of a
# signal to the group.
#
# session_signal <signal> <sid>: to every process of the session.
session_signal() { pkill "-$1" -s "$2" 2>/dev/null || true; }
# session_wait <pid>: until the session that pid leads is empty — its leader
# reaped (it is a child of the caller) and every process it started gone.
# There is no event for that: checked once a second, bounded by whoever stops
# the session (kill_later).
session_wait() {
  while :; do
    wait "$1" 2>/dev/null
    kill -0 "$1" 2>/dev/null && continue
    pgrep -s "$1" >/dev/null || return 0
    sleep 1
  done
}

# kill_later <secs> <sid>: in the background, KILL to the session after
# <secs>; sets KILLER to its pid, which `kill -USR1` cancels. Deaf to TERM and
# INT, so a stop sent to the caller leaves it be, and without the install
# lock's descriptor (fd 8), so one left behind holds no lock. (wisp-updater,
# installed on its own, has its own copy, signal_later.)
kill_later() {
  (
    exec 8>&-
    trap '' TERM INT
    trap 'kill -KILL $! 2>/dev/null; exit 0' USR1
    sleep "$1" & wait $!
    pkill -KILL -s "$2" 2>/dev/null
  ) &
  KILLER=$!
}
# kill_later_cancel: the KILLER kill_later started, cancelled and reaped.
kill_later_cancel() {
  kill -USR1 "$KILLER" 2>/dev/null
  wait "$KILLER" 2>/dev/null
  return 0
}
