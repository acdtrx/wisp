#!/usr/bin/env bash
# Vendor noVNC (core + pako) at its pinned release into frontend/public/vendor/novnc.
# Usage: bash scripts/vendor-novnc.sh   (no arguments)
#
# The one place the noVNC version is named (docs/specs/noVNC.md). The frontend's
# `npm run build` runs this first, so every source build fetches through it (CI, the
# dev machine, `wispctl build` on hosts). `novnc/.pinned` records what the tree
# holds; a tree holding anything else is replaced, and a failed fetch fails the
# build with the tree left as it was. One run at a time: a second run fails on the
# lock directory beside the target.
set -euo pipefail

NOVNC_TAG="v1.7.0"
NOVNC_COMMIT="63107bd06d9e1f6136ff21aeda8cd62cbf0d433e"
PIN="${NOVNC_TAG} ${NOVNC_COMMIT}"

if [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/vendor-novnc.sh   (takes no arguments)" >&2
  exit 64
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="${PROJECT_DIR}/frontend/public/vendor"
DEST="${PARENT}/novnc"
STAMP="${DEST}/.pinned"
LOCK="${PARENT}/.novnc.lock"

is_pinned() {
  [[ -f "$STAMP" && "$(cat "$STAMP")" == "$PIN" && -f "$DEST/core/rfb.js" && -d "$DEST/vendor/pako" ]]
}

if is_pinned; then
  echo "  noVNC ${NOVNC_TAG} already present"
  exit 0
fi

TMP=""
STAGE="${PARENT}/.novnc.staging.$$"
OLD="${PARENT}/.novnc.old.$$"
HAVE_LOCK=0
cleanup() {
  [[ -n "$TMP" ]] && rm -rf "$TMP"
  (( HAVE_LOCK )) || return 0
  rm -rf "$STAGE" "$OLD"
  rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$PARENT"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "ERROR: another vendor-novnc.sh run holds ${LOCK}." >&2
  echo "       Wait for it to finish, or remove that directory if no run is active." >&2
  exit 1
fi
HAVE_LOCK=1
TMP="$(mktemp -d)"

fail() {
  echo "ERROR: could not vendor noVNC ${NOVNC_TAG}: $*" >&2
  echo "       ${DEST} is left as it was; fix the cause and build again." >&2
  exit 1
}

# Under the lock: what a run killed outright left behind is no other run's.
rm -rf "$PARENT"/.novnc.staging.* "$PARENT"/.novnc.old.*
if is_pinned; then
  echo "  noVNC ${NOVNC_TAG} already present"
  exit 0
fi

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

mkdir "$STAGE"
cp -R "$TMP/novnc/core" "$TMP/novnc/vendor" "$STAGE/"
echo "$PIN" > "$STAGE/.pinned"

# Swap by rename, so the target is the old tree, the new one, or briefly absent —
# never partial.
if [[ -e "$DEST" ]]; then mv "$DEST" "$OLD"; fi
mv "$STAGE" "$DEST"
rm -rf "$OLD"
echo "  noVNC ${NOVNC_TAG} (${NOVNC_COMMIT:0:12}) vendored into ${DEST#"$PROJECT_DIR"/}"
