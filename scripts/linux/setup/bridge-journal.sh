# Sourced by the bridge step, the bridge-journal step and the network plan, as
# root; do not execute it. The bridge step's journal: what it changes, written
# and synced before each change, so the change can be undone — by the step
# itself when its apply or the check after it fails or it is stopped, or by a
# later run when the step died. A later run decides from it first, from what the
# host holds now (journal_classify), in this order:
#   1. changed     a file or connection is neither as it was nor as the step
#                  left it: someone else changed it since. Refused.
#   2. restore     the journal says an undo had begun: undone again.
#   3. untouched   nothing the step recorded is changed: dropped.
#   4. finished    every change of the apply is as the step made it, and the
#                  bridge passes the step's own check now, waited for as in the
#                  step: committed, the step's finish completed first.
#   5. restore     anything else: undone.
#
# The journal directory, JOURNAL_DIR:
#   plan       the plan's record (plan-record.sh), uplink.state, the check's
#              reference, and (NetworkManager) uplink.nmconnection, the
#              generated uplink connection rendered as a stored one — copied
#              in before the first change, as data, never sourced
#   journal    one entry per line, tab-separated, in the order of the step:
#     file <path> <existed: yes|no> <sha256 of the original or -> <sha256 of what the step writes, - for none>
#          (its original, when it existed, kept as files/<n>, n its line number)
#     dir <path>      a directory the step made
#     finish          what follows is the step's finish, made once its check
#                     passed (NetworkManager: the uplink's own connection deleted)
#     connrm <uuid>   the uplink's NetworkManager connection, which the step deletes
#     undo            an undo has begun: the run is undone, whatever it reached
#   kept/      at the commit, the originals, named by their path, before they
#              go to KEPT_DIR whole
# Every path is under one of JOURNAL_ROOTS; the plan refuses a source outside
# them. An entry is synced before its change, so a last line cut short (a power
# loss, a full disk) is a change that never happened, and is dropped. A success
# commits by one rename of the directory; the operator's originals then go to a
# directory of their own under KEPT_DIR, one per commit, by renames only.

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck source=net-state.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-state.sh"
# shellcheck source=plan-record.sh
source "$(dirname "${BASH_SOURCE[0]}")/plan-record.sh"
# shellcheck source=net-uplink.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-uplink.sh"
# shellcheck source=bridge-check.sh
source "$(dirname "${BASH_SOURCE[0]}")/bridge-check.sh"
# Each tool's plan, apply, check, finish and undo.
# shellcheck source=net-netplan.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-netplan.sh"
# shellcheck source=net-networkd.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-networkd.sh"
# shellcheck source=net-networkmanager.sh
source "$(dirname "${BASH_SOURCE[0]}")/net-networkmanager.sh"

JOURNAL_DIR=/var/lib/wisp/bridge-journal
KEPT_DIR=/var/lib/wisp/network-before-bridge
# Where the bridge step may change a file: each tool's own configuration.
JOURNAL_ROOTS=(/etc/netplan /etc/systemd/network /etc/NetworkManager/system-connections)

