# Wisp Self-Update

Wisp can update itself in place from GitHub Releases. The full chain is GitHub-only — no central update server.

## Pieces

| Layer | What it does |
|-------|--------------|
| Release script (`scripts/release.sh <version>`) | Bumps `package.json` versions across root + backend + frontend, retitles the topmost `## YYYY-MM-DD` CHANGELOG section to `## YYYY-MM-DD (vX.Y.Z)`, commits, and tags `vX.Y.Z`. Push is left to the operator. |
| GitHub Actions (`.github/workflows/release.yml`) | Triggered on `v*` tag push. Verifies tag matches all three `package.json` files, builds the frontend, packages a release tarball with **prebuilt** `frontend/dist/`, generates a SHA256, extracts the matching CHANGELOG section as release notes, and creates a GitHub Release with the tarball + sha256 attached. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are marked as prereleases. |
| Backend checker (`backend/src/lib/wispUpdate.js`) | Polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` once per hour starting 30s after backend boot. Caches `{ current, latest, available, notes, publishedAt, asset, sha256Asset, lastChecked }`. The `available` flag drives the Software-tab badge via the host stats SSE. |
| Backend apply pipeline | Downloads tarball + sha256, verifies, extracts to a staging dir under `/var/lib/wisp/updates/staging-<version>/`, then **spawns the privileged helper detached** (`detached: true, stdio: 'ignore'`). The HTTP request returns 202 with `{ targetVersion }` once the helper is launched — the backend itself dies a moment later as the helper runs `systemctl stop wisp-backend`. |
| Privileged helper (`backend/scripts/wisp-update`, installed at `/usr/local/bin/wisp-update`) | Re-execs into a transient `systemd-run --scope --slice=system.slice` so it survives `wisp-backend.service` cgroup teardown. Stops services → snapshots install to `<install>.prev/` → rsyncs staging into install (preserving user config + `.pids` / `.logs`) → runs `npm ci --omit=dev` in backend AND frontend → reinstalls helpers and systemd units → starts services. Auto-rolls-back from `<install>.prev` on failure. Every step is logged to journald via `systemd-cat -t wisp-update`. |
| Frontend `WispUpdateSection` (under Host → Software) | Reads cached state from the host stats SSE, shows current/latest/last-checked, has Check + Install buttons. After Install: backend POST blocks during download (~10s), then UI **polls `GET /api/host` every 5 s** comparing `wispVersion` to the target. On match → reload page. After 12 failed polls (1 min): show "may be slow" hint. After 60 polls (5 min): give up with a "check journalctl" message. |

## API

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/updates/status` | Returns the cached check result. Body shape: `{ current, latest, available, notes, publishedAt, lastChecked, lastError, repo }`. |
| `POST` | `/api/updates/check` | Forces an immediate check; returns the same shape as `/status`. 503 on network or rate-limit failure. |
| `POST` | `/api/updates/install` | Synchronously downloads + verifies + extracts (~5–15 s), then spawns the privileged helper detached and returns 202 `{ targetVersion }`. 409 if `available=false` or if other background jobs are running (pass `?force=1` to override). 500/503 from `handleRouteError` if download/verify fail. After this returns, the backend dies as the helper runs `systemctl stop wisp-backend` — the UI polls `/api/host` to detect completion. |

The host stats SSE payload (`/api/stats`) includes `wispUpdate: { current, latest, available, lastChecked }` for badge rendering and the section's hydration.

## Repo configuration

The default repo is `acdtrx/wisp`. To point at a fork (testing, mirror), set `WISP_UPDATE_REPO=<owner>/<repo>` in `config/runtime.env`.

## Tag convention

Releases use the `v` prefix (`v1.0.5`, `v1.0.6-rc.1`) — matches Linux kernel, Kubernetes, Node, and most ecosystems. The asset filename strips the prefix (`wisp-1.0.5.tar.gz`).

The release workflow detects prereleases by the presence of a hyphen in the tag: `v1.0.6` is stable, `v1.0.6-rc.1` is prerelease. GitHub's `releases/latest` endpoint excludes prereleases server-side, so the auto-checker only ever surfaces stable releases.

## Active-jobs guard

`POST /api/updates/install` refuses to start while any other background job is running. The UI handles this with a confirm dialog that calls `?force=1` when the user explicitly chooses to proceed.

## Rollback

After a successful update, the old install tree is kept at `<install>.prev/` (one-deep). The `wisp-update` helper restores from there automatically if any step after the snapshot fails. There is no UI for explicit user-initiated rollback in v1; if needed, a user can manually `rsync -a --delete <install>.prev/ <install>/ && systemctl restart wisp-backend wisp-frontend`.

## Layout

```
backend/
  src/lib/wispUpdate.js          ← checker + downloader + detached applier spawn
  src/routes/updates.js          ← /api/updates/* routes (no SSE)
  scripts/wisp-update            ← privileged helper installed to /usr/local/bin
frontend/
  src/api/updates.js             ← REST client
  src/components/host/WispUpdateSection.jsx  ← polls /api/host for completion
scripts/
  release.sh                     ← local release tagger
.github/workflows/
  release.yml                    ← runs on v* tag push
```

## Why detach + poll instead of SSE

We tried streaming helper progress over SSE for the v1.0.6–v1.0.9 series and hit a chain of process-tree edge cases:

- v1.0.6: helper killed by `wisp-backend.service`'s cgroup teardown (no detach)
- v1.0.7: `systemd-run --scope` placed scope under wisp-backend's cgroup tree → still killed (no `--slice`)
- v1.0.8: scope detached but next `printf` after backend death SIGPIPE'd bash
- v1.0.9: SIGPIPE survived but in-app run still hung mysteriously

Every fix was layered on top of "keep the stdio pipe between Node and the helper alive across Node's death". Every fix landed; every fix uncovered another edge case in bash↔sudo↔scope process tree behavior. The detach + poll architecture sidesteps the entire class of bug — the backend never had a pipe to lose. Manual helper invocation (no Node, no SSE) had been working since v1.0.8; this just brings the in-app path in line with the manual one.
