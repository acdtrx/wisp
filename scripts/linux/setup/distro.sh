# Sourced by setup and its steps; do not execute it. Wisp hosts run Debian or
# Ubuntu (or a derivative that says so in ID_LIKE) with systemd 254 or newer:
# any other host is refused here, before a step changes anything.
# Exports:
#   sys_arch()    — prints GitHub-release arch name (amd64, arm64, arm)

# Setup parses the output of the tools it runs: one locale for all of it.
export LC_ALL=C

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

# systemd 254 or newer (Debian 13, Ubuntu 24.04 and later): wisp.service's
# restart backoff (RestartSteps, RestartMaxDelaySec) needs it. Read from systemd
# itself, not from the distro's release number.
_SYSTEMD="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
_SYSTEMD="${_SYSTEMD%%[!0-9]*}"
if [[ -z "$_SYSTEMD" ]] || (( _SYSTEMD < 254 )); then
  echo "ERROR: systemd ${_SYSTEMD:-not found} is too old: Wisp hosts need systemd 254 or newer (Debian 13, Ubuntu 24.04 and later)." >&2
  exit 1
fi

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
