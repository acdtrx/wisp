# Wisp Self-Update

Wisp can update itself in place from GitHub Releases. The full chain is GitHub-only — no central update server.

## Pieces

| Layer | What it does |
|-------|--------------|
| Release script (`scripts/release.sh <version>`) | Bumps `package.json` versions across root + backend + frontend, retitles the topmost `## YYYY-MM-DD` CHANGELOG section to `## YYYY-MM-DD (vX.Y.Z)`, commits, and tags `vX.Y.Z`. Push is left to the operator. |
| GitHub Actions (`.github/workflows/release.yml`) | Triggered on `v*` tag push. Verifies tag matches all three `package.json` files, builds the frontend, packages a release tarball with **prebuilt** `frontend/dist/`, generates a SHA256, extracts the matching CHANGELOG section as release notes, and creates a GitHub Release with the tarball + sha256 attached. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are marked as prereleases. |
| Backend checker (`backend/src/lib/wispUpdate.js`) | Polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` once per hour starting 30s after backend boot. Caches `{ current, latest, available, notes, publishedAt, asset, sha256Asset, lastChecked }`. The `available` flag drives the Software-tab badge via the host stats SSE. |
| Backend apply pipeline | Downloads tarball + sha256, verifies, extracts to a staging dir adjacent to the install dir (`<install>.update.<version>/`), then invokes the privileged `wisp-update` helper. |
| Privileged helper (`backend/scripts/wisp-update`, installed at `/usr/local/bin/wisp-update`) | Stops services → snapshots install to `<install>.prev/` → rsyncs staging into install (preserving user config + `.pids` / `.logs`) → runs `npm ci --omit=dev` in backend → reinstalls helpers and systemd units → starts services. Auto-rolls-back from `<install>.prev` on failure. |
| Frontend `WispUpdateSection` (under Host → Software) | Reads cached state from the host stats SSE, shows current/latest/last-checked, has Check + Install buttons, streams install progress via the standard background-job SSE, and reloads the page when the new backend comes back up. |

## API

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/updates/status` | Returns the cached check result. Body shape: `{ current, latest, available, notes, publishedAt, lastChecked, lastError, repo }`. |
| `POST` | `/api/updates/check` | Forces an immediate check; returns the same shape as `/status`. 503 on network or rate-limit failure. |
| `POST` | `/api/updates/install` | Starts the install pipeline as a background job; returns `{ jobId, title }` (HTTP 201). 409 if `available=false`, if another install is in flight, or if non-update background jobs are running (pass `?force=1` to override that last guard). |
| `GET` | `/api/updates/progress/:jobId` | SSE: streams `{ step, ... }` events. Steps in order: `start`, `download` (with `received`/`total`), `verify`, `extract`, `apply`, `stop-services`, `snapshot`, `swap`, `install-deps`, `install-helpers`, `install-units`, `start-services`, `done`. On failure: `{ step: 'error', error, detail }` (and the helper auto-rolls-back, emitting `step: 'rollback'` to stderr — not over SSE). |

The host stats SSE payload (`/api/stats`) includes `wispUpdate: { current, latest, available, lastChecked }` for badge rendering and the section's hydration.

## Repo configuration

The default repo is `acdtrx/wisp`. To point at a fork (testing, mirror), set `WISP_UPDATE_REPO=<owner>/<repo>` in `config/runtime.env`.

## Tag convention

Releases use the `v` prefix (`v1.0.5`, `v1.0.6-rc.1`) — matches Linux kernel, Kubernetes, Node, and most ecosystems. The asset filename strips the prefix (`wisp-1.0.5.tar.gz`).

The release workflow detects prereleases by the presence of a hyphen in the tag: `v1.0.6` is stable, `v1.0.6-rc.1` is prerelease. GitHub's `releases/latest` endpoint excludes prereleases server-side, so the auto-checker only ever surfaces stable releases.

## Active-jobs guard

`POST /api/updates/install` refuses to start while *other* (non-update) background jobs are running. The UI handles this with a confirm dialog that calls `?force=1` when the user explicitly chooses to proceed. A wisp-update job already in flight is always a hard 409.

## Rollback

After a successful update, the old install tree is kept at `<install>.prev/` (one-deep). The `wisp-update` helper restores from there automatically if any step after the snapshot fails. There is no UI for explicit user-initiated rollback in v1; if needed, a user can manually `rsync -a --delete <install>.prev/ <install>/ && systemctl restart wisp-backend wisp-frontend`.

## Layout

```
backend/
  src/lib/wispUpdate.js          ← checker + downloader + applier
  src/lib/wispUpdateJobStore.js  ← per-install job (createJobStore)
  src/routes/updates.js          ← /api/updates/* routes
  scripts/wisp-update            ← privileged helper installed to /usr/local/bin
frontend/
  src/api/updates.js             ← REST client
  src/components/host/WispUpdateSection.jsx
scripts/
  release.sh                     ← local release tagger
.github/workflows/
  release.yml                    ← runs on v* tag push
```
