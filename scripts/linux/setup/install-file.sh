# Sourced by step.sh and bridge-journal.sh; do not execute it.

# install_file <dest> <src> <mode> [owner:group, default root:root]: <src>'s
# content in place as <dest>, staged beside it, synced, renamed, and the
# directory synced — so a power loss leaves the old file or the new one, never
# an empty one, and a process running the old file (wisp-updater refreshing
# itself) keeps its inode. Returns non-zero, leaving <dest> as it was, on any
# failure.
install_file() {
  local tmp
  tmp="$(mktemp "$1.wisp-new.XXXXXX")" || return 1
  { cp "$2" "$tmp" && chmod "$3" "$tmp" && chown "${4:-root:root}" "$tmp" && sync "$tmp" \
    && mv -f "$tmp" "$1" && sync "$(dirname "$1")"; } || { rm -f "$tmp"; return 1; }
}
# remove_file <path>: gone, and the directory synced.
remove_file() { rm -f "$1" && sync "$(dirname "$1")"; }
