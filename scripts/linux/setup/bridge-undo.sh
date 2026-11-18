# Sourced by the bridge step and network-plan.sh, as root; do not execute it.
# What the bridge step must be able to undo, kept on disk until the step has
# succeeded: a copy of every network file it is about to change (or a note
# that the file did not exist), the NetworkManager connections it adds, and
# what the host was (tool, uplink, bridge). The step undoes from it when the
# apply or the check after it fails, or when it is stopped (TERM, INT); a step
# that dies before either leaves it in place, and the next run's plan undoes
# from it first, so every run starts from the host as it was. Each file comes
# back by a rename, so a failed copy leaves the file as it was and the saved
# copies in place for the next try.
#
# After a success the operator's original files are kept in KEPT_DIR, named by
# their path: the tool rewrites them whole (netplan set drops comments and key
# order).

UNDO_DIR=/var/lib/wisp/bridge-undo
KEPT_DIR=/var/lib/wisp/network-before-bridge

# undo_begin <net-tool> <uplink> <bridge> <uplink-connection or "">
undo_begin() {
  mkdir -p "$UNDO_DIR/files" && chmod 700 "$UNDO_DIR" || return 1
  printf 'NET_TOOL=%q\nUPLINK=%q\nBRIDGE=%q\nUPLINK_CONNECTION=%q\n' "$1" "$2" "$3" "$4" > "$UNDO_DIR/host.env"
  : > "$UNDO_DIR/manifest"
  : > "$UNDO_DIR/connections"
  sync
}

# undo_save <path>: before the step changes <path>.
undo_save() {
  local path="$1" copy
  copy="$UNDO_DIR/files/$(printf '%s' "$path" | tr '/' '%')"
  if [[ -e "$path" ]]; then
    cp -a "$path" "$copy" || return 1
    printf '%s\tsaved\n' "$path" >> "$UNDO_DIR/manifest"
  else
    printf '%s\tabsent\n' "$path" >> "$UNDO_DIR/manifest"
  fi
  sync
}

# undo_connection <name>: a NetworkManager connection the step is adding.
undo_connection() { printf '%s\n' "$1" >> "$UNDO_DIR/connections" && sync; }

# undo_restore: the host back as it was, from UNDO_DIR; removes it when every
# part succeeded. Returns non-zero, keeping UNDO_DIR, when a part failed.
undo_restore() (
  set +e
  # shellcheck source=/dev/null
  source "$UNDO_DIR/host.env" || exit 1
  local apply_sec=90 failed=0 path state copy con
  if [[ "$NET_TOOL" == networkmanager ]]; then
    while IFS= read -r con; do
      [[ -n "$con" ]] || continue
      if timeout 30 nmcli -t -f connection.id connection show "$con" >/dev/null 2>&1; then
        timeout 30 nmcli connection delete "$con" >/dev/null || failed=1
      fi
    done < "$UNDO_DIR/connections"
  fi
  while IFS=$'\t' read -r path state; do
    copy="$UNDO_DIR/files/$(printf '%s' "$path" | tr '/' '%')"
    if [[ "$state" == saved ]]; then
      { cp -a "$copy" "$path.wisp-restore" && mv -f "$path.wisp-restore" "$path"; } \
        || { rm -f "$path.wisp-restore"; failed=1; }
    else
      rm -f "$path" || failed=1
      rmdir "$(dirname "$path")" 2>/dev/null
    fi
  done < "$UNDO_DIR/manifest"
  case "$NET_TOOL" in
    netplan)
      [[ ! -e "/sys/class/net/$BRIDGE" ]] || ip link delete "$BRIDGE"
      timeout "$apply_sec" netplan apply || failed=1
      ;;
    networkd)
      [[ ! -e "/sys/class/net/$BRIDGE" ]] || timeout 30 networkctl delete "$BRIDGE"
      timeout 30 networkctl reload || failed=1
      timeout 30 networkctl reconfigure "$UPLINK" || failed=1
      ;;
    networkmanager)
      # Where NetworkManager keeps its connections in netplan, netplan renders them.
      if [[ -d /etc/netplan ]] && command -v netplan >/dev/null; then timeout 30 netplan generate || failed=1; fi
      timeout 30 nmcli connection reload || failed=1
      if [[ "$(timeout 30 nmcli -g GENERAL.STATE connection show "$UPLINK_CONNECTION" 2>/dev/null)" != activated ]]; then
        timeout "$apply_sec" nmcli --wait "$apply_sec" connection up "$UPLINK_CONNECTION" >/dev/null || failed=1
      fi
      ;;
  esac
  # The host's network back: its default route again, through the uplink.
  local waited=0
  until [[ "$(timeout 10 ip -4 route show default dev "$UPLINK" 2>/dev/null)" == default* ]]; do
    (( waited++ < apply_sec )) || { failed=1; break; }
    sleep 1
  done
  (( failed == 0 )) || exit 1
  rm -rf "$UNDO_DIR"
)

# undo_done: the step succeeded; the operator's originals go to KEPT_DIR.
undo_done() {
  local path state
  mkdir -p "$KEPT_DIR" && chmod 700 "$KEPT_DIR"
  while IFS=$'\t' read -r path state; do
    [[ "$state" == saved ]] || continue
    cp -a "$UNDO_DIR/files/$(printf '%s' "$path" | tr '/' '%')" "$KEPT_DIR/$(printf '%s' "${path#/}" | tr '/' '%')"
  done < "$UNDO_DIR/manifest"
  rm -rf "$UNDO_DIR"
}
