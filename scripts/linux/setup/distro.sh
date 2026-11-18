# Sourced by setup and its steps; do not execute it. Wisp hosts run Debian or
# Ubuntu (or a derivative that says so in ID_LIKE): any other distro is refused
# here, before a step changes anything.
# Exports:
#   sys_arch()    — prints GitHub-release arch name (amd64, arm64, arm)

_ID=""
_ID_LIKE=""
if [[ -f /etc/os-release ]]; then
  _ID="$(. /etc/os-release && echo "${ID:-}")"
  _ID_LIKE="$(. /etc/os-release && echo "${ID_LIKE:-}")"
fi
case " ${_ID} ${_ID_LIKE} " in
  *" debian "*|*" ubuntu "*) ;;
  *)
    echo "ERROR: unsupported distro (ID=${_ID:-none}, ID_LIKE=${_ID_LIKE:-none}): Wisp hosts run Debian or Ubuntu." >&2
    exit 1
    ;;
esac

# Map uname -m to GitHub release architecture names (amd64, arm64, arm)
sys_arch() {
  case "$(uname -m)" in
    x86_64)  echo "amd64" ;;
    aarch64) echo "arm64" ;;
    armv7l|armv6l) echo "arm" ;;
    *)
      echo "ERROR: Unsupported architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}
