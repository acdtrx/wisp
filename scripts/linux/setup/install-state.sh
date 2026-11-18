# Sourced by the installer and the steps that write its answers; do not execute
# it. One check for each answer an install holds, so the installer asks for
# exactly what the steps would write.

# has_server_name <install-dir>: config/wisp-config.json names the server.
has_server_name() {
  local file="$1/config/wisp-config.json"
  [[ -f "$file" ]] && grep -qE '"serverName"[[:space:]]*:[[:space:]]*"[^"]' "$file"
}

# has_password <install-dir>: config/wisp-password holds a password.
has_password() {
  [[ -s "$1/config/wisp-password" ]]
}

# password_ok <password>: one Wisp accepts.
password_ok() {
  [[ "${#1}" -ge 6 && "$1" != changeme ]]
}
PASSWORD_RULE="at least 6 characters, and not 'changeme'"
