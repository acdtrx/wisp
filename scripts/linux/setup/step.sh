# Shared by the setup steps; source it, do not execute it. A step checks first
# and changes only what is missing: it reports each change with `changed`, and
# `step_done` says "in place" when there was none.

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
# may be empty. Staged beside <dest> and renamed into place, so a process
# running the old file (wisp-updater refreshing itself) keeps its inode.
write_if_changed() {
  local dest="$1" mode="$2" src="$3" owner="${4:-root:root}" tmp
  [[ -s "$src" ]] || fail "refusing to write $dest: the content is empty"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest" \
    && [[ "$(stat -c '%a %U:%G' "$dest")" == "${mode#0} $owner" ]]; then
    return 1
  fi
  [[ -d "$(dirname "$dest")" ]] || fail "cannot write $dest: $(dirname "$dest") does not exist"
  tmp="$(mktemp "${dest}.wisp-new.XXXXXX")" || fail "cannot stage $dest"
  cp "$src" "$tmp" && chmod "$mode" "$tmp" && chown "$owner" "$tmp" && mv -f "$tmp" "$dest" \
    || { rm -f "$tmp"; fail "cannot write $dest"; }
  return 0
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
