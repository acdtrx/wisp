#!/bin/sh
# Installs the wisp CLI from the Wisp that served this script, for macOS and
# Linux (docs/specs/CLI.md, Getting it):
#   curl -fsSL <url>/api/cli/install.sh | sh
# The Wisp writes its own address into wisp_url as it serves the script. The
# binary goes to ~/.local/bin/wisp, with no root.
set -eu

wisp_url='{{wisp_url}}'
dest_dir="$HOME/.local/bin"
dest="$dest_dir/wisp"

fail() {
  printf 'wisp install: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "no wisp CLI for $(uname -s) here: this script is for macOS and Linux, install.ps1 for Windows" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no wisp CLI for the $(uname -m) processor" ;;
esac
platform="$os-$arch"
command -v curl >/dev/null 2>&1 || fail "curl is needed to download the CLI"

mkdir -p "$dest_dir" || fail "cannot make $dest_dir"
tmp="$(mktemp "$dest_dir/.wisp-install.XXXXXX")" || fail "cannot write in $dest_dir"
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' INT TERM

printf 'Downloading the wisp CLI for %s from %s\n' "$platform" "$wisp_url"
# A download that stops moving (under 1 KiB/s for 30 s) ends rather than waits.
curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 -o "$tmp" "$wisp_url/api/cli/wisp-$platform" \
  || fail "the download from $wisp_url failed"
chmod 0755 "$tmp"
"$tmp" help >/dev/null 2>&1 || fail "the downloaded CLI does not run on this machine"
mv -f "$tmp" "$dest"
printf 'Installed %s\n' "$dest"

case ":$PATH:" in
  *":$dest_dir:"*) ;;
  *)
    printf '\n%s is not on your PATH. Add it in your shell'"'"'s profile:\n' "$dest_dir"
    printf '%s\n' "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
printf '\nNext, sign in with an API token (Host → App Config → API tokens):\n  wisp login %s\n' "$wisp_url"
