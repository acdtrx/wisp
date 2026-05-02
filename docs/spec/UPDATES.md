# Wisp Self-Update

Wisp can update itself in place from GitHub Releases. The full chain is GitHub-only — no central update server.

## Architecture: who-runs-what

The update applier is **a separate systemd unit** (`wisp-updater.service`, `Type=oneshot`) so the backend that triggers an update is not the process trying to swap itself. The updater lives in its own cgroup, with its own stdio (journald), and the backend's death during `step:stop-services` cannot reach it. This sidesteps the entire class of bash↔node↔sudo↔scope process-tree issues that the v1.0.6–v1.0.10 series struggled with.

## Pieces

| Layer | What it does |
|-------|--------------|
| Release script (`scripts/release.sh <version>`) | Bumps `package.json` versions across root + backend + frontend, retitles the topmost `## YYYY-MM-DD` CHANGELOG section to `## YYYY-MM-DD (vX.Y.Z)`, commits, and tags `vX.Y.Z`. `CHANGELOG.md` may be the only dirty file in the working tree — its contents are folded into the same `release: vX.Y.Z` commit so a release lands as one commit. Push is left to the operator. |
| GitHub Actions (`.github/workflows/release.yml`) | Triggered on `v*` tag push. Verifies tag matches all three `package.json` files, builds the frontend, packages a release tarball with **prebuilt** `frontend/dist/`, generates a SHA256, extracts the matching CHANGELOG section as release notes, and creates a GitHub Release with the tarball + sha256 attached. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are marked as prereleases. |
| Backend checker (`backend/src/lib/wispUpdate.js`) | Polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` once per hour starting 30s after backend boot. Caches `{ current, latest, available, notes, publishedAt, asset, sha256Asset, lastChecked }`. The `available` flag drives the Software-tab badge via the host stats SSE. |
| Backend apply (`applyUpdate` in `wispUpdate.js`) | Downloads tarball + sha256, verifies, extracts to `/var/lib/wisp/updates/staging-<version>/`. Then writes the staging path to `/var/lib/wisp/updates/target` (atomic via `rename(2)`) and runs `sudo -n /usr/bin/systemctl start --no-block wisp-updater.service`. The HTTP request returns 202 with `{ targetVersion }` once the trigger is queued — the backend dies a moment later as the updater runs `systemctl stop wisp`. |
| Updater unit (`systemd/linux/wisp-updater.service`) | `Type=oneshot`, `User=root`, `Environment=WISP_INSTALL_DIR=<install-dir>` (templated at install time), `ExecStart=/usr/local/bin/wisp-updater`, `StandardOutput=journal`. |
| Updater script (`backend/scripts/wisp-updater`, installed at `/usr/local/bin/wisp-updater`) | Reads target staging path from `/var/lib/wisp/updates/target` (must start with `/var/lib/wisp/updates/staging-`). Stops `wisp.service` → snapshots install to `<install>.prev/` → rsyncs staging into install (preserving user config + `.pids` / `.logs`) → runs `npm ci --omit=dev` in backend → re-runs `install-helpers.sh` (refreshes all wisp-* helpers + the unit + sudoers) → re-templates `wisp.service` → starts the service. Auto-rolls-back from `<install>.prev` on failure. |
| Frontend `WispUpdateSection` (under Host → Software) | Reads cached state from the host stats SSE, shows current/latest/last-checked. Renders inside the shared `UpdateCard` (`Check` / `Update` buttons, unified status row, `Checked hourly` footer). When an update is available, a **Release notes** link opens the shared `UpdateDetailsModal` (markdown body + "View on GitHub" footer). After Update: backend POST blocks during download (~10s), then UI **polls `GET /api/host` every 5 s** comparing `wispVersion` to the target. On match → reload page. After 12 failed polls (1 min): show "may be slow" hint. After 60 polls (5 min): give up with a "check journalctl" message. |

## API

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/updates/status` | Returns the cached check result. Body shape: `{ current, latest, available, notes, publishedAt, lastChecked, lastError, repo }`. |
| `POST` | `/api/updates/check` | Forces an immediate check; returns the same shape as `/status`. 503 on network or rate-limit failure. |
| `POST` | `/api/updates/install` | Synchronously downloads + verifies + extracts (~5–15 s), writes the target marker, triggers `wisp-updater.service` and returns 202 `{ targetVersion }`. 409 if `available=false` or if other background jobs are running (pass `?force=1` to override). 500/503 from `handleRouteError` if download/verify fail or the unit file is missing. After this returns, the backend dies as the updater runs `systemctl stop wisp` — the UI polls `/api/host` to detect completion. |

The host stats SSE payload (`/api/stats`) includes `wispUpdate: { current, latest, available, lastChecked }` for badge rendering and the section's hydration.

## Privilege model

The deploy user can do exactly one root-side thing:

```
<deploy-user> ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service
```

Sudoers matches argv exactly — no other systemctl verbs, no other units. The unit file is root-owned at `/etc/systemd/system/wisp-updater.service`, so the deploy user can't redirect what runs. The install dir is hardcoded into the unit (templated at install time as `WISP_INSTALL_DIR=<path>`), so a tampered target file cannot point the updater at an arbitrary install location. The staging path read from the target file is validated to start with `/var/lib/wisp/updates/staging-`.

## Repo configuration

The default repo is `acdtrx/wisp`. To point at a fork (testing, mirror), set `WISP_UPDATE_REPO=<owner>/<repo>` in `config/runtime.env`.

## Tag convention

Releases use the `v` prefix (`v1.0.5`, `v1.0.6-rc.1`) — matches Linux kernel, Kubernetes, Node, and most ecosystems. The asset filename strips the prefix (`wisp-1.0.5.tar.gz`).

The release workflow detects prereleases by the presence of a hyphen in the tag: `v1.0.6` is stable, `v1.0.6-rc.1` is prerelease. GitHub's `releases/latest` endpoint excludes prereleases server-side, so the auto-checker only ever surfaces stable releases.

## Active-jobs guard

`POST /api/updates/install` refuses to start while any other background job is running. The UI handles this with a confirm dialog that calls `?force=1` when the user explicitly chooses to proceed.

## Rollback

After a successful update, the old install tree is kept at `<install>.prev/` (one-deep). The `wisp-updater` script restores from there automatically if any step after the snapshot fails. There is no UI for explicit user-initiated rollback in v1; if needed, a user can manually `rsync -a --delete <install>.prev/ <install>/ && systemctl restart wisp`.

## Layout

```
backend/
  src/lib/wispUpdate.js              ← checker + downloader + systemctl trigger
  src/routes/updates.js              ← /api/updates/* routes
  scripts/wisp-updater               ← installed to /usr/local/bin
systemd/linux/
  wisp-updater.service               ← templated to /etc/systemd/system
frontend/
  src/api/updates.js                 ← REST client
  src/components/host/WispUpdateSection.jsx  ← polls /api/host for completion
scripts/
  release.sh                         ← local release tagger
  linux/setup/install-helpers.sh     ← installs script + unit + sudoers
.github/workflows/
  release.yml                        ← runs on v* tag push
```
