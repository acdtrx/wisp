#!/usr/bin/env bash
# The release-shaped tree every host installs, and its tarball: the release
# workflow publishes it, push.sh deploys it. Hosts never build — the frontend is
# built here, and the backend ships its source without node_modules or tests.
#
# Usage: scripts/stage-release.sh <out-dir>
#   → <out-dir>/wisp/ (the tree) and <out-dir>/wisp-<version>.tar.gz (its top
#     directory `wisp/`), <version> from the root package.json.
# Needs the frontend's packages installed (`npm ci` in frontend/).
#
# The files are those git tracks (the index), with the working tree's content:
# a new file ships once it is `git add`ed, and nothing untracked or ignored
# (config secrets, notes, logs, node_modules) ever does; from config/ only the
# examples. Plus the frontend build output, and `RELEASE` naming the version
# and the commit (marked when the staged content differed from it), by which the
# installer knows a release-shaped tree and says what it installs. The
# tarball holds the same files and content from any machine: no extended
# attributes, no AppleDouble `._*` files, no `.DS_Store`, no test files; a staged
# tree or a tarball holding one fails.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <out-dir>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
STAGE="$OUT/wisp"
ARCHIVE="$OUT/wisp-$VERSION.tar.gz"

echo "=== Staging Wisp $VERSION → $STAGE ==="

echo "--- Frontend build ---"
(cd "$ROOT/frontend" && npm run build)

rm -rf "$STAGE" "$ARCHIVE"
mkdir -p "$STAGE/frontend"

# backend/ (without tests), scripts/, systemd/, config/ (the examples), docs/,
# and the top-level files. The frontend ships only what the backend serves:
# dist/ (the built SPA) and public/ (noVNC under vendor/, which the build fetches).
cd "$ROOT"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
git ls-files -z --cached -- \
  backend scripts systemd config docs package.json CHANGELOG.md LICENSE README.md AGENTS.md CLAUDE.md > "$LIST"
node - "$STAGE" "$LIST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [stage, list] = process.argv.slice(2);
const copy = (from) => fs.cpSync(from, path.join(stage, from), { preserveTimestamps: true });
const listed = fs.readFileSync(list, 'utf8').split('\0').filter(Boolean);
for (const file of [...new Set(listed)].sort()) {
  if (file.endsWith('.test.js') || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
  if (file.startsWith('config/') && !file.endsWith('.example')) continue;
  copy(file);
}
// Build output, not in git's list: the SPA, and the public assets noVNC joins.
const skip = (src) => ['.DS_Store'].includes(path.basename(src)) || path.basename(src).startsWith('._');
for (const dir of ['frontend/dist', 'frontend/public']) {
  fs.cpSync(dir, path.join(stage, dir), { recursive: true, preserveTimestamps: true, filter: (src) => !skip(src) });
}
NODE

COMMIT="$(git rev-parse HEAD)"
# key=value lines, so the installer reads them before Node is on the host.
DIRTY=no
git diff --quiet HEAD -- || DIRTY=yes
printf 'version=%s\ncommit=%s\nuncommitted=%s\n' "$VERSION" "$COMMIT" "$DIRTY" > "$STAGE/RELEASE"

test -f "$STAGE/frontend/dist/index.html" || { echo "ERROR: frontend/dist/index.html missing" >&2; exit 1; }
# The offline shell must ship with its precache list baked in by
# frontend/scripts/generate-sw-precache.js: a missing or unsubstituted sw.js
# returns every installed client to a blank page when the server is down.
test -f "$STAGE/frontend/dist/sw.js" || { echo "ERROR: frontend/dist/sw.js missing" >&2; exit 1; }
if grep -q '__WISP_BUILD_ID__\|__WISP_PRECACHE_URLS__' "$STAGE/frontend/dist/sw.js"; then
  echo "ERROR: dist/sw.js still contains build placeholders." >&2
  exit 1
fi

# Unit tests run from the repo (npm test), never on a host; macOS litter never ships.
STRAY="$(find "$STAGE" \( -name '*.test.js' -o -name '._*' -o -name '.DS_Store' \) -print)"
if [[ -n "$STRAY" ]]; then
  echo "ERROR: the staged tree holds files that must not ship:" >&2
  echo "$STRAY" >&2
  exit 1
fi

# bsdtar (macOS) would store extended attributes (com.apple.provenance) as pax
# headers and AppleDouble `._*` entries; GNU tar stores neither by default.
# ustar keeps every entry a plain header: no pax or GNU long-name records.
TAR_FLAGS=(--no-xattrs --no-acls)
if tar --version 2>/dev/null | grep -q bsdtar; then
  TAR_FLAGS+=(--no-mac-metadata --no-fflags --format ustar)
else
  TAR_FLAGS+=(--no-selinux --format=ustar)
fi
COPYFILE_DISABLE=1 tar "${TAR_FLAGS[@]}" -czf "$ARCHIVE" -C "$OUT" wisp

# The tarball itself, header by header: a regular file or directory per entry,
# and none of the metadata or names above.
node - "$ARCHIVE" <<'NODE'
const fs = require('node:fs');
const zlib = require('node:zlib');
const buf = zlib.gunzipSync(fs.readFileSync(process.argv[2]));
const field = (h, off, len) => h.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '');
const problems = [];
let files = 0;
for (let off = 0; off + 512 <= buf.length;) {
  const h = buf.subarray(off, off + 512);
  if (h.every((b) => b === 0)) break;
  const name = [field(h, 345, 155), field(h, 0, 100)].filter(Boolean).join('/');
  const type = String.fromCharCode(h[156] || 0x30);
  const size = parseInt(field(h, 124, 12).trim() || '0', 8);
  const base = name.replace(/\/$/, '').split('/').pop();
  if (type === 'x' || type === 'g') problems.push(`${name}: pax extended header (attributes or metadata)`);
  else if (!['0', '5'].includes(type)) problems.push(`${name}: entry type ${type}`);
  if (base.startsWith('._') || base === '.DS_Store' || base.endsWith('.test.js')) problems.push(`${name}: must not ship`);
  if (type === '0') files += 1;
  off += 512 + Math.ceil(size / 512) * 512;
}
if (problems.length) {
  console.error(`ERROR: ${process.argv[2]} is not clean:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`  ${files} files, clean`);
NODE

echo "=== Staged: $ARCHIVE ==="
