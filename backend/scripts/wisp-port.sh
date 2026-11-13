# Sourced, not run: `wisp_port <runtime.env path>` prints the port wisp.service
# listens on — WISP_PORT read as the backend reads it (backend/src/lib/
# loadRuntimeEnv.js): each line trimmed, quotes optional, an empty value or no
# line means the default 8080, otherwise digits 1–65535. Anything else (or the
# key set twice) prints an error to stderr and returns 1, since the backend
# would refuse to start on it. Shared by scripts/linux/wispctl.sh,
# scripts/linux/install.sh and wisp-updater.
wisp_port() {
  local env_file="$1" line value="" found=0
  if [[ -f "$env_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      line="${line#"${line%%[![:space:]]*}"}"
      line="${line%"${line##*[![:space:]]}"}"
      [[ "$line" == WISP_PORT=* ]] || continue
      if (( found )); then
        echo "error: WISP_PORT is set twice in $env_file" >&2
        return 1
      fi
      found=1
      value="${line#WISP_PORT=}"
    done < "$env_file"
  fi
  if (( ${#value} >= 2 )) && [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  if [[ -z "$value" ]]; then
    echo 8080
  elif [[ "$value" =~ ^[0-9]+$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )); then
    echo "$((10#$value))"
  else
    echo "error: WISP_PORT in $env_file is not a port number (1-65535): $value" >&2
    return 1
  fi
}
