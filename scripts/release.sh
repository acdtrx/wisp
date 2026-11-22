#!/usr/bin/env bash
# Check everything first (the tree, the branch, the tag, the files it writes, the
# CHANGELOG's top section, and `npm run check`, the release workflow's gate), so a
# refusal leaves every file as it was; then bump the version in the root
# package.json (and its package-lock.json), the one source, retitle the topmost
# CHANGELOG section, commit, and tag
# v<version>. A failing check stops it before anything changes. CHANGELOG.md
# may be dirty going in — its contents are folded into the same release commit
# so a release lands as a single commit. Push is left to the operator so the
# tag is reviewable before it triggers the release workflow.
#
# Prereleases (a version with a -prerelease part) skip the CHANGELOG retitle: the
# topmost dated section stays unreleased so the eventual stable cut folds the whole
# batch into its notes. Everything else — bumps, commit, tag — is identical.
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

# Prerelease iff the version carries a -<prerelease> part. Build metadata (+...) may
# itself contain hyphens, so strip it before looking — mirrors the release workflow's
# `[[ "$VERSION" == *-* ]]` tag check, which only ever sees plain tags.
if [[ "${VERSION%%+*}" == *-* ]]; then
  PRERELEASE=1
else
  PRERELEASE=0
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

# The root package.json holds the version, the one source every reader reads.
PACKAGES=("$ROOT/package.json")
for pkg in "${PACKAGES[@]}"; do
  if [[ ! -f "$pkg" ]]; then
    echo "ERROR: $pkg not found."
    exit 1
  fi
done

CHANGELOG="$ROOT/CHANGELOG.md"
if [[ ! -f "$CHANGELOG" ]]; then
  echo "ERROR: CHANGELOG.md missing."
  exit 1
fi
TODAY="$(date +%Y-%m-%d)"

# changelog_retitle check|write: the topmost "## YYYY-MM-DD" heading, which must
# carry no release suffix yet, becomes "## YYYY-MM-DD (vX.Y.Z)". `check` only
# parses it and fails as `write` would; `write` changes the file.
changelog_retitle() {
  node -e '
  const fs = require("node:fs");
  const [mode, path, today, tag] = process.argv.slice(1);
  const lines = fs.readFileSync(path, "utf8").split("\n");
  const i = lines.findIndex((line) => /^##\s+\d{4}-\d{2}-\d{2}/.test(line));
  if (i === -1) {
    console.error("ERROR: no \"## YYYY-MM-DD\" heading found in CHANGELOG.md to retitle.");
    process.exit(1);
  }
  if (lines[i].replace(/^##\s+\d{4}-\d{2}-\d{2}/, "").trim().length > 0) {
    console.error(`ERROR: the topmost CHANGELOG entry already has a release suffix: "${lines[i]}". Add a fresh "## ${today}" section before releasing.`);
    process.exit(1);
  }
  if (mode === "write") {
    lines[i] = `## ${today} (${tag})`;
    fs.writeFileSync(path, lines.join("\n"));
  }
' "$1" "$CHANGELOG" "$TODAY" "$TAG"
}

# Prereleases leave the CHANGELOG untouched (below), so only a stable cut needs it.
if [[ "$PRERELEASE" == "0" ]]; then
  changelog_retitle check || exit 1
fi

# The release workflow's own gate, run before anything changes: a failure is met
# here, before a tag exists to push.
echo "--- Check ---"
if ! npm run --silent check; then
  echo ""
  echo "ERROR: npm run check failed; no version changed, no tag created."
  exit 1
fi
echo ""

# Every file the bump touches, collected so the commit stages exactly what changed.
BUMPED=()

# Rewrites a JSON file's version fields in place. node is more reliable than sed for
# JSON, and we already require Node. Re-serializing with 2-space indent + trailing
# newline matches what npm itself writes, so the diff is only the version lines.
write_version() {
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const v = process.argv[2];
    const j = JSON.parse(fs.readFileSync(path, "utf8"));
    j.version = v;
    // Lockfiles (lockfileVersion >= 2) record the project version a second time under
    // the root package entry. npm rewrites both from package.json on every install, so
    // a stale value here surfaces as a spurious diff on the next dependency change.
    if (j.packages && j.packages[""]) j.packages[""].version = v;
    fs.writeFileSync(path, JSON.stringify(j, null, 2) + "\n");
  ' "$1" "$VERSION"
}

bump_pkg_version() {
  local pkg="$1"
  write_version "$pkg"
  BUMPED+=("$pkg")
  echo "  Bumped $pkg → $VERSION"

  # Keep the sibling lockfile in step; a package without one is skipped.
  local lock="${pkg%package.json}package-lock.json"
  [[ -f "$lock" ]] || return 0
  write_version "$lock"
  BUMPED+=("$lock")
  echo "  Bumped $lock → $VERSION"
}

echo "=== Wisp release: $TAG ==="
echo ""
echo "--- Bump versions ---"
for pkg in "${PACKAGES[@]}"; do
  bump_pkg_version "$pkg"
done
echo ""

# Retitle the topmost CHANGELOG date heading. Project rule: every push has a
# new dated section at the top; this turns "## YYYY-MM-DD" into
# "## YYYY-MM-DD (vX.Y.Z)" for the version that's about to be tagged.
#
# Prereleases skip this entirely: a beta consumes no CHANGELOG section, so the
# unreleased batch stays unreleased and the stable cut that follows retitles it and
# ships the full notes. (The release workflow's notes extraction finds no matching
# section for a prerelease tag and falls back to a one-line "Wisp <tag>" note — the
# intended behavior for a beta.) A dirty CHANGELOG.md is still folded into the
# release commit either way, just not retitled.
echo "--- Update CHANGELOG ---"
if [[ "$PRERELEASE" == "1" ]]; then
  echo "  Prerelease — CHANGELOG left untouched; its notes land with the stable release."
else
  changelog_retitle write
  echo "  Retitled topmost section → ## $TODAY ($TAG)"
fi
echo ""

echo "--- Commit + tag ---"
git add "${BUMPED[@]}" CHANGELOG.md
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Wisp $TAG"
echo "  Committed and tagged $TAG"
echo ""

echo "=== Done ==="
echo ""
echo "Next — push the release commit and the tag to each remote:"
for remote in $(git remote); do
  echo "  git push $remote $BRANCH && git push $remote $TAG"
done
echo ""
echo "The release workflow runs on the tag push to the GitHub remote and creates a"
echo "GitHub Release with the tarball + sha256."
