#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
SCRIPTS_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_ENV="$PROJECT_DIR/config/runtime.env"
SETUP_DIR="$SCRIPT_DIR/setup"

read_env() {
  local key="$1"
  local default="${2:-}"
  local val=""
  if [[ -f "$RUNTIME_ENV" ]]; then
    val="$(grep "^${key}=" "$RUNTIME_ENV" | head -1 | cut -d= -f2- | tr -d '\r')" || true
  fi
  echo "${val:-$default}"
}

normalize_runtime_env() {
  # Bare `return` would inherit [[ ]]'s exit 1 when the file is missing, tripping set -e in set_env_vars.
  [[ -f "$RUNTIME_ENV" ]] || return 0
  sed -i 's/\r$//' "$RUNTIME_ENV" 2>/dev/null || true
}

SERVICE_UNIT="wisp"

set_env_vars() {
  normalize_runtime_env
  WISP_PORT="$(read_env WISP_PORT 8080)"
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

cmd_helpers() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "ERROR: Refreshing helpers is only supported on Linux."
    exit 1
  fi
  echo "=== Refresh privileged helpers (/usr/local/bin) ==="
  echo "Project: $PROJECT_DIR"
  echo "Deploy user: $(whoami)"
  echo ""
  sudo "$SETUP_DIR/install-helpers.sh" "$PROJECT_DIR" "$(whoami)"
  echo ""
  echo "=== Helpers refreshed ==="
}

cmd_build() {
  local prebuilt=0
  for arg in "$@"; do
    case "$arg" in
      --prebuilt) prebuilt=1 ;;
      *) echo "ERROR: unknown build flag: $arg"; exit 1 ;;
    esac
  done
  # Auto-detect: a release tarball ships frontend/dist already built. Skip
  # frontend npm install + build in that case (it's the slow part of an update).
  if [[ "$prebuilt" -eq 0 && -f "$PROJECT_DIR/frontend/dist/index.html" && ! -d "$PROJECT_DIR/frontend/src" ]]; then
    prebuilt=1
  fi

  echo "=== Wisp Build ==="
  echo "Project: $PROJECT_DIR"
  if [[ "$prebuilt" -eq 1 ]]; then
    echo "Mode:    prebuilt (frontend dist already present — skipping frontend build)"
  fi
  echo ""
  if [[ -f "$RUNTIME_ENV" ]]; then
    echo "--- config/runtime.env (optional) ---"
    echo "  Using $RUNTIME_ENV for overrides"
  else
    echo "--- config/runtime.env ---"
    echo "  Not present (using built-in defaults for ports)"
  fi

  echo ""
  echo "--- Installing backend ---"
  cd "$PROJECT_DIR/backend"
  npm ci --omit=dev --omit=optional
  echo "  Backend deps installed"

  if [[ "$prebuilt" -eq 0 ]]; then
    echo ""
    echo "--- Vendor noVNC (core + pako) ---"
    bash "$SCRIPTS_ROOT/vendor-novnc.sh" "$PROJECT_DIR/frontend/public/vendor/novnc"

    echo ""
    echo "--- Building frontend ---"
    cd "$PROJECT_DIR/frontend"
    npm install
    npm run build
    echo "  Frontend built"
  else
    echo ""
    echo "--- Frontend ---"
    echo "  Skipped (using prebuilt $PROJECT_DIR/frontend/dist)"
  fi

  echo ""
  echo "=== Build complete ==="
  echo ""
  echo "Run the app:"
  echo "  Local:  $0 local start"
  echo "  Daemon: $0 svc install && $0 svc start"
  echo ""
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

cmd_svc_install() {
  set_env_vars
  echo "=== Installing systemd unit ==="
  local wisp_user
  wisp_user="$(whoami)"
  sed -e "s|WISP_USER|$wisp_user|g" \
      -e "s|WISP_PATH|$PROJECT_DIR|g" \
    "$PROJECT_DIR/systemd/linux/${SERVICE_UNIT}.service" | sudo tee "/etc/systemd/system/${SERVICE_UNIT}.service" > /dev/null
  echo "  Installed ${SERVICE_UNIT}.service"
  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_UNIT"
  echo "  Enabled. Run: $0 svc start"
}

cmd_svc_uninstall() {
  echo "=== Uninstalling systemd unit ==="
  sudo systemctl stop "$SERVICE_UNIT" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_UNIT" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${SERVICE_UNIT}.service"
  sudo systemctl daemon-reload
  echo "  Uninstalled."
}

cmd_svc_start() {
  echo "=== Starting systemd service ==="
  sudo systemctl start "$SERVICE_UNIT"
  echo "  Started."
}

cmd_svc_stop() {
  echo "=== Stopping systemd service ==="
  sudo systemctl stop "$SERVICE_UNIT"
  echo "  Stopped."
}

cmd_svc_restart() {
  echo "=== Restarting systemd service ==="
  sudo systemctl restart "$SERVICE_UNIT"
  echo "  Restarted."
}

cmd_svc_logs() {
  sudo journalctl -u "$SERVICE_UNIT" -f
}

case "${1:-help}" in
  helpers) cmd_helpers ;;
  build)
    shift
    cmd_build "$@"
    ;;
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
      install)   cmd_svc_install ;;
      uninstall) cmd_svc_uninstall ;;
      start)     cmd_svc_start ;;
      stop)      cmd_svc_stop ;;
      restart)   cmd_svc_restart ;;
      logs)      cmd_svc_logs ;;
      *)
        echo "Usage: $0 svc {install|uninstall|start|stop|restart|logs}"
        exit 1
        ;;
    esac
    ;;
  help|*)
    echo "Usage: $0 {helpers|build|password|local|svc}"
    echo ""
    echo "  helpers               sudo: copy wisp-* scripts to /usr/local/bin (run after upgrade)"
    echo "  build [--prebuilt]    Install deps, vendor noVNC, build frontend (skip frontend build with --prebuilt)"
    echo "  password [--force]    Set or reset config/wisp-password"
    echo "  local start|stop|restart|status|logs|tail"
    echo "  svc install|uninstall|start|stop|restart|logs"
    ;;
esac
