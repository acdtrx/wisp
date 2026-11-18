# Sourced by the bridge step and network-plan.sh, as root; do not execute it.
# The bridge step's journal: what it changes, written before each change, so
# the change can be undone — by the step itself when its apply or the check
# after it fails or it is stopped, or by a later run when the step died. A
# later run reads it first and decides from what the host holds now, changing
# nothing while it decides (journal_classify): an earlier run that in fact
# finished is committed, one that changed nothing is dropped, one caught half
# way is undone, and one whose files or connections were changed since by
# someone else is refused. The journal is data: read, never sourced.
#
# One entry per line, tab-separated, in the order of the apply:
#   host <net-tool> <uplink> <bridge> <uplink IPv4 address> <uplink connection or ->
#   file <path> <existed: yes|no> <sha256 of the original or -> <sha256 of what the step writes>
#        (its original, when it existed, kept as files/<n>, n its line number)
#   dir  <path>                     a directory the step made
#   conn <uuid>                     a NetworkManager connection the step adds
#   connfp <uuid> <fingerprint>     what it was added as
# A success commits by one rename of the directory; the operator's original
# files then go to KEPT_DIR, named by their path.

# Uses net-state.sh's bounds (NET_CMD_SEC, NET_APPLY_SEC, NET_KILL_SEC).
# shellcheck source=install-file.sh
source "$(dirname "${BASH_SOURCE[0]}")/install-file.sh"

JOURNAL_DIR=/var/lib/wisp/bridge-journal
KEPT_DIR=/var/lib/wisp/network-before-bridge

# How long a stopped bridge step can take to end, worst case, every bound run
# out (a call's bound is its limit and NET_KILL_SEC to die): the apply call in
# flight when the stop comes, which ends first (bridge.sh; the check between
# applies stops at once), then the longest undo, NetworkManager's
# (journal_restore): the uplink connection looked up and its state read, it
# brought up, the step's two connections each looked up and deleted,
# NetworkManager restarted, the wait for the default route and its last read;
# then the address read for the message. Setup gives a stopped step this long
# (common-steps.sh), the updater gives setup this and its own reaction
# (wisp-updater).
_call=$(( NET_CMD_SEC + NET_KILL_SEC ))
_apply=$(( NET_APPLY_SEC + NET_KILL_SEC ))
BRIDGE_STOP_SEC=$(( _apply + (2 * _call + _apply + 2 * 2 * _call + (60 + NET_KILL_SEC) + NET_APPLY_SEC + _call) + _call ))
unset _call _apply

_sha() { [[ -e "$1" ]] && sha256sum "$1" | cut -d' ' -f1 || echo -; }
_journal_add() {
  printf '%s\n' "$1" >> "$JOURNAL_DIR/journal" && sync "$JOURNAL_DIR/journal"
}

# journal_begin <net-tool> <uplink> <bridge> <uplink-addr> <uplink-connection or ->
journal_begin() {
  [[ ! -e "$JOURNAL_DIR" ]] || return 1
  mkdir -p "$JOURNAL_DIR/files" && chmod 700 "$JOURNAL_DIR" \
    && _journal_add "host"$'\t'"$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"$'\t'"${5:--}"
}
# journal_file <path> <file it will hold>: before the step changes <path>.
journal_file() {
  local n
  n="$(( $(wc -l < "$JOURNAL_DIR/journal") + 1 ))" || return 1
  if [[ -e "$1" ]]; then
    cp -a "$1" "$JOURNAL_DIR/files/$n" && sync "$JOURNAL_DIR/files/$n" \
      && _journal_add "file"$'\t'"$1"$'\t'yes$'\t'"$(_sha "$1")"$'\t'"$(_sha "$2")"
  else
    _journal_add "file"$'\t'"$1"$'\t'no$'\t'-$'\t'"$(_sha "$2")"
  fi
}
# journal_dir <path>: before the step makes it (and only when it does not exist).
journal_dir() { [[ -d "$1" ]] || { _journal_add "dir"$'\t'"$1" && mkdir -p "$1"; }; }
journal_conn() { _journal_add "conn"$'\t'"$1"; }
journal_connfp() { _journal_add "connfp"$'\t'"$1"$'\t'"$2"; }

# nm_fingerprint <uuid>: what setup added a connection as; fails when
# NetworkManager cannot be read.
nm_fingerprint() {
  local out
  out="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli -t -f connection.type,connection.interface-name,connection.controller,ipv4.method,ipv4.addresses,bridge.mac-address \
    connection show "$1")" || return 1
  sha256sum <<<"$out" | cut -c1-16
}

# _journal_read: the journal's entries into arrays, checked; fails on anything
# it does not expect.
_journal_read() {
  J_TOOL="" J_UPLINK="" J_BRIDGE="" J_ADDR="" J_CON=""
  J_FILES=() J_EXISTED=() J_ORIG=() J_WROTE=() J_LINES=() J_DIRS=() J_CONNS=()
  declare -gA J_FP=()
  local n=0 kind a b c d e
  while IFS=$'\t' read -r kind a b c d e; do
    n=$((n + 1))
    case "$kind" in
      host)
        [[ "$a" =~ ^(netplan|networkd|networkmanager)$ && "$b" =~ ^[A-Za-z0-9._-]+$ && "$c" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
        J_TOOL="$a" J_UPLINK="$b" J_BRIDGE="$c" J_ADDR="$d" J_CON="$e" ;;
      file)
        [[ "$a" =~ ^/etc/(netplan|systemd/network)/[^/]+(/[^/]+)?$ && "$a" != *..* && "$b" =~ ^(yes|no)$ ]] || return 1
        J_FILES+=("$a") J_EXISTED+=("$b") J_ORIG+=("$c") J_WROTE+=("$d") J_LINES+=("$n") ;;
      dir)
        [[ "$a" =~ ^/etc/systemd/network/[^/]+\.d$ ]] || return 1
        J_DIRS+=("$a") ;;
      conn) [[ "$a" =~ ^[0-9a-f-]{36}$ ]] || return 1; J_CONNS+=("$a") ;;
      connfp) [[ "$a" =~ ^[0-9a-f-]{36}$ ]] || return 1; J_FP[$a]="$b" ;;
      *) return 1 ;;
    esac
  done < "$JOURNAL_DIR/journal"
  [[ -n "$J_TOOL" ]]
}