# journal_root_ok <path>: whether the step may record (and change) <path>.
journal_root_ok() {
  local r
  [[ "$1" != *..* && "$1" != *//* ]] || return 1
  for r in "${JOURNAL_ROOTS[@]}"; do
    [[ "$1" =~ ^$r/[^/]+(/[^/]+)?$ ]] && return 0
  done
  return 1
}

# _sha <path>: its checksum, - when it does not exist.
_sha() {
  local out
  [[ -e "$1" ]] || { echo -; return 0; }
  out="$(sha256sum -- "$1")" || return 1
  echo "${out%% *}"
}
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

# journal_begin <plan-dir>: before the first change. The plan and the check's
# reference go in first, the journal last: a journal directory without its
# journal file recorded no change.
journal_begin() {
  local f
  [[ ! -e "$JOURNAL_DIR" ]] || return 1
  mkdir -p "$KEPT_DIR" && chmod 700 "$KEPT_DIR" || return 1
  mkdir -p "$JOURNAL_DIR/files" "$JOURNAL_DIR/kept" && chmod 700 "$JOURNAL_DIR" || return 1
  for f in plan uplink.state uplink.nmconnection; do
    [[ -e "$1/$f" ]] || continue
    cp "$1/$f" "$JOURNAL_DIR/$f" && sync "$JOURNAL_DIR/$f" || return 1
  done
  sync "$JOURNAL_DIR" "$(dirname "$JOURNAL_DIR")" && : > "$JOURNAL_DIR/journal" && sync "$JOURNAL_DIR/journal" "$JOURNAL_DIR"
}
# journal_file <path> <file it will hold, or - when it is removed>: before the
# step changes <path>.
journal_file() {
  local n orig wrote=-
  journal_root_ok "$1" || return 1
  if [[ "$2" != - ]]; then wrote="$(_sha "$2")" || return 1; fi
  # Its line number: the complete lines so far, and this one (a line cut short
  # is taken off as this entry is added).
  n="$(wc -l < "$JOURNAL_DIR/journal")" || return 1
  n=$(( n + 1 ))
  if [[ -e "$1" ]]; then
    orig="$(_sha "$1")" || return 1
    cp -a "$1" "$JOURNAL_DIR/files/$n" && sync "$JOURNAL_DIR/files/$n" "$JOURNAL_DIR/files" \
      && _journal_add "file"$'\t'"$1"$'\t'yes$'\t'"$orig"$'\t'"$wrote"
  else
    _journal_add "file"$'\t'"$1"$'\t'no$'\t'-$'\t'"$wrote"
  fi
}
# journal_dir <path>: before the step makes it (and only when it does not exist).
journal_dir() {
  journal_root_ok "$1" || return 1
  [[ -d "$1" ]] || { _journal_add "dir"$'\t'"$1" && mkdir -p "$1"; }
}
journal_finish() { _journal_add finish; }
journal_connrm() { _journal_add "connrm"$'\t'"$1"; }
# journal_undo_mark: before an undo begins. A failed write does not stop the
# undo: it only leaves the next run to decide without it.
journal_undo_mark() { [[ -d "$JOURNAL_DIR" ]] && _journal_add undo; }

# _journal_read: the journal's entries into arrays; J_FILE_FINISH[i] and
# J_CONNRM are the finish's. A last line cut short is dropped; a missing
# journal reads as no entries (J_NONE=yes). Fails, naming the line in J_BAD, on
# anything else it does not expect.
_journal_read() {
  J_NONE=no J_UNDO=no J_FINISH=no J_BAD=""
  J_FILES=() J_EXISTED=() J_ORIG=() J_WROTE=() J_LINES=() J_FILE_FINISH=() J_DIRS=() J_CONNRM=()
  local f="$JOURNAL_DIR/journal" n=0 total kind a b c d line
  [[ -e "$f" ]] || { J_NONE=yes; return 0; }
  total="$(grep -c '' "$f")" || total=0
  # A last line without its newline was cut short: its change never happened.
  [[ ! -s "$f" || "$(tail -c 1 "$f" | od -An -c | tr -d ' ')" == '\n' ]] || total=$(( total - 1 ))
  while (( n < total )) && IFS= read -r line; do
    n=$((n + 1))
    IFS=$'\t' read -r kind a b c d <<<"$line"
    case "$kind" in
      file)
        journal_root_ok "$a" && [[ "$b" =~ ^(yes|no)$ && "$c" =~ ^([0-9a-f]{64}|-)$ && "$d" =~ ^([0-9a-f]{64}|-)$ ]] || { J_BAD="line $n"; return 1; }
        J_FILES+=("$a") J_EXISTED+=("$b") J_ORIG+=("$c") J_WROTE+=("$d") J_LINES+=("$n") J_FILE_FINISH+=("$J_FINISH") ;;
      dir) journal_root_ok "$a" && [[ "$J_FINISH" == no ]] || { J_BAD="line $n"; return 1; }; J_DIRS+=("$a") ;;
      finish) [[ "$J_FINISH" == no ]] || { J_BAD="line $n"; return 1; }; J_FINISH=yes ;;
      connrm) [[ "$J_FINISH" == yes && "$a" =~ ^[0-9a-f-]{36}$ ]] || { J_BAD="line $n"; return 1; }; J_CONNRM+=("$a") ;;
      undo) J_UNDO=yes ;;
      *) J_BAD="line $n"; return 1 ;;
    esac
  done < "$f"
}
_journal_has_file() {
  local p
  for p in "${J_FILES[@]}"; do [[ "$p" == "$1" ]] && return 0; done
  return 1
}

