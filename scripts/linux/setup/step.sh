# Shared by the setup steps; source it, do not execute it. A step checks first
# and changes only what is missing: it reports each change with `changed`, and
# `step_done` says "in place" when there was none.

STEP_CHANGED=0

changed() {
  echo "  changed: $*"
  STEP_CHANGED=1
}

step_done() {
  if (( STEP_CHANGED == 0 )); then echo "  in place"; fi
}

# write_if_changed <dest> <mode>, the content on stdin: replace <dest> only when
# its content or mode differs. Returns 0 when it wrote, 1 when <dest> was
# already that. Staged beside <dest> and renamed into place, so a process
# running the old file (wisp-updater refreshing itself) keeps its inode.
write_if_changed() {
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp "${dest}.wisp-new.XXXXXX")"
  cat > "$tmp"
  if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest" && [[ "$(stat -c %a "$dest")" == "${mode#0}" ]]; then
    rm -f "$tmp"
    return 1
  fi
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

# unit_on <unit>: enable and start <unit> unless it already is both.
unit_on() {
  local unit="$1"
  if systemctl is-enabled --quiet "$unit" 2>/dev/null && systemctl is-active --quiet "$unit"; then
    return 0
  fi
  systemctl enable --now "$unit" >/dev/null
  changed "$unit enabled and started"
}
