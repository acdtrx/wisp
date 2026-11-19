# Sourced by the bridge step and network-plan.sh, as root; do not execute it.
# The bridge step's journal: what it changes, written and synced before each
# change, so the change can be undone — by the step itself when its apply or
# the check after it fails or it is stopped, or by a later run when the step
# died. A later run reads it first and decides from what the host holds now,
# changing nothing while it decides (journal_classify): an earlier run that in
# fact finished is committed, one that changed nothing is dropped, one caught
# half way or in its undo is undone, and one whose files or connections were
# changed since by someone else is refused. The journal is data: read, never
# sourced.
#
# One entry per line, tab-separated, in the order of the apply:
#   host <net-tool> <uplink> <bridge> <uplink IPv4 address> <uplink connection or ->
#   file <path> <existed: yes|no> <sha256 of the original or -> <sha256 of what the step writes, - for none>
#        (its original, when it existed, kept as files/<n>, n its line number)
#   dir  <path>      a directory the step made
#   connrm <uuid>    the uplink's NetworkManager connection, which the step deletes
#   undo             an undo has begun: the run is undone, whatever it reached
# Every path is under one of JOURNAL_ROOTS; the plan refuses a source outside
# them. An entry is synced before its change, so a last line cut short (a power
# loss, a full disk) is a change that never happened, and is dropped. A success
# commits by one rename of the directory; the operator's original files then go
# to KEPT_DIR, named by their path.

# Uses net-state.sh's bounds (NET_CMD_SEC, NET_APPLY_SEC, NET_KILL_SEC).
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

JOURNAL_DIR=/var/lib/wisp/bridge-journal
KEPT_DIR=/var/lib/wisp/network-before-bridge
# Where the bridge step may change a file: each tool's own configuration.
JOURNAL_ROOTS=(/etc/netplan /etc/systemd/network /etc/NetworkManager/system-connections)

# How long a stopped bridge step can take to end, worst case, every bound run
# out (a call's bound is its limit and NET_KILL_SEC to die): the apply call in
# flight when the stop comes, which ends first (bridge.sh; the check between
# applies stops at once), then the longest undo, NetworkManager's
# (journal_restore): netplan's files generated, the connections reloaded, the
# uplink connection looked up and its state read, it brought up, or
# NetworkManager restarted, then the wait for the default route and its last
# read; then the address read for the message. Setup gives a stopped step this
# long (common-steps.sh), the updater gives setup this and its own reaction
# (wisp-updater).
_call=$(( NET_CMD_SEC + NET_KILL_SEC ))
_apply=$(( NET_APPLY_SEC + NET_KILL_SEC ))
BRIDGE_STOP_SEC=$(( _apply + (4 * _call + _apply + (60 + NET_KILL_SEC) + NET_APPLY_SEC + _call) + _call ))
unset _call _apply