# journal_classify: J_CLASS, one of finished, untouched, restore,
# "changed <paths>", "bad <why>" (not a journal setup wrote), "fail <why>" (the
# host could not be read); with the journal's plan read (plan-record.sh), as the
# commit and the undo need it.
journal_classify() {
  J_CLASS=""
  _journal_read || { J_CLASS="bad $JOURNAL_DIR/journal is not a journal setup wrote (at its ${J_BAD:-start})"; return 0; }
  if [[ "$J_NONE" == yes ]]; then J_CLASS=untouched; return 0; fi
  plan_record_read "$JOURNAL_DIR/plan" 2>/dev/null \
    || { J_CLASS="bad $JOURNAL_DIR/plan is not a plan setup wrote"; return 0; }
  local i cur uuid has o=0 n=0 why="" apply=0 apply_w=0
  for i in "${!J_FILES[@]}"; do
    cur="$(_sha "${J_FILES[$i]}")" || { J_CLASS="fail cannot read ${J_FILES[$i]}"; return 0; }
    [[ "${J_FILE_FINISH[$i]}" == yes ]] || apply=$((apply + 1))
    if [[ "$cur" == "${J_WROTE[$i]}" ]]; then
      [[ "${J_FILE_FINISH[$i]}" == yes ]] || apply_w=$((apply_w + 1))
    elif [[ "$cur" == "${J_ORIG[$i]}" ]]; then o=$((o + 1))
    else n=$((n + 1)); why+=" ${J_FILES[$i]}"
    fi
  done
  for uuid in "${J_CONNRM[@]}"; do
    has=0; nm_has "$uuid" || has=$?
    case $has in
      0) o=$((o + 1)) ;;
      1) ;;
      *) J_CLASS="fail NetworkManager cannot be asked about the connection $uuid"; return 0 ;;
    esac
  done
  if (( n > 0 )); then J_CLASS="changed$why"; return 0; fi
  if [[ "$J_UNDO" == yes ]]; then J_CLASS=restore; return 0; fi
  if (( o == ${#J_FILES[@]} + ${#J_CONNRM[@]} )); then J_CLASS=untouched; return 0; fi
  if (( apply > 0 && apply_w == apply )) && bridge_check "$JOURNAL_DIR"; then J_CLASS=finished; return 0; fi
  J_CLASS=restore
}
# journal_refuse_class: a journal setup cannot decide on is refused (or, when
# the host cannot be read, failed), naming what to do.
journal_refuse_class() {
  case "$J_CLASS" in
    fail\ *) refuse JOURNAL_UNREADABLE "${J_CLASS#fail }: setup cannot tell what the bridge step that left its journal in $JOURNAL_DIR changed. Make it answer (for NetworkManager: systemctl status NetworkManager), and run this again." ;;
    bad\ *) refuse JOURNAL_NOT_SETUPS "${J_CLASS#bad }. Put the network as you want it, remove $JOURNAL_DIR (its files/ holds the originals of what the step changed), and run this again." ;;
    changed\ *) refuse JOURNAL_CHANGED "a bridge step that did not finish left its journal in $JOURNAL_DIR, and since then someone else changed${J_CLASS#changed}: setup does not undo over that. Put each back as the step wrote it or as it was (its files/ holds the originals), or remove $JOURNAL_DIR once the network is as you want it, and run this again." ;;
  esac
}

