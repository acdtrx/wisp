# Sourced by the installer and the steps that write its answers; do not execute
# it. One check for each answer an install holds, so the installer asks for
# exactly what the steps would write.

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# has_server_name <install-dir>: config/wisp-config.json names the server.
# A config that is not JSON ends the caller, naming it.
has_server_name() {
  local file="$1/config/wisp-config.json" rc=0
  [[ -f "$file" ]] || return 1
  "${SETUP_PYTHON[@]}" "$(dirname "${BASH_SOURCE[0]}")/install-state.py" server-name "$file" || rc=$?
  (( rc <= 1 )) || exit 1
  return "$rc"
}

# has_password <install-dir>: wisp-password, beside the config file
# (wisp_config_dir), holds a password. A WISP_CONFIG_PATH the backend would
# refuse ends the caller, naming it.
has_password() {
  local dir
  dir="$(wisp_config_dir "$1")" || exit 1
  [[ -s "$dir/wisp-password" ]]
}

# password_ok <password>: one Wisp accepts.
password_ok() {
  [[ "${#1}" -ge 6 && "$1" != changeme ]]
}
PASSWORD_RULE="at least 6 characters, and not 'changeme'"