# journal_root_ok <path>: whether the step may record (and change) <path>.
journal_root_ok() {
  local r
  [[ "$1" != *..* && "$1" != *//* ]] || return 1
  for r in "${JOURNAL_ROOTS[@]}"; do
    [[ "$1" =~ ^$r/[^/]+(/[^/]+)?$ ]] && return 0
  done
  return 1
}

_sha() { [[ -e "$1" ]] && sha256sum "$1" | cut -d' ' -f1 || echo -; }
# _journal_add <entry>: appended and synced. A line an earlier write left cut
# short is taken off first, so the entry starts a line of its own.
_journal_add() {
  local f="$JOURNAL_DIR/journal" keep
  if [[ -s "$f" && "$(tail -c 1 "$f" | od -An -c | tr -d ' ')" != '\n' ]]; then
    keep=$(( $(wc -c < "$f") - $(tail -n 1 "$f" | wc -c) ))
    truncate -s "$keep" "$f" || return 1
  fi
  printf '%s\n' "$1" >> "$f" && sync "$f"
}

# journal_begin <net-tool> <uplink> <bridge> <uplink-addr> <uplink-connection or ->
journal_begin() {
  [[ ! -e "$JOURNAL_DIR" ]] || return 1
  mkdir -p "$JOURNAL_DIR/files" && chmod 700 "$JOURNAL_DIR" && sync "$(dirname "$JOURNAL_DIR")" \
    && _journal_add "host"$'\t'"$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"$'\t'"${5:--}"
}
# journal_file <path> <file it will hold, or - when it is removed>: before the
# step changes <path>.
journal_file() {
  local n
  journal_root_ok "$1" || return 1
  # Its line number: the complete lines so far, and this one (a line cut short
  # is taken off as this entry is added).
  n="$(( $(wc -l < "$JOURNAL_DIR/journal") + 1 ))" || return 1
  if [[ -e "$1" ]]; then
    cp -a "$1" "$JOURNAL_DIR/files/$n" && sync "$JOURNAL_DIR/files/$n" \
      && _journal_add "file"$'\t'"$1"$'\t'yes$'\t'"$(_sha "$1")"$'\t'"$(_sha "$2")"
  else
    _journal_add "file"$'\t'"$1"$'\t'no$'\t'-$'\t'"$(_sha "$2")"
  fi
}
# journal_dir <path>: before the step makes it (and only when it does not exist).
journal_dir() {
  journal_root_ok "$1" || return 1
  [[ -d "$1" ]] || { _journal_add "dir"$'\t'"$1" && mkdir -p "$1"; }
}
journal_connrm() { _journal_add "connrm"$'\t'"$1"; }
# journal_undo_mark: before an undo begins. A failed write does not stop the
# undo: it only leaves the next run to decide without it.
journal_undo_mark() { [[ -d "$JOURNAL_DIR" ]] && _journal_add undo; }

# _journal_read: the journal's entries into arrays. A last line cut short is
# dropped; an empty or missing journal reads as no entries (J_TOOL empty).
# Fails, naming the line, on anything else it does not expect.
_journal_read() {
  J_TOOL="" J_UPLINK="" J_BRIDGE="" J_ADDR="" J_CON="" J_UNDO=no J_BAD=""
  J_FILES=() J_EXISTED=() J_ORIG=() J_WROTE=() J_LINES=() J_DIRS=() J_CONNRM=()
  local f="$JOURNAL_DIR/journal" n=0 total kind a b c d e line
  [[ -s "$f" ]] || return 0
  total="$(grep -c '' "$f")"
  # A last line without its newline was cut short: its change never happened.
  [[ "$(tail -c 1 "$f" | od -An -c | tr -d ' ')" == '\n' ]] || total=$(( total - 1 ))
  while (( n < total )) && IFS= read -r line; do
    n=$((n + 1))
    IFS=$'\t' read -r kind a b c d e <<<"$line"
    case "$kind" in
      host)
        [[ $n -eq 1 && "$a" =~ ^(netplan|networkd|networkmanager)$ && "$b" =~ ^[A-Za-z0-9._-]+$ && "$c" =~ ^[A-Za-z0-9._-]+$ ]] || { J_BAD="line $n"; return 1; }
        J_TOOL="$a" J_UPLINK="$b" J_BRIDGE="$c" J_ADDR="$d" J_CON="$e" ;;
      file)
        [[ -n "$J_TOOL" ]] && journal_root_ok "$a" && [[ "$b" =~ ^(yes|no)$ && "$c" =~ ^([0-9a-f]{64}|-)$ && "$d" =~ ^([0-9a-f]{64}|-)$ ]] || { J_BAD="line $n"; return 1; }
        J_FILES+=("$a") J_EXISTED+=("$b") J_ORIG+=("$c") J_WROTE+=("$d") J_LINES+=("$n") ;;
      dir) [[ -n "$J_TOOL" ]] && journal_root_ok "$a" || { J_BAD="line $n"; return 1; }; J_DIRS+=("$a") ;;
      connrm) [[ -n "$J_TOOL" && "$a" =~ ^[0-9a-f-]{36}$ ]] || { J_BAD="line $n"; return 1; }; J_CONNRM+=("$a") ;;
      undo) [[ -n "$J_TOOL" ]] || { J_BAD="line $n"; return 1; }; J_UNDO=yes ;;
      *) J_BAD="line $n"; return 1 ;;
    esac
  done < "$f"
}

