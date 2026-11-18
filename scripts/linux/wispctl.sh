#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
RUNTIME_ENV="$PROJECT_DIR/config/runtime.env"
SETUP_DIR="$SCRIPT_DIR/setup"

normalize_runtime_env() {
  # Bare `return` would inherit [[ ]]'s exit 1 when the file is missing, tripping set -e in set_env_vars.
  [[ -f "$RUNTIME_ENV" ]] || return 0
  sed -i 's/\r$//' "$RUNTIME_ENV" 2>/dev/null || true
}

SERVICE_UNIT="wisp"

# shellcheck source=../../backend/scripts/wisp-port.sh
source "$PROJECT_DIR/backend/scripts/wisp-port.sh"

set_env_vars() {
  normalize_runtime_env
  WISP_PORT="$(wisp_port "$RUNTIME_ENV")" || exit 1
}

PID_DIR="$PROJECT_DIR/.pids"
LOG_DIR="$PROJECT_DIR/.logs"
mkdir -p "$PID_DIR" "$LOG_DIR"
WISP_PID="$PID_DIR/wisp.pid"
WISP_LOG="$LOG_DIR/wisp.log"

is_running() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

cmd_password() {
  if [[ "${1:-}" == "--force" ]]; then
    bash "$SETUP_DIR/password.sh" "$PROJECT_DIR" --force
  else
    bash "$SETUP_DIR/password.sh" "$PROJECT_DIR"
  fi
}

cmd_start() {
  set_env_vars
  echo "=== Starting Wisp (local) ==="

  if is_running "$WISP_PID"; then
    echo "  Wisp already running (pid $(cat "$WISP_PID"))"
  else
    echo "  Starting wisp on port $WISP_PORT..."
    cd "$PROJECT_DIR/backend"
    nohup node src/index.js >> "$WISP_LOG" 2>&1 &
    echo "$!" > "$WISP_PID"
    echo "  Wisp started (pid $!)"
  fi

  sleep 1
  cmd_status
}

cmd_stop() {
  echo "=== Stopping Wisp (local) ==="
  if is_running "$WISP_PID"; then
    local pid
    pid="$(cat "$WISP_PID")"
    kill "$pid" 2>/dev/null
    echo "  Stopped wisp (pid $pid)"
  else
    echo "  wisp not running"
  fi
  rm -f "$WISP_PID"
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  echo "=== Wisp status (local) ==="
  if is_running "$WISP_PID"; then
    echo "  wisp: running (pid $(cat "$WISP_PID"))"
  else
    echo "  wisp: stopped"
    rm -f "$WISP_PID"
  fi
}

cmd_logs() {
  tail -f "$WISP_LOG"
}

cmd_tail() {
  local lines="${1:-40}"
  echo "=== Last $lines lines ==="
  tail -n "$lines" "$WISP_LOG" 2>/dev/null || echo "  (no logs yet)"
}

cmd_svc_uninstall() {
  echo "=== Uninstalling systemd unit ==="
  sudo systemctl stop "$SERVICE_UNIT" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_UNIT" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${SERVICE_UNIT}.service"
  sudo systemctl daemon-reload
  echo "  Uninstalled."
}

# svc_run <verb>: start or restart wisp.service. The unit is Type=notify, so
# this waits until the backend is ready (its state migrations run, listening)
# and fails when it exits first: the service's last log lines then say why.
svc_run() {
  if ! sudo systemctl "$1" "$SERVICE_UNIT"; then
    echo "ERROR: wisp.service did not start. Its last log lines:" >&2
    sudo journalctl -u "$SERVICE_UNIT" -n 30 --no-pager -o cat >&2 || true
    exit 1
  fi
}

cmd_svc_start() {
  echo "=== Starting systemd service ==="
  svc_run start
  echo "  Started and ready."
}

cmd_svc_stop() {
  echo "=== Stopping systemd service ==="
  sudo systemctl stop "$SERVICE_UNIT"
  echo "  Stopped."
}

cmd_svc_restart() {
  echo "=== Restarting systemd service ==="
  svc_run restart
  echo "  Restarted and ready."
}

cmd_svc_logs() {
  sudo journalctl -u "$SERVICE_UNIT" -f
}

case "${1:-help}" in
  password)
    cmd_password "${2:-}"
    ;;
  local)
    case "${2:-}" in
      start)   cmd_start ;;
      stop)    cmd_stop ;;
      restart) cmd_restart ;;
      status)  cmd_status ;;
      logs)    cmd_logs ;;
      tail)    cmd_tail "${3:-40}" ;;
      *)
        echo "Usage: $0 local {start|stop|restart|status|logs|tail}"
        exit 1
        ;;
    esac
    ;;
  svc)
    case "${2:-}" in
      uninstall) cmd_svc_uninstall ;;
      start)     cmd_svc_start ;;
      stop)      cmd_svc_stop ;;
      restart)   cmd_svc_restart ;;
      logs)      cmd_svc_logs ;;
      *)
        echo "Usage: $0 svc {uninstall|start|stop|restart|logs}"
        exit 1
        ;;
    esac
    ;;
  help|*)
    echo "Usage: $0 {password|local|svc}"
    echo ""
    echo "  password [--force]    Set or reset config/wisp-password"
    echo "  local start|stop|restart|status|logs|tail"
    echo "  svc uninstall|start|stop|restart|logs   (setup renders and enables the unit)"
    ;;
esac
