# Sourced by setup, its steps and the installer; do not execute it. Helpers
# they share, with no state of their own. Nothing here sets a trap of its
# caller's.

# The one lock for anything that changes the installation: install, update and
# setup each hold it for their whole run (fd 8). wisp-updater, installed on its
# own, names it too; scripts/check-bounds.mjs keeps the two the same.
WISP_LOCK=/run/wisp.lock

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
