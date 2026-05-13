#!/usr/bin/env bash
# One-shot manual migration for app containers created before commit 4f652a8
# (May 4, 2026), which moved `app` and `appConfig` from the top of
# container.json into a nested `metadata` object.
#
# Run this on the Wisp server. It stops wisp, rewrites any container.json that
# still has top-level `app`/`appConfig` keys, and starts wisp again. A `.bak`
# is left next to every file it touches.
#
# Not part of the app — feature-building mode means no in-app migrations.
# Delete this script once you've run it.

set -euo pipefail

CONTAINERS_DIR="${WISP_CONTAINERS_DIR:-/var/lib/wisp/containers}"

if [ ! -d "$CONTAINERS_DIR" ]; then
  echo "No containers dir at $CONTAINERS_DIR — nothing to do." >&2
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required." >&2
  exit 1
fi

echo "Stopping wisp.service ..."
sudo systemctl stop wisp.service

migrated=0
skipped=0

for f in "$CONTAINERS_DIR"/*/container.json; do
  [ -f "$f" ] || continue

  result=$(sudo python3 - "$f" <<'PY'
import json, shutil, sys
p = sys.argv[1]
with open(p) as fh:
    d = json.load(fh)

if "app" not in d and "appConfig" not in d:
    print("skip")
    sys.exit(0)

shutil.copy(p, p + ".bak")
meta = d.get("metadata") or {}
if "app" in d:
    meta["app"] = d.pop("app")
if "appConfig" in d:
    meta["appConfig"] = d.pop("appConfig")
d["metadata"] = meta

with open(p, "w") as fh:
    json.dump(d, fh, indent=2)
print("migrated")
PY
  )

  case "$result" in
    migrated) echo "  migrated $f"; migrated=$((migrated + 1)) ;;
    skip)     skipped=$((skipped + 1)) ;;
  esac
done

echo
echo "Done: $migrated migrated, $skipped already current."
echo "Backups left as <container.json>.bak next to each migrated file."
echo

echo "Starting wisp.service ..."
sudo systemctl start wisp.service