# journal_classify: prints finished | untouched | restore | refuse <why> |
# fail <why> (the host could not be read).
journal_classify() {
  _journal_read || { echo "refuse $JOURNAL_DIR/journal is not a journal setup wrote"; return; }
  local i cur w=0 o=0 n=0 why="" uuid fp _has
  for i in "${!J_FILES[@]}"; do
    cur="$(_sha "${J_FILES[$i]}")"
    if [[ "$cur" == "${J_WROTE[$i]}" ]]; then w=$((w + 1))
    elif [[ "${J_EXISTED[$i]}" == yes && "$cur" == "${J_ORIG[$i]}" ]] || [[ "${J_EXISTED[$i]}" == no && "$cur" == - ]]; then o=$((o + 1))
    else n=$((n + 1)); why+=" ${J_FILES[$i]}"
    fi
  done
  for uuid in "${J_CONNS[@]}"; do
    _has=0; nm_has "$uuid" || _has=$?
    case $_has in
      0) ;;
      1) o=$((o + 1)); continue ;;
      *) echo "fail NetworkManager cannot be asked about the connection $uuid"; return ;;
    esac
    fp="$(nm_fingerprint "$uuid")" || { echo "fail NetworkManager cannot be asked about the connection $uuid"; return; }
    if [[ -n "${J_FP[$uuid]:-}" && "$fp" != "${J_FP[$uuid]}" ]]; then n=$((n + 1)); why+=" connection $uuid"; continue; fi
    w=$((w + 1))
  done
  if (( n > 0 )); then echo "refuse changed since by someone else:$why"; return; fi
  local total=$(( ${#J_FILES[@]} + ${#J_CONNS[@]} ))
  local works=no
  if [[ "$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ip -4 -o addr show dev "$J_BRIDGE" scope global 2>/dev/null)" == *" $J_ADDR "* \
    && "$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" ip -4 route show default dev "$J_BRIDGE" 2>/dev/null)" == default* ]]; then works=yes; fi
  if (( w == total && o == 0 )) && [[ "$works" == yes ]]; then echo finished
  elif (( o == total && w == 0 )); then echo untouched
  else echo restore
  fi
}

# journal_restore: the host back as it was, in reverse of the apply, stopping
# at the first part that fails (the rest stays as the step wrote it); then the
# tool applies it, and the uplink's default route comes back. Drops the
# journal when every part succeeded; otherwise keeps it and returns non-zero.
journal_restore() (
  set +e
  _journal_read || exit 1
  local i uuid copy _has
  if [[ "$J_TOOL" == networkmanager ]]; then
    # The uplink's own connection first, so the device is never without one;
    # then what the step added, by UUID, the port before the bridge. When the
    # uplink's connection is gone — NetworkManager's default wired one, held in
    # memory, does not outlive a reboot once a stored connection is for the
    # device — a restart of NetworkManager, with no such connection left, makes
    # it again.
    local uplink_con=no state
    if [[ "$J_CON" != - ]]; then
      _has=0; nm_has "$J_CON" || _has=$?
      case $_has in 0) uplink_con=yes ;; 1) ;; *) exit 1 ;; esac
    fi
    if [[ "$uplink_con" == yes ]]; then
      state="$(timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli -g GENERAL.STATE connection show "$J_CON")" || exit 1
      if [[ "$state" != activated ]]; then
        timeout -k "$NET_KILL_SEC" "$NET_APPLY_SEC" nmcli --wait "$NET_APPLY_SEC" connection up "$J_CON" >/dev/null || exit 1
      fi
    fi
    for (( i = ${#J_CONNS[@]} - 1; i >= 0; i-- )); do
      uuid="${J_CONNS[$i]}"
      _has=0; nm_has "$uuid" || _has=$?
      case $_has in
        0) timeout -k "$NET_KILL_SEC" "$NET_CMD_SEC" nmcli connection delete "$uuid" >/dev/null || exit 1 ;;
        1) ;;
        *) exit 1 ;;
      esac
    done
    if [[ "$uplink_con" == no ]]; then
      timeout -k "$NET_KILL_SEC" 60 systemctl restart NetworkManager || exit 1
    fi
  fi
  for (( i = ${#J_FILES[@]} - 1; i >= 0; i-- )); do
    if [[ "${J_EXISTED[$i]}" == yes ]]; then
      copy="$JOURNAL_DIR/files/${J_LINES[$i]}"
      [[ "$(_sha "${J_FILES[$i]}")" == "${J_ORIG[$i]}" ]] || install_file "${J_FILES[$i]}" "$copy" "$(stat -c %a "$copy")" || exit 1
    else
      remove_file "${J_FILES[$i]}" || exit 1
    fi
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
