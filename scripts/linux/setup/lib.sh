# Sourced by step.sh, bridge-journal.sh and common-steps.sh; do not execute it.
# Helpers they share, with no state of their own.

# install_file <dest> <src> <mode> [owner:group, default root:root]: <src>'s
# content in place as <dest>, staged beside it, synced, renamed, and the
# directory synced — so a power loss leaves the old file or the new one, never
# an empty one, and a process running the old file (wisp-updater refreshing
# itself) keeps its inode. Returns non-zero, leaving <dest> as it was, on any
# failure. A stage an earlier run left behind (cut short between stage and
# rename) is removed first: under the install lock, only setup makes them.
install_file() {
  local tmp
  rm -f -- "$1".wisp-new.*
  tmp="$(mktemp "$1.wisp-new.XXXXXX")" || return 1
  { cp "$2" "$tmp" && chmod "$3" "$tmp" && chown "${4:-root:root}" "$tmp" && sync "$tmp" \
    && mv -f "$tmp" "$1" && sync "$(dirname "$1")"; } || { rm -f "$tmp"; return 1; }
}
# remove_file <path>: gone, and the directory synced.
remove_file() { rm -f "$1" && sync "$(dirname "$1")"; }

# kill_later <secs> <pgid>: in the background, KILL to the process group after
# <secs>; sets KILLER to its pid, which `kill -USR1` cancels. Deaf to TERM and
# INT, so a stop sent to the caller's own group leaves it be, and without the
# install lock's descriptor (fd 8), so one left behind holds no lock.
# (wisp-updater, installed on its own, has its own copy, signal_later.)
kill_later() {
  (
    exec 8>&-
    trap '' TERM INT
    trap 'kill -KILL $! 2>/dev/null; exit 0' USR1
    sleep "$1" & wait $!
    kill -KILL -- "-$2" 2>/dev/null
  ) &
  KILLER=$!
}
