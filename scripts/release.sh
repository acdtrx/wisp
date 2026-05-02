#!/usr/bin/env bash
# Bump version across root + backend + frontend package.json, retitle the topmost
# CHANGELOG section, commit, and tag v<version>. CHANGELOG.md may be dirty going
# in — its contents are folded into the same release commit so a release lands as
# a single commit. Push is left to the operator so the tag is reviewable before
# it triggers the release workflow.
#
# Usage: ./scripts/release.sh <version>
#   version  — semver without v prefix, e.g. 1.0.6 or 1.0.6-rc.1
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>"
  echo "  e.g. $0 1.0.6"
  exit 1
fi

VERSION="$1"
TAG="v$VERSION"

# Strict-ish semver: digits.digits.digits with optional -prerelease and +build
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "ERROR: '$VERSION' is not a valid semver string."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Pre-flight
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "ERROR: not a git repository."
  exit 1
fi
# Allow CHANGELOG.md to be dirty (it'll be folded into the release commit
# alongside the version bumps + retitling). Anything else dirty is an error.
DIRTY="$(git status --porcelain | awk '{print $2}' | grep -v '^CHANGELOG\.md$' || true)"
if [[ -n "$DIRTY" ]]; then
  echo "ERROR: working tree has uncommitted changes other than CHANGELOG.md."
  git status --short
  exit 1
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "ERROR: must be on 'main' branch (currently on '$BRANCH')."
  exit 1
fi
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "ERROR: tag $TAG already exists."
  exit 1
fi

bump_pkg_version() {
  local pkg="$1"
  if [[ ! -f "$pkg" ]]; then
    echo "ERROR: $pkg not found."
    exit 1
  fi
  # Replace the first "version": "..." line. node -e is more reliable than sed
  # for JSON, and we already require Node.
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const v = process.argv[2];
    const j = JSON.parse(fs.readFileSync(path, "utf8"));
    j.version = v;
    fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  ' "$pkg" "$VERSION"
  echo "  Bumped $pkg → $VERSION"
}

echo "=== Wisp release: $TAG ==="
echo ""
echo "--- Bump versions ---"
bump_pkg_version "$ROOT/package.json"
bump_pkg_version "$ROOT/backend/package.json"
bump_pkg_version "$ROOT/frontend/package.json"
echo ""

# Retitle the topmost CHANGELOG date heading. Project rule: every push has a
# new dated section at the top; this turns "## YYYY-MM-DD" into
# "## YYYY-MM-DD (vX.Y.Z)" for the version that's about to be tagged.
CHANGELOG="$ROOT/CHANGELOG.md"
if [[ ! -f "$CHANGELOG" ]]; then
  echo "ERROR: CHANGELOG.md missing."
  exit 1
fi

TODAY="$(date +%Y-%m-%d)"

echo "--- Update CHANGELOG ---"
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const today = process.argv[2];
  const tag = process.argv[3];
  const src = fs.readFileSync(path, "utf8");
  const lines = src.split("\n");
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(\d{4}-\d{2}-\d{2})(.*)$/);
    if (!m) continue;
    if (m[2].trim().length > 0) {
      // Already has a (vX.Y.Z) suffix — top section is already a release.
      throw new Error(`Topmost CHANGELOG entry already has a release suffix: "${lines[i]}". Add a fresh "## ${today}" section before releasing.`);
    }
    lines[i] = `## ${today} (${tag})`;
    touched = true;
    break;
  }
  if (!touched) {
    throw new Error("No \"## YYYY-MM-DD\" heading found in CHANGELOG.md to retitle.");
  }
  fs.writeFileSync(path, lines.join("\n"));
' "$CHANGELOG" "$TODAY" "$TAG"
echo "  Retitled topmost section → ## $TODAY ($TAG)"
echo ""

echo "--- Commit + tag ---"
git add package.json backend/package.json frontend/package.json CHANGELOG.md
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Wisp $TAG"
echo "  Committed and tagged $TAG"
echo ""

echo "=== Done ==="
echo ""
echo "Next:"
echo "  git push && git push origin $TAG"
echo ""
echo "The release workflow will run on the tag push and create a GitHub Release with the tarball + sha256."
