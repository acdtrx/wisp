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

BACKEND_UNIT="wisp-backend"
FRONTEND_UNIT="wisp-frontend"

set_env_vars() {
  normalize_runtime_env
  BACKEND_PORT="$(read_env WISP_BACKEND_PORT 3001)"
  FRONTEND_PORT="$(read_env WISP_FRONTEND_PORT 8080)"
}

PID_DIR="$PROJECT_DIR/.pids"
LOG_DIR="$PROJECT_DIR/.logs"
mkdir -p "$PID_DIR" "$LOG_DIR"
BACKEND_PID="$PID_DIR/backend.pid"
FRONTEND_PID="$PID_DIR/frontend.pid"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

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
  echo "=== Wisp Build ==="
  echo "Project: $PROJECT_DIR"
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

  echo ""
  echo "--- Vendor noVNC (core + pako) ---"
    bash "$SCRIPTS_ROOT/vendor-novnc.sh" "$PROJECT_DIR/frontend/public/vendor/novnc"

  echo ""
  echo "--- Building frontend ---"
  cd "$PROJECT_DIR/frontend"
  npm install
  npm run build
  echo "  Frontend built"

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

  if is_running "$BACKEND_PID"; then
    echo "  Backend already running (pid $(cat "$BACKEND_PID"))"
  else
    echo "  Starting backend on port $BACKEND_PORT..."
    cd "$PROJECT_DIR/backend"
    nohup node src/index.js >> "$BACKEND_LOG" 2>&1 &
    echo "$!" > "$BACKEND_PID"
    echo "  Backend started (pid $!)"
  fi

  if is_running "$FRONTEND_PID"; then
    echo "  Frontend already running (pid $(cat "$FRONTEND_PID"))"
  else
    echo "  Starting frontend on port $FRONTEND_PORT..."
    cd "$PROJECT_DIR/frontend"
    nohup node server.js >> "$FRONTEND_LOG" 2>&1 &
    echo "$!" > "$FRONTEND_PID"
    echo "  Frontend started (pid $!)"
  fi

  sleep 1
  cmd_status
}

cmd_stop() {
  set_env_vars
  echo "=== Stopping Wisp (local) ==="

  for svc in frontend backend; do
    local pidfile="$PID_DIR/${svc}.pid"
    if is_running "$pidfile"; then
      local pid
      pid="$(cat "$pidfile")"
      kill "$pid" 2>/dev/null
      echo "  Stopped $svc (pid $pid)"
    else
      echo "  $svc not running"
    fi
    rm -f "$pidfile"
  done
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  set_env_vars
  echo "=== Wisp status (local) ==="
  for svc in backend frontend; do
    local pidfile="$PID_DIR/${svc}.pid"
    if is_running "$pidfile"; then
      echo "  $svc: running (pid $(cat "$pidfile"))"
    else
      echo "  $svc: stopped"
      rm -f "$pidfile"
    fi
  done
}

cmd_logs() {
  set_env_vars
  local svc="${1:-all}"
  case "$svc" in
    backend)  tail -f "$BACKEND_LOG" ;;
    frontend) tail -f "$FRONTEND_LOG" ;;
    all)      tail -f "$BACKEND_LOG" "$FRONTEND_LOG" ;;
    *)        echo "Usage: $0 local logs [backend|frontend|all]"; exit 1 ;;
  esac
}

cmd_tail() {
  set_env_vars
  local lines="${1:-40}"
  echo "=== Last $lines lines ==="
  echo "--- backend ---"
  tail -n "$lines" "$BACKEND_LOG" 2>/dev/null || echo "  (no logs yet)"
  echo ""
  echo "--- frontend ---"
  tail -n "$lines" "$FRONTEND_LOG" 2>/dev/null || echo "  (no logs yet)"
}

cmd_svc_install() {
  set_env_vars
  echo "=== Installing systemd units ==="
  local wisp_user
  wisp_user="$(whoami)"
  for template in wisp-backend wisp-frontend; do
    sed -e "s|WISP_USER|$wisp_user|g" \
        -e "s|WISP_PATH|$PROJECT_DIR|g" \
      "$PROJECT_DIR/systemd/linux/${template}.service" | sudo tee "/etc/systemd/system/${template}.service" > /dev/null
    echo "  Installed ${template}.service"
  done
  sudo systemctl daemon-reload
  sudo systemctl enable "$BACKEND_UNIT" "$FRONTEND_UNIT"
  echo "  Enabled. Run: $0 svc start"
}

cmd_svc_uninstall() {
  echo "=== Uninstalling systemd units ==="
  sudo systemctl stop "$BACKEND_UNIT" "$FRONTEND_UNIT" 2>/dev/null || true
  sudo systemctl disable "$BACKEND_UNIT" "$FRONTEND_UNIT" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/${BACKEND_UNIT}.service" "/etc/systemd/system/${FRONTEND_UNIT}.service"
  sudo systemctl daemon-reload
  echo "  Uninstalled."
}

cmd_svc_start() {
  echo "=== Starting systemd services ==="
  sudo systemctl start "$BACKEND_UNIT" "$FRONTEND_UNIT"
  echo "  Started."
}

cmd_svc_stop() {
  echo "=== Stopping systemd services ==="
  sudo systemctl stop "$BACKEND_UNIT" "$FRONTEND_UNIT"
  echo "  Stopped."
}

cmd_svc_restart() {
  echo "=== Restarting systemd services ==="
  sudo systemctl restart "$BACKEND_UNIT" "$FRONTEND_UNIT"
  echo "  Restarted."
}

cmd_svc_logs() {
  local which="${1:-all}"
  case "$which" in
    backend)  sudo journalctl -u "$BACKEND_UNIT" -f ;;
    frontend) sudo journalctl -u "$FRONTEND_UNIT" -f ;;
    all)      sudo journalctl -u "$BACKEND_UNIT" -u "$FRONTEND_UNIT" -f ;;
    *)
      echo "Usage: $0 svc logs [backend|frontend|all]"
      exit 1
      ;;
  esac
}

case "${1:-help}" in
  helpers) cmd_helpers ;;
  build)   cmd_build ;;
  password)
    cmd_password "${2:-}"
    ;;
  local)
    case "${2:-}" in
      start)   cmd_start ;;
      stop)    cmd_stop ;;
      restart) cmd_restart ;;
      status)  cmd_status ;;
      logs)    cmd_logs "${3:-all}" ;;
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
      logs)      cmd_svc_logs "${3:-all}" ;;
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
    echo "  build                 Install deps, vendor noVNC, build frontend"
    echo "  password [--force]    Set or reset config/wisp-password"
    echo "  local start|stop|restart|status|logs|tail"
    echo "  svc install|uninstall|start|stop|restart|logs [backend|frontend|all]"
    ;;
esac
