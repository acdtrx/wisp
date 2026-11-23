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
# What ships is what a host runs, and the few files that describe the release
# to its owner: an allowlist (SHIPS below), never a denylist, so a file added
# to the repo stays out until it is named. The backend (without its tests, the
# helpers' test bench and the route tests' fixtures), the built frontend,
# shared/ (the wire's names, which the backend loads), the install, setup and
# wispctl scripts, the unit templates, the config examples, the root
# package.json (the version's one source; its "type" makes shared/ an ES
# module), LICENSE, README.md with screenshots/, and CHANGELOG.md. Never docs/,
# the checks and their lint rules, the release tooling, AGENTS.md or CLAUDE.md:
# an update removes what a release stops shipping (the keep rule, copy.sh).
#
# The files are those git tracks (the index), with the working tree's content:
# a new file ships once it is `git add`ed, and nothing untracked or ignored
# (config secrets, notes, logs, node_modules) ever does. Plus the frontend
# build output, and `RELEASE` naming the version and the commit (marked when
# the staged content differed from it), by which the installer knows a
# release-shaped tree and says what it installs. A staged tree holding a file
# outside the list fails. The tarball holds the same files and content from any
# machine: no extended attributes, no AppleDouble `._*` files, no `.DS_Store`.
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

cd "$ROOT"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
git ls-files -z --cached > "$LIST"
node - "$STAGE" "$LIST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [stage, list] = process.argv.slice(2);
// What ships, by path from the tree's top. The frontend ships only what the
// backend serves: dist/ (the built SPA) and public/ (noVNC under vendor/, which
// the build fetches). RELEASE is written after this.
const SHIPS = [
  /^backend\//, /^shared\//, /^systemd\//, /^config\/[^/]+\.example$/,
  /^scripts\/(?:install|wispctl)\.sh$/, /^scripts\/linux\//,
  /^frontend\/(?:dist|public)\//, /^screenshots\//,
  /^(?:package\.json|CHANGELOG\.md|LICENSE|README\.md)$/,
];
// Inside those, what a host never runs: the unit tests beside their code, the
// helpers' test bench, the route tests' fixtures, Python bytecode, macOS litter.
const NEVER = [
  /\.test\.js$/, /_test\.py$/, /\.pyc$/, /(?:^|\/)__pycache__\//, /^backend\/scripts\/test\//,
  /^backend\/src\/routes\/fixtures\//, /(?:^|\/)\._[^/]*$/, /(?:^|\/)\.DS_Store$/,
];
const ships = (file) => SHIPS.some((re) => re.test(file)) && !NEVER.some((re) => re.test(file));
const copy = (from) => fs.cpSync(from, path.join(stage, from), { preserveTimestamps: true });
const listed = fs.readFileSync(list, 'utf8').split('\0').filter(Boolean);
for (const file of [...new Set(listed)].sort()) {
  if (ships(file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) copy(file);
}
// Build output, not in git's list.
for (const dir of ['frontend/dist', 'frontend/public']) {
  fs.cpSync(dir, path.join(stage, dir), { recursive: true, preserveTimestamps: true, filter: (src) => fs.statSync(src).isDirectory() || ships(src) });
}
// The staged tree, file by file, against the list.
const outside = [];
const walk = (rel) => {
  for (const entry of fs.readdirSync(path.join(stage, rel), { withFileTypes: true })) {
    const file = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(file);
    else if (!ships(file)) outside.push(file);
  }
};
walk('');
if (outside.length) {
  console.error(`ERROR: the staged tree holds files outside what ships:\n  ${outside.join('\n  ')}`);
  process.exit(1);
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
  if (base.startsWith('._') || base === '.DS_Store' || base.endsWith('.test.js') || base.endsWith('_test.py') || base === '__pycache__' || base.endsWith('.pyc')) problems.push(`${name}: must not ship`);
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
