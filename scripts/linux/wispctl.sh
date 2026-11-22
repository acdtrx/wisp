#!/usr/bin/env bash
# wispctl: the operator's commands on an installed Wisp (docs/specs/DEPLOYMENT.md,
# Operating Wisp): the login password, and wisp.service through systemd.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# scripts/linux → project root
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
SETUP_DIR="$SCRIPT_DIR/setup"
SERVICE_UNIT="wisp"

# shellcheck source=setup/service.sh
source "$SETUP_DIR/service.sh"

usage() {
  echo "Usage: $0 password [--force] | svc start|stop|restart|logs"
  echo ""
  echo "  password [--force]          Set config/wisp-password (--force replaces an existing one)"
  echo "  svc start|stop|restart|logs wisp.service through systemd; start and restart wait until Wisp is ready"
}

cmd_password() {
  case "${1:-}" in
    '') bash "$SETUP_DIR/password.sh" "$PROJECT_DIR" ;;
    --force) bash "$SETUP_DIR/password.sh" "$PROJECT_DIR" --force ;;
    *) usage; exit 1 ;;
  esac
}

case "${1:-}" in
  password)
    cmd_password "${2:-}"
    ;;
  svc)
    case "${2:-}" in
      start)
        echo "=== Starting systemd service ==="
        wisp_service start sudo || exit 1
        ;;
      stop)
        echo "=== Stopping systemd service ==="
        sudo systemctl stop "$SERVICE_UNIT"
        echo "  Stopped."
        ;;
      restart)
        echo "=== Restarting systemd service ==="
        wisp_service restart sudo || exit 1
        ;;
      logs)
        sudo journalctl -u "$SERVICE_UNIT" -f
        ;;
      *) usage; exit 1 ;;
    esac
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