# journal_classify: prints one of
#   finished           every entry is as the step wrote it, the uplink is the bridge's
#                      port, and (NetworkManager) the step reached its last change
#   untouched          nothing the step recorded is changed (or nothing was recorded)
#   restore            caught half way, or in its undo
#   changed <paths>    changed since by someone else
#   bad <why>          not a journal setup wrote
#   fail <why>         the host could not be read
journal_classify() {
  _journal_read || { echo "bad $JOURNAL_DIR/journal is not a journal setup wrote (at its ${J_BAD:-start})"; return; }
  [[ -n "$J_TOOL" ]] || { echo untouched; return; }
  local i cur w=0 o=0 n=0 why="" uuid _has master
  for i in "${!J_FILES[@]}"; do
    cur="$(_sha "${J_FILES[$i]}")"
    if [[ "$cur" == "${J_WROTE[$i]}" ]]; then w=$((w + 1))
    elif [[ "$cur" == "${J_ORIG[$i]}" ]]; then o=$((o + 1))
    else n=$((n + 1)); why+=" ${J_FILES[$i]}"
    fi
  done
  for uuid in "${J_CONNRM[@]}"; do
    _has=0; nm_has "$uuid" || _has=$?
    case $_has in
      0) o=$((o + 1)) ;;
      1) w=$((w + 1)) ;;
      *) echo "fail NetworkManager cannot be asked about the connection $uuid"; return ;;
    esac
  done
  if (( n > 0 )); then echo "changed$why"; return; fi
  if [[ "$J_UNDO" == yes ]]; then echo restore; return; fi
  local total=$(( ${#J_FILES[@]} + ${#J_CONNRM[@]} ))
  master="$(basename "$(readlink "/sys/class/net/$J_UPLINK/master" 2>/dev/null)" 2>/dev/null || true)"
  if (( o == total )); then echo untouched
  # On NetworkManager the step's last change, made only once its check passed,
  # is deleting the uplink's former connection: without it, not finished.
  elif (( w == total )) && [[ "$master" == "$J_BRIDGE" ]] \
    && [[ "$J_TOOL" != networkmanager || ${#J_CONNRM[@]} -gt 0 ]]; then echo finished
  else echo restore
  fi
}

# journal_drop: an untouched journal goes, with the directories it made.
journal_drop() {
  local i
  _journal_read || return 1
  for (( i = ${#J_DIRS[@]} - 1; i >= 0; i-- )); do rmdir "${J_DIRS[$i]}" 2>/dev/null; done
  rm -rf "$JOURNAL_DIR"
}

# journal_restore: the host back as it was, in reverse of the apply, stopping
# at the first part that fails (the rest stays as the step wrote it); then the
# tool applies it, and the uplink's default route comes back. Marks the journal
# first, so an undo cut short is undone again. Drops the journal when every part
# succeeded; otherwise keeps it and returns non-zero.
journal_restore() (
  set +e
  _journal_read || exit 1
  journal_undo_mark
  local i copy _has state nm_files=no netplan_nm=no
  for (( i = ${#J_FILES[@]} - 1; i >= 0; i-- )); do
    if [[ "${J_EXISTED[$i]}" == yes ]]; then
      copy="$JOURNAL_DIR/files/${J_LINES[$i]}"
      [[ "$(_sha "${J_FILES[$i]}")" == "${J_ORIG[$i]}" ]] || install_file "${J_FILES[$i]}" "$copy" "$(stat -c %a "$copy")" || exit 1
    else
      remove_file "${J_FILES[$i]}" || exit 1
    fi
    case "${J_FILES[$i]}" in
      /etc/NetworkManager/*) nm_files=yes ;;
      /etc/netplan/90-NM-*) nm_files=yes netplan_nm=yes ;;
    esac
  done
  for (( i = ${#J_DIRS[@]} - 1; i >= 0; i-- )); do rmdir "${J_DIRS[$i]}" 2>/dev/null; done
  case "$J_TOOL" in
    netplan)
      [[ ! -e "/sys/class/net/$J_BRIDGE" ]] || timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ip link delete "$J_BRIDGE"
      timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" netplan apply || exit 1
      ;;
    networkd)
      [[ ! -e "/sys/class/net/$J_BRIDGE" ]] || timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" networkctl delete "$J_BRIDGE"
      timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" networkctl reload \
        && timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" networkctl reconfigure "$J_UPLINK" || exit 1
      ;;
    networkmanager)
      # The step's connections go with their files, and the uplink's own comes
      # back with its file (netplan's, generated); then it is brought up. When
      # it is gone — NetworkManager's default wired one, held in memory, does
      # not outlive a reboot once a stored connection is for the device — a
      # restart of NetworkManager, with no such connection left, makes it again.
      if [[ "$netplan_nm" == yes ]]; then
        timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" netplan generate || exit 1
      fi
      if [[ "$nm_files" == yes ]]; then
        timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli connection reload || exit 1
      fi
      _has=1
      if [[ "$J_CON" != - ]]; then
        _has=0; nm_has "$J_CON" || _has=$?
        (( _has <= 1 )) || exit 1
      fi
      if (( _has == 0 )); then
        state="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli -g GENERAL.STATE connection show "$J_CON")" || exit 1
        if [[ "$state" != activated ]]; then
          timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" nmcli --wait "$NET_APPLY_SEC" connection up "$J_CON" >/dev/null || exit 1
        fi
      else
        timeout -k "$NET_KILL_SEC" 60 systemctl restart NetworkManager || exit 1
      fi
      ;;
  esac
  local deadline=$(( SECONDS + NET_APPLY_SEC ))
  until [[ "$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ip -4 route show default dev "$J_UPLINK" 2>/dev/null)" == default* ]]; do
    (( SECONDS < deadline )) || exit 1
    sleep 1
  done
  rm -rf "$JOURNAL_DIR"
)

# journal_commit: the step succeeded. One rename commits it; then the
# operator's originals are kept and the journal goes. Prints what was kept.
journal_commit() {
  mv -T "$JOURNAL_DIR" "$JOURNAL_DIR.done" && sync /var/lib/wisp && journal_cleanup
}
# journal_cleanup: after a commit (this run's or one that died after it).
journal_cleanup() {
  local d="$JOURNAL_DIR.done" kind a b c d2 n=0 kept=0
  [[ -d "$d" ]] || return 0
  mkdir -p "$KEPT_DIR" && chmod 700 "$KEPT_DIR"
  while IFS=$'\t' read -r kind a b c d2; do
    n=$((n + 1))
    [[ "$kind" == file && "$b" == yes && -f "$d/files/$n" ]] || continue
    cp -a "$d/files/$n" "$KEPT_DIR/$(printf '%s' "${a#/}" | tr '/' '%')" && kept=$((kept + 1))
  done < "$d/journal"
  rm -rf "$d"
  (( kept == 0 )) || echo "  The original network files are kept in $KEPT_DIR."
}
