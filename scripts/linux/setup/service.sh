# shellcheck shell=bash
# Sourced by wispctl, the installer and install-tree.sh; do not execute it.
#
# wisp_service <start|restart> [sudo]: start or restart wisp.service and wait
# until the backend is ready — the unit is Type=notify, so this returns once it
# listens, its state migrations and boot work done — or report the start's own
# log lines and fail when it exits first. Pass `sudo` when not running as root.
wisp_service() {
  local verb="$1" sudo="${2:-}" since
  since="$(date +%s)"
  echo "  Waiting for the backend to be ready (it runs pending state migrations first)..."
  if ! $sudo systemctl "$verb" wisp; then
    echo "ERROR: wisp.service did not start. Its log since this $verb:" >&2
    $sudo journalctl --sync 2>/dev/null || true
    $sudo journalctl -u wisp --since "@$since" -n 30 --no-pager -o cat >&2 || true
    return 1
  fi
  echo "  Ready."
}

# wisp_service_installed: whether this host has wisp.service (an install over a
# running install stops it first; a first install has none).
wisp_service_installed() {
  [[ "$(systemctl show -p LoadState --value wisp 2>/dev/null)" == loaded ]]
}
# wisp_service_stop: stopped, within the unit's own stop bound (TimeoutStopSec).
wisp_service_stop() {
  systemctl stop wisp
}
