#!/usr/bin/env bash
# Vendor noVNC (core + pako) at its pinned release into the given directory.
# Usage: ./scripts/vendor-novnc.sh <dest_dir>
#   dest_dir = path to .../vendor/novnc (e.g. PROJECT_DIR/frontend/public/vendor/novnc)
#
# The one place the noVNC version is named (docs/specs/noVNC.md). Every build fetches
# through this script: `wispctl build` on hosts, and the frontend's `npm run build`
# (CI, the dev machine). `<dest_dir>/.pinned` records what the tree holds; a tree
# holding anything else is replaced, and a failed fetch fails the build with the
# tree left as it was.
set -euo pipefail

NOVNC_TAG="v1.7.0"
NOVNC_COMMIT="63107bd06d9e1f6136ff21aeda8cd62cbf0d433e"
PIN="${NOVNC_TAG} ${NOVNC_COMMIT}"

DEST="${1:?Usage: $0 <dest_dir>}"
DEST="${DEST%/}"
STAMP="${DEST}/.pinned"

if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$PIN" && -f "$DEST/core/rfb.js" && -d "$DEST/vendor/pako" ]]; then
  echo "  noVNC ${NOVNC_TAG} already present"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
TMP="$(mktemp -d)"
STAGE="${DEST}.staging.$$"
cleanup() { rm -rf "$TMP" "$STAGE"; }
trap cleanup EXIT

fail() {
  echo "ERROR: could not vendor noVNC ${NOVNC_TAG}: $*" >&2
  echo "       ${DEST} is left as it was; fix the cause and build again." >&2
  exit 1
}

echo "  Fetching noVNC ${NOVNC_TAG}..."
# Bounded (CODING-RULES §6) by git's low-speed abort — portable, unlike timeout(1)
# on the macOS dev machine: under 1 KB/s for 60 s gives up.
git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 -c advice.detachedHead=false \
  clone --quiet --depth 1 --branch "$NOVNC_TAG" --config core.hooksPath=/dev/null \
  https://github.com/novnc/noVNC.git "$TMP/novnc" 2>"$TMP/git.err" \
  || fail "git clone of tag ${NOVNC_TAG} failed (network or git?): $(tail -n 2 "$TMP/git.err" | tr '\n' ' ')"

GOT="$(git -C "$TMP/novnc" rev-parse HEAD)"
[[ "$GOT" == "$NOVNC_COMMIT" ]] || fail "tag ${NOVNC_TAG} is commit ${GOT}, expected ${NOVNC_COMMIT}"
[[ -f "$TMP/novnc/core/rfb.js" && -d "$TMP/novnc/vendor/pako" ]] || fail "the checkout has no core/rfb.js or vendor/pako"

mkdir -p "$STAGE"
cp -R "$TMP/novnc/core" "$TMP/novnc/vendor" "$STAGE/"
echo "$PIN" > "$STAGE/.pinned"

rm -rf "$DEST"
mv "$STAGE" "$DEST"
echo "  noVNC ${NOVNC_TAG} (${NOVNC_COMMIT:0:12}) vendored into ${DEST}"
