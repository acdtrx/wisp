# shellcheck shell=bash
# The shared parts of Wisp's privileged helpers (CODING-RULES §12, Privileged
# helpers). Not a helper: setup installs it beside them, 0644, with no sudoers
# rule, and each helper sources it first, from its own folder:
#   source "${BASH_SOURCE[0]%/*}/wisp-helper-lib.sh"
# so a helper finds it in the repo (its tests) as on the host.
#
# The dialect it holds:
# - an error is one line on stderr, `wisp-<name>: <what failed>`, the last thing
#   printed;
# - the exit code is one of the EX_ codes below, never a command's own: a
#   failure nothing planned for exits EX_FAIL (the ERR trap), so a stray 2 is
#   never read as "not there";
# - a command that can hang runs through `bounded` (or `must`);
# - an argument is checked before anything runs (`match`, `path_under`).
#
# Everything a helper checks with runs in bash itself, bash 3.2 included (the
# tests run on macOS too): a refusal never needs a command.

set -Eeuo pipefail

readonly EX_FAIL=1 EX_NOT_FOUND=2 EX_INVALID=64 EX_BUSY=75
# The limit for a command that answers at once on a healthy host.
readonly QUICK_SEC=10
# What a command that ran past its limit gets to end after TERM, before KILL.
readonly KILL_GRACE_SEC=2

HELPER_NAME="${0##*/}"

# The patterns the helpers share. A network interface: what Linux allows and
# Wisp names (br0, br0-vlan10, eth0), never a leading `-`.
readonly IFACE_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$'
# A container's name, as the API's schema has it (backend/src/lib/validation.js),
# no `..` checked apart.
readonly WORKLOAD_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'

# say <message>: the one error line.
say() {
  local msg="$*"
  msg="${msg//$'\n'/ }"
  printf '%s: %s\n' "$HELPER_NAME" "$msg" >&2
}

# Each prints the error line and ends the helper with its code. Never called in
# a $(…): it would end only that subshell.
refuse() { say "$@"; exit "$EX_INVALID"; }
not_found() { say "$@"; exit "$EX_NOT_FOUND"; }
busy() { say "$@"; exit "$EX_BUSY"; }
fail() { say "$@"; exit "$EX_FAIL"; }

# A command that failed where nothing handles it: one line, EX_FAIL. In a
# subshell ($(…)) it only ends that subshell; the command that ran it fails in
# turn, and says so.
on_unexpected() {
  local rc=$? cmd="$BASH_COMMAND"
  trap - ERR
  (( BASH_SUBSHELL > 0 )) || say "$cmd failed (exit $rc)"
  exit "$EX_FAIL"
}
trap on_unexpected ERR

# match <label> <value> <ERE>: refuses a value its pattern does not take.
match() {
  [[ "$2" =~ $3 ]] || refuse "$1 is not valid: '$2'"
}

# match_name <label> <value>: a workload's name (WORKLOAD_RE, no `..`).
match_name() {
  match "$1" "$2" "$WORKLOAD_RE"
  [[ "$2" != *..* ]] || refuse "$1 is not valid: '$2'"
}

# match_one_of <label> <value> <option>…: refuses a value not in the list.
match_one_of() {
  local label="$1" value="$2" opt
  shift 2
  for opt in "$@"; do
    [[ "$value" == "$opt" ]] && return 0
  done
  refuse "$label must be one of: $* (got '$value')"
}

# canonical_path <label> <path>: refuses a path that is not absolute and
# canonical: no `.`, `..` or empty part, no trailing `/`, no control character.
# What it names is never looked at.
canonical_path() {
  local label="$1" p="$2"
  [[ "$p" == /?* ]] || refuse "$label must be an absolute path: '$p'"
  case "$p" in
    *//* | */./* | */../* | */. | */.. | */ | *[[:cntrl:]]*)
      refuse "$label must be a canonical path (no ., .., // or trailing /): '$p'" ;;
  esac
}

# path_under <label> <path> <root>…: refuses a path unless it is canonical,
# strictly below one of the roots, and no part of it below that root is a
# symbolic link (each part that exists is looked at; the roots are trusted).
path_under() {
  local label="$1" p="$2" root rest part prefix
  shift 2
  canonical_path "$label" "$p"
  for root in "$@"; do
    [[ "$p" == "$root"/?* ]] || continue
    rest="${p#"$root"/}"
    prefix="$root"
    while [[ -n "$rest" ]]; do
      part="${rest%%/*}"
      if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
      prefix="$prefix/$part"
      [[ ! -L "$prefix" ]] || refuse "$label must not pass through a symbolic link: '$prefix'"
    done
    return 0
  done
  refuse "$label must be under $*: '$p'"
}

# invoking_user: INVOKER_UID and INVOKER_GID, the user sudo ran the helper for.
invoking_user() {
  [[ "${SUDO_UID:-}" =~ ^[0-9]+$ && "${SUDO_GID:-}" =~ ^[0-9]+$ ]] \
    || fail "run it through sudo: SUDO_UID and SUDO_GID are not set"
  INVOKER_UID="$SUDO_UID"
  INVOKER_GID="$SUDO_GID"
}

# bounded <seconds> <command>…: the command under a limit: TERM at it, KILL
# KILL_GRACE_SEC later. A signal sent to sudo ends the helper, not its child,
# so the limit is the helper's own. The command's stdout passes through; its
# stderr is kept, on one line, in BOUNDED_ERR. Returns its status, 124 when the
# limit ended it.
BOUNDED_ERR=""
bounded() {
  local secs="$1" rc=0
  shift
  # The substitution's status is the command's: the ERR trap, which -E hands
  # to the subshell, is cleared there first, or bash 3.2 runs it and exits 1
  # whatever the command returned (bash 5 does not).
  { BOUNDED_ERR="$(trap - ERR; timeout --kill-after="$KILL_GRACE_SEC" "$secs" "$@" 2>&1 >&3 3>&-)"; } 3>&1 || rc=$?
  BOUNDED_ERR="${BOUNDED_ERR//$'\n'/; }"
  BOUNDED_ERR="${BOUNDED_ERR:0:400}"
  (( rc == 137 )) && rc=124
  return "$rc"
}

# capture <seconds> <command>…: bounded, its stdout kept in CAPTURED (trailing
# newlines dropped) rather than passed through. Called where `set -e` does not
# hold (`capture … || rc=$?`), so its own step says when it fails. A helper
# killed by a signal leaves the temp file in /tmp.
CAPTURED=""
capture() {
  local out rc=0
  out="$(mktemp -t wisp-helper.XXXXXX)" || fail "cannot create a temp file"
  bounded "$@" > "$out" || rc=$?
  CAPTURED="$(< "$out")"
  rm -f -- "$out"
  return "$rc"
}

# must <seconds> <command>…: bounded, and a failure ends the helper (EX_FAIL),
# saying which command, and what it said or that it ran out of time.
must() {
  local secs="$1" rc=0
  bounded "$@" || rc=$?
  (( rc == 0 )) && return 0
  shift
  (( rc == 124 )) && fail "$1 did not finish within ${secs} s"
  fail "$1 failed (exit $rc)${BOUNDED_ERR:+: $BOUNDED_ERR}"
}