# journal_drop: an untouched journal goes, with the directories it made.
journal_drop() {
  local i
  _journal_read || return 1
  for (( i = ${#J_DIRS[@]} - 1; i >= 0; i-- )); do rmdir "${J_DIRS[$i]}" 2>/dev/null || true; done
  rm -rf "$JOURNAL_DIR"
}

# journal_restore: the host back as it was, in reverse of the step, stopping at
# the first part that fails (the rest stays as the step wrote it); then the tool
# applies it, and the uplink is waited for until it holds what it held before
# (uplink_back). Called inside a section that must finish (step_hold): an undo
# is never cut short by a stop (the session's KILL past setup's bound is the
# end of it). Marks the journal first, so an undo cut short is undone again.
# Drops the journal and returns 0 once the files and connections are back;
# RESTORE_OUTCOME then says what the host holds, as checked. Otherwise keeps
# the journal and returns 1.
journal_restore() {
  local i copy dir nm_files=no netplan_nm=no addr
  RESTORE_STORED="" RESTORE_OUTCOME=""
  _journal_read || return 1
  plan_record_read "$JOURNAL_DIR/plan" || return 1
  journal_undo_mark
  for (( i = ${#J_FILES[@]} - 1; i >= 0; i-- )); do
    if [[ "${J_EXISTED[$i]}" == yes ]]; then
      copy="$JOURNAL_DIR/files/${J_LINES[$i]}"
      if [[ "$(_sha "${J_FILES[$i]}")" != "${J_ORIG[$i]}" ]]; then
        dir="$(dirname "${J_FILES[$i]}")"
        [[ -d "$dir" ]] || mkdir -p "$dir" || return 1
        install_file "${J_FILES[$i]}" "$copy" "$(stat -c %a "$copy")" "$(stat -c %U:%G "$copy")" || return 1
      fi
    else
      remove_file "${J_FILES[$i]}" || return 1
    fi
    case "${J_FILES[$i]}" in
      /etc/NetworkManager/*) nm_files=yes ;;
      /etc/netplan/90-NM-*) nm_files=yes netplan_nm=yes ;;
    esac
  done
  for (( i = ${#J_DIRS[@]} - 1; i >= 0; i-- )); do rmdir "${J_DIRS[$i]}" 2>/dev/null || true; done
  case "$NET_TOOL" in
    netplan) undo_netplan || return 1 ;;
    networkd) undo_networkd || return 1 ;;
    networkmanager) undo_networkmanager "$nm_files" "$netplan_nm" || return 1 ;;
  esac
  RESTORE_OUTCOME="The network's files and connections are back as they were"
  if [[ -n "$RESTORE_STORED" ]]; then
    RESTORE_OUTCOME+=", but for ${UPLINK}'s connection: NetworkManager had generated it, and it is now a stored connection with its settings, $RESTORE_STORED"
  fi
  if uplink_back "$JOURNAL_DIR"; then
    addr="$(awk '$1 == "addr4" && !done { print $2; done = 1 }' <<<"$UPLINK_HOLDS")"
    RESTORE_OUTCOME+="; $UPLINK holds the addresses, routes and name servers it held before${addr:+ ($addr)}"
  else
    RESTORE_OUTCOME+="; but $UPLINK holds [$(echo $UPLINK_HOLDS)] after ${NET_APPLY_SEC} s, where it held [$(echo $UPLINK_HELD)] before"
  fi
  rm -rf "$JOURNAL_DIR" || return 1
}

# journal_commit: the step succeeded. The commit's time recorded, then one
# rename commits it; journal_cleanup then keeps the operator's originals.
journal_commit() {
  date -u +%Y-%m-%dT%H%M%SZ > "$JOURNAL_DIR/committed" && sync "$JOURNAL_DIR/committed" "$JOURNAL_DIR" \
    && mv -T "$JOURNAL_DIR" "$JOURNAL_DIR.done" && sync "$(dirname "$JOURNAL_DIR")"
}
JOURNAL_KEEP_FAILED="the bridge is committed, but its originals could not be kept: they stay in $JOURNAL_DIR.done/files (is /var/lib/wisp full?), and the next run of setup keeps them"
# journal_cleanup: after a commit, this run's or one that died after it. Each
# original moves (a rename: no space needed) to kept/ under its path's name,
# then kept/ to a directory of its own under KEPT_DIR, named by the commit's
# time; the journal goes only once all of that succeeded. A cleanup that fails
# leaves the journal for the next run's to finish, and returns non-zero. Prints
# where the originals are.
journal_cleanup() {
  local d="$JOURNAL_DIR.done" kind a b c e n=0 kept=0 name dest when
  [[ -d "$d" ]] || return 0
  if [[ -d "$d/kept" ]]; then
    while IFS=$'\t' read -r kind a b c e; do
      n=$((n + 1))
      [[ "$kind" == file && "$b" == yes ]] || continue
      name="$(printf '%s' "${a#/}" | tr '/' '%')"
      if [[ -e "$d/files/$n" ]]; then
        mv -T "$d/files/$n" "$d/kept/$name" || return 1
      fi
      [[ -e "$d/kept/$name" ]] && kept=$((kept + 1))
    done < "$d/journal"
    sync "$d/kept" "$d/files" || return 1
    if (( kept > 0 )); then
      when="$(cat "$d/committed")" || return 1
      dest="$KEPT_DIR/$when"
      n=1
      while [[ -e "$dest" ]]; do n=$((n + 1)); dest="$KEPT_DIR/$when-$n"; done
      mv -T "$d/kept" "$dest" && sync "$KEPT_DIR" || return 1
      echo "  The original network files are kept in $dest."
    fi
  fi
  rm -rf "$d"
}

# journal_recover: a bridge step that died left its journal: decided on, from
# what the host holds now, before setup works out anything else (the
# bridge-journal step). Prints what it did. A commit or an undo must finish: a
# stop waits for it (step_hold).
journal_recover() {
  local rc
  if [[ -d "$JOURNAL_DIR.done" ]]; then
    journal_cleanup || net_fail "$JOURNAL_KEEP_FAILED"
  fi
  [[ -d "$JOURNAL_DIR" ]] || return 0
  journal_classify
  journal_refuse_class
  case "$J_CLASS" in
    finished)
      step_hold
      echo "  A bridge step that was not recorded as done had in fact finished: completing and committing it."
      WHY=""
      "finish_$NET_TOOL" || net_fail "${WHY:-its finish failed}; the journal stays in $JOURNAL_DIR for the next run"
      journal_commit || net_fail "$BRIDGE is up, but the journal could not be committed; the next run of setup commits it"
      journal_cleanup || net_fail "$JOURNAL_KEEP_FAILED"
      echo "  $BRIDGE is on $UPLINK, committed."
      step_release ;;
    untouched)
      echo "  A bridge step left a journal but changed nothing: dropping it."
      journal_drop || net_fail "cannot remove $JOURNAL_DIR" ;;
    restore)
      echo "  A bridge step that did not finish left its journal in $JOURNAL_DIR: undoing it."
      step_hold
      journal_restore || net_fail "undoing the earlier bridge step did not complete; its journal stays in $JOURNAL_DIR for the next run (docs/specs/DEPLOYMENT.md, The bridge, says what to do at the console)."
      echo "  $RESTORE_OUTCOME."
      step_release ;;
  esac
  changed "bridge journal: $J_CLASS"
}
