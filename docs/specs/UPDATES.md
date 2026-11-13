# Wisp Self-Update

Wisp can update itself in place from GitHub Releases. The full chain is GitHub-only — no central update server.

## Architecture: who-runs-what

The update applier is **a separate systemd unit** (`wisp-updater.service`, `Type=oneshot`) so the backend that triggers an update is not the process trying to swap itself. The updater lives in its own cgroup, with its own stdio (journald), and the backend's death during `step:stop-services` cannot reach it. This sidesteps the entire class of bash↔node↔sudo↔scope process-tree issues that the v1.0.6–v1.0.10 series struggled with.

## Pieces

| Layer | What it does |
|-------|--------------|
| Release script (`scripts/release.sh <version>`) | Bumps `package.json` versions across root + backend + frontend, and each sibling `package-lock.json` where one exists (both the top-level `version` and `packages[""].version`; the repo root has no lockfile since it has no dependencies). Retitles the topmost `## YYYY-MM-DD` CHANGELOG section to `## YYYY-MM-DD (vX.Y.Z)`, commits, and tags `vX.Y.Z`. A **prerelease** version skips that retitle (see Tag convention). `CHANGELOG.md` may be the only dirty file in the working tree — its contents are folded into the same `release: vX.Y.Z` commit so a release lands as one commit. Push is left to the operator. |
| GitHub Actions (`.github/workflows/release.yml`) | Triggered on `v*` tag push. Verifies tag matches all three `package.json` files, builds the frontend, packages a release tarball with **prebuilt** `frontend/dist/`, generates a SHA256, extracts the matching CHANGELOG section as release notes, and creates a GitHub Release with the tarball + sha256 attached. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are marked as prereleases. |
| Backend checker (`backend/src/lib/wispUpdate.js`) | Polls GitHub Releases once per hour starting 30s after backend boot, following the host's configured **update channel** (see below). Caches `{ current, latest, available, notes, publishedAt, asset, sha256Asset, lastChecked }`. The `available` flag drives the Software-tab badge via the host stats SSE. |
| Backend apply (`applyUpdate` in `wispUpdate.js`) | Downloads tarball + sha256 (via the shared **SSRF-safe fetch** — DNS-pinned, private/loopback IPs blocked, every redirect `Location` re-validated), verifies, extracts to `/var/lib/wisp/updates/staging-<version>/`. Then writes the staging path to `/var/lib/wisp/updates/target` (atomic via `rename(2)`) and runs `sudo -n /usr/bin/systemctl start --no-block wisp-updater.service`. The HTTP request returns 202 with `{ targetVersion }` once the trigger is queued — the backend dies a moment later as the updater runs `systemctl stop wisp`. |
| Updater unit (`systemd/linux/wisp-updater.service`) | `Type=oneshot`, `User=root`, `Environment=WISP_INSTALL_DIR=<install-dir>` (templated at install time), `ExecStart=/usr/local/bin/wisp-updater`, `StandardOutput=journal`, `TimeoutStartSec=600`, `TimeoutStopSec=300` (see Rollback). |
| Updater script (`backend/scripts/wisp-updater`, installed at `/usr/local/bin/wisp-updater`) | Reads target staging path from `/var/lib/wisp/updates/target` (its canonical path must be a direct `staging-*` child of `/var/lib/wisp/updates`). Stops `wisp.service` → snapshots install to `<install>.prev/` → rsyncs staging into install (preserving user config, `config/backup-status.json`, the migration ledger `config/migrations.json`, `.pids` / `.logs`) and re-owns it to the install dir's owner **user and group** (`stat -c %U:%G`; the group need not be named after the user) → runs `npm ci --omit=dev` in backend → runs **`setup/common-steps.sh`** (the step list shared with the installer — see below) → re-templates `wisp.service` → starts the service → **waits for it to be healthy** (see [Health-gated start](#health-gated-start)) → `step:done`. Auto-rolls-back on failure, an unhealthy new backend included (see Rollback). |
| Shared setup steps (`scripts/linux/setup/common-steps.sh`) | The steps the installer and the updater both run: `container-dns.sh`, `avahi.sh`, `install-helpers.sh`, then the **state migrations** (`backend/scripts/migrate.mjs`, see [State migrations](#state-migrations)). Invoked by path from the install tree by **both** `setup-server.sh` and `wisp-updater`, so neither can drift from the other. Exits non-zero if any step fails — `wisp-updater` turns that into a rollback, while `setup-server.sh` wraps it in `run_step` so the install path keeps warning-and-continuing. |
| Frontend `WispUpdateSection` (under Host → Software) | Reads cached state from the host stats SSE, shows current/latest/last-checked. Renders inside the shared `UpdateCard` (`Check` / `Update` buttons, unified status row, `Checked hourly` footer). When an update is available, a **Release notes** link opens the shared `UpdateDetailsModal` (markdown body + "View on GitHub" footer). After Update: backend POST blocks during download (~10s), then UI **polls `GET /api/host` every 5 s** comparing `wispVersion` to the target. On match → reload page. After 12 failed polls (1 min): show "may be slow" hint. After 60 polls (5 min): give up with a "check journalctl" message. |

## API

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/updates/status` | Returns the cached check result. Body shape: `{ current, latest, available, notes, publishedAt, lastChecked, lastError, repo }`. |
| `POST` | `/api/updates/check` | Forces an immediate check; returns the same shape as `/status`. 503 on network or rate-limit failure. |
| `POST` | `/api/updates/install` | Synchronously downloads + verifies + extracts (~5–15 s), writes the target marker, triggers `wisp-updater.service` and returns 202 `{ targetVersion }`. 409 if `available=false`, if other background jobs are running (pass `?force=1` to override), or if an install is already in flight — taken before the first await, released when that install fails, and expired after the updater unit's 600 s start limit (`TimeoutStartSec`), so an updater that fails before stopping Wisp can't block installs for good; `force` doesn't bypass it (settled 2026-11-12). 500/503 from `handleRouteError` if download/verify fail or the unit file is missing; a failed download (network, disk full) removes the partial tarball and the backend keeps running. After this returns, the backend dies as the updater runs `systemctl stop wisp` — the UI polls `/api/host` to detect completion. |

The host stats payload (the `stats` topic on `/api/events`) includes `wispUpdate: { current, latest, available, lastChecked }` for badge rendering and the section's hydration.

## Privilege model

The deploy user can do exactly one root-side thing:

```
<deploy-user> ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service
```

Sudoers matches argv exactly — no other systemctl verbs, no other units. The unit file is root-owned at `/etc/systemd/system/wisp-updater.service`, so the deploy user can't redirect what runs. The install dir is hardcoded into the unit (templated at install time as `WISP_INSTALL_DIR=<path>`), so a tampered target file cannot point the updater at an arbitrary install location. The staging path read from the target file is resolved with `realpath -e` and must then be a direct `staging-*` child of the (equally resolved) `/var/lib/wisp/updates` — so `..` segments, a symlinked `staging-*` entry, or a nested path cannot point the swap at another tree. Resolving the updates dir too keeps hosts that symlink `/var/lib/wisp` to another disk working.

**The real boundary: the deploy user is root-equivalent.** The checks above pin *which* updater runs and *where* it swaps — not *what* it executes. The staging tree is written by the deploy user (the backend extracts the tarball there), and after the swap the updater, as root, runs that tree's `scripts/linux/setup/common-steps.sh` (which installs the `wisp-*` helpers, their sudoers rules and `wisp-updater` itself) and templates `wisp.service` from it. So anyone who can write as the deploy user — or get the backend to stage an arbitrary tree — runs code as root on the next trigger. The narrow sudoers rule stops the deploy user from running *other* root commands directly; it does not separate the deploy user from root. What actually guards the root path is the integrity of what gets staged: the backend only stages a tarball from the configured GitHub release whose sha256 matches (no signature — 2026-07-05 audit M7), and the install tree, `/var/lib/wisp/updates` and the deploy account must be treated as root-sensitive.

## Service worker interaction

The offline shell (`frontend/public/sw.js`, see [ARCHITECTURE.md](../ARCHITECTURE.md#offline-shell-frontendpublicswjs)) controls every navigation, so it sits directly in the update path. Three invariants keep a self-update from stranding a client on a stale build:

1. **Navigations are network-first**, never cache-first. After the updater swaps `frontend/dist/`, the next launch fetches the new `index.html`; the cached shell is only a fallback for when the server does not answer.
2. **`sw.js` and `index.html` are served `Cache-Control: no-cache`; `/assets/*` is `immutable`** (set in `applyShellCachePolicy`, `backend/src/index.js`). A stale `sw.js` pinned in the HTTP cache would outlive the update it is supposed to notice. Asset filenames are content-hashed, so they can pin for a year. A **missing** `/assets/*` (or `/vendor/*`) file — a chunk a pre-update page still asks for — is a JSON **404** with `Cache-Control: no-store`, never the SPA shell: the shell under an asset URL would have been cached as `immutable` (and by the worker's cache-first asset cache) for a year.
3. **Cache names are scoped by a build id** derived from the hashed asset list, injected into `dist/sw.js` by `frontend/scripts/generate-sw-precache.js`. A new release changes the asset hashes → changes `sw.js` → the browser installs the new worker, which precaches the new assets and purges the previous build's caches on `activate`.

`sw.js` ships because it lives in `frontend/public/` and Vite copies it into `dist/`, which the release tarball contains prebuilt. The precache list is baked in during `npm run build`, so the tarball's `dist/sw.js` differs from the repo's `public/sw.js` (which carries `__WISP_BUILD_ID__` / `__WISP_PRECACHE_URLS__` placeholders). A build that cannot resolve the manifest fails loudly rather than shipping the placeholders.

Because `WispUpdateSection` polls `GET /api/host` to detect that the new version is live, and the worker never intercepts `/api`, the post-update reload path is unaffected.

## Repo configuration

The default repo is `acdtrx/wisp`. To point at a fork (testing, mirror), set `WISP_UPDATE_REPO=<owner>/<repo>` in `config/runtime.env`.

## Update channels

A host picks which releases it is offered with `updateChannel` in `wisp-config.json` (`"stable"` | `"beta"`, default `"stable"`). It is set with `PATCH /api/settings` from the Wisp Update card (Host → Software), not from the Settings page — the channel is a property of *this* host's update behavior, and the card is the one surface that shows what that behavior produced.

| Channel | What the checker asks GitHub for |
|---------|----------------------------------|
| `stable` | `GET /repos/<repo>/releases/latest` — GitHub excludes prereleases server-side, so this is always the newest stable release. |
| `beta` | `GET /repos/<repo>/releases?per_page=15`, drafts dropped, then the **highest semver `tag_name`** among the rest (prereleases included). Not the newest by date: a stable cut published after a higher-numbered prerelease must not win. An empty list behaves like a repo with no releases — nothing to update to, not an error. |

Everything past that release object is shared between the channels: notes, `publishedAt`, tarball + sha256 asset discovery, and the `available` computation.

**The channel is read at check time** (settled 2026-08-25) — `checkForUpdate` calls `getSettings()` on every run. Nothing pushes the channel into the checker: the UI PATCHes the setting and then POSTs `/api/updates/check`, so the trigger stays separate from the mechanism (ARCHITECTURE.md, Backend: events). Flipping the channel installs nothing by itself.

**Convergence.** `available` requires `compareSemver(latest, current) > 0`, and the comparator implements full semver precedence — a prerelease sorts *below* the release it leads to. So a beta host running `2.2.0-beta.3` is offered `2.2.0` the moment it is cut, and beta and stable hosts land on the same version at every stable release. Between releases the beta host is simply ahead.

**No downgrades** (settled 2026-08-25). Switching from beta back to stable while running a prerelease newer than the latest stable offers nothing — `2.1.1 > 2.2.0-beta.1` is false, so the check reports no update and the host waits for stable to catch up. Getting back to an older release is a manual operation (the `<install>.prev/` rollback below, or a reinstall); the update path only ever moves forward.

## Tag convention

Releases use the `v` prefix (`v1.0.5`, `v1.0.6-rc.1`) — matches Linux kernel, Kubernetes, Node, and most ecosystems. The asset filename strips the prefix (`wisp-1.0.5.tar.gz`), for prereleases too (`wisp-2.2.0-beta.1.tar.gz`).

The release workflow detects prereleases by the presence of a hyphen in the tag: `v1.0.6` is stable, `v1.0.6-rc.1` is prerelease. GitHub's `releases/latest` endpoint excludes prereleases server-side, so a host on the stable channel never sees one; the beta channel reaches them by listing releases instead.

**A prerelease consumes no CHANGELOG section** (settled 2026-08-25). `release.sh` skips the retitle for a version carrying a `-prerelease` part, so the topmost `## YYYY-MM-DD` section stays unreleased across a whole beta series and the stable cut that follows retitles it — one batch, one set of release notes. The workflow's notes extraction then finds no section matching a `v*-*` tag and falls back to its built-in one-line `Wisp <tag>` note, which is the intended result: a beta is published to be installed, not to be read. Retitling per beta was rejected — it would split one batch across several releases and leave the stable release with an empty section, and the next stable cut would hit the "topmost entry already has a release suffix" guard. That guard therefore fires on stable cuts only. Build metadata alone is not a prerelease: `2.2.0+build.1` takes the stable path.

## Active-jobs guard

`POST /api/updates/install` refuses to start while any other background job is running. The UI handles this with a confirm dialog that calls `?force=1` when the user explicitly chooses to proceed.

## The updater updates itself one release late

`install-helpers.sh` refreshes `/usr/local/bin/wisp-updater` with an atomic `mv -f`, so the **currently running** updater keeps executing its old inode to completion. A release that changes `wisp-updater` therefore ships the new script but runs the old one — the change only takes effect on the *next* update.

Consequences when editing `wisp-updater`:

- **A new step does not run on the release that introduces it.** Observed with the `container-dns` step in v2.0.1: the step was in the shipped tarball and installed correctly, but the v2.0.0 → v2.0.1 run executed the v2.0.0 script and skipped it. Anything the step is responsible for must be applied by hand (or by `setup-server.sh`) on that one upgrade.
- **Verify the step on the release after.** A green update log is not evidence that a newly added step works — check for its `step:` line, not just `step:done`.
- **Never make a release depend on its own updater changes** for correctness. Put anything load-bearing in the setup scripts the updater already calls, or accept a one-release delay.

**The escape hatch is `common-steps.sh`.** The updater invokes it by path from the tree it just swapped, so it is always the *new* release's copy. A step added there takes effect on the very next update with no `wisp-updater` edit and therefore no lag. Editing `wisp-updater` itself is what costs a release — so keep that file thin and put new work in `common-steps.sh`.

Corollary: an updater change is **dark-shipped**. It cannot affect the update that carries it (the old copy is running), and it goes live for the following one. So there is never a reason to delay an updater change to a later release — postponing it only postpones activation by the same amount.

## Health-gated start

`systemctl start wisp` returns as soon as the backend process forks (`Type=simple`), so a release whose backend crashes at boot would otherwise report `step:done` while `Restart=on-failure` cycles it. After `step:start-service` the updater runs **`step:health-check`** (settled 2026-10-16): it polls every 2 s, for up to **90 s**, until both hold at once —

- `systemctl is-active wisp` is `active` (not `activating` between restarts), and
- `curl -fsS --max-time 5 http://127.0.0.1:<port>/api/auth/oidc/status` succeeds — a public route that needs no session and nothing beyond the backend itself. `<port>` is the last `WISP_PORT=` in `config/runtime.env` (the unit's `EnvironmentFile=`; leading digits, quotes optional), else `8080` — the backend's own rule.

Only then does it drop the staging dir and the target marker and print `step:done`. On the deadline it logs `error: wisp not healthy after 90s (state: …; <url>: <curl error>)` and fails, which rolls back. The 90 s covers the backend's boot work before it listens (container autostart, mount reconcile) and leaves the rollback room inside the unit's `TimeoutStartSec=600`.

Polling, because the unit sends no readiness signal. Rejected: `Type=notify` (Node has no `sd_notify` without a native dependency); `is-active` alone (true from the fork, and between restarts it races the poll).

Dark-shipped like every updater edit (see above): the release that introduces the gate is itself started ungated by the previous updater; the gate protects the updates **after** it.

## Rollback

After a successful update, the old install tree is kept at `<install>.prev/` (one-deep). The `wisp-updater` script restores from there automatically if any step after the snapshot fails — including the run being stopped by `TimeoutStartSec` (SIGTERM is turned into a non-zero exit so the rollback fires).

What an automatic rollback restores (settled 2026-10-16):

| Failure point | Restored |
|---------------|----------|
| Before `step:common-setup` (snapshot, swap, `npm ci`) | The install tree only. Nothing host-level has changed yet. |
| `step:common-setup` or later (`step:health-check` included) | The install tree, then **`step:rollback-host-setup`**: the restored (old) tree's own `common-steps.sh` runs again — re-installing its `wisp-*` helpers, their sudoers rules, `wisp-updater` + `wisp-updater.service` and the container-DNS host config — and `wisp.service` is re-templated from the old tree. |

**Restored with the tree: `config/` and the migration ledger** (settled 2026-11-13). The restore rsync brings back all of `config/` from the snapshot — `wisp-config.json`, `runtime.env` and `config/migrations.json` together — so every migration this update ran runs again on the next one. What the state migrations changed outside `config/` (domain XML, `container.json`, file modes) is not undone — see [State migrations → Failure and rollback](#failure-and-rollback).

In every case the rollback **begins** with `systemctl stop wisp` — after a failed health check the new backend is still running or cycling through `Restart=on-failure`, and neither the tree restore nor the restored `common-steps.sh` (whose migrations step refuses a running backend) may run under it — and **ends** with `daemon-reload` and `systemctl start wisp`. That final start is **not** health-gated: the restored release is what ran before, there is nothing further to fall back to, and the rollback must finish.

Limits, by design:

- **Additive leftovers stay.** The old `common-steps.sh` re-installs what the old release knows about; a helper or sudoers file that only the new release introduced stays in `/usr/local/bin` / `/etc/sudoers.d`, unused by the restored code.
- **No retry inside the rollback.** The rollback runs from the `EXIT` trap and never aborts: each step that fails logs a `rollback-warning:` line and the rollback carries on to starting the service. The unit's `TimeoutStopSec=300` gives it that long after a start timeout before systemd escalates to SIGKILL.
- **Finishing a failed rollback by hand** — `journalctl -u wisp-updater` names the step that warned; then, as root: `rsync -a --delete <install>.prev/ <install>/`, `<install>/scripts/linux/setup/common-steps.sh <install> <deploy-user>`, re-template `wisp.service` (`sed -e "s|WISP_USER|<deploy-user>|g" -e "s|WISP_PATH|<install>|g" <install>/systemd/linux/wisp.service > /etc/systemd/system/wisp.service`), `systemctl daemon-reload && systemctl restart wisp`.

The rollback logic lives in `wisp-updater` itself, so a change to it is dark-shipped like any other updater edit: the release that carries it is still rolled back by the previous release's logic.

There is no UI for explicit user-initiated rollback; if needed, run the same "by hand" sequence above.

## State migrations

State an earlier release wrote — libvirt domain XML, `container.json`, config and data-file modes — is brought up to the schema the current code targets by **state migrations**, run during the update (policy: `CODING-RULES.md` §16). Two decisions shape them (settled 2026-10-16):

- **They run as part of the update, not at backend startup.** The backend is stopped while they run, so nothing races them, and a failure fails the update — which rolls back — instead of crash-looping `wisp.service`.
- **An ID ledger, not version ranges.** Each migration has a stable id; the ledger records which ids ran on this host. Version ranges break on the beta channel, on rollbacks and on re-installs.

### Where they run

- **Update:** the last step of `common-steps.sh`, so inside `step:common-setup` — after `install-deps` (the new tree's `node_modules` exist), before `install-unit` / `start-service`. As the deploy user (`sudo -u <deploy-user>`, from `backend/`): it owns the install tree and has libvirt and containerd access. Not a step of its own in `wisp-updater`: an updater edit takes effect one release late, while `common-steps.sh` always comes from the new tree.
- **Install / reinstall (`install.sh`, and `push.sh` through it):** `common-steps.sh` runs inside `setup-server.sh`, before `install.sh`'s build step has installed the backend deps, so it prints `Skipped: backend dependencies not installed yet` there. `install.sh` runs `migrate.mjs` itself after the build: when it (re)starts the service it stops it, migrates, then starts it; with no service running it just migrates; when the operator declines restarting a running service it skips them with a message — the next install or update runs them. It runs the script through `sudo -u` itself, so a first install already has the groups `setup-server.sh` just granted.
- **Never against a running backend:** `common-steps.sh` fails its migration step when `wisp.service` is active (a standalone `setup-server.sh` on a live host).
- **macOS dev:** the managers are stubs — migrations see no workloads.

### Runner (`backend/scripts/migrate.mjs`)

```
node backend/scripts/migrate.mjs              # run every pending migration
node backend/scripts/migrate.mjs --dry-run    # run them with ctx.dryRun = true; record nothing
node backend/scripts/migrate.mjs --list       # applied / failed / pending; runs nothing
  --migrations-dir <dir>                      # read migrations from <dir> — for testing the runner only
```

- Refuses to run as root. Loads config like the backend: `config/runtime.env` first — strictly, except that it skips the lines setting the retired `WISP_BACKEND_PORT` / `WISP_FRONTEND_PORT` (which `0007` removes; they never reach the environment), and with every `WISP_*` value checked — so a malformed, repeated or invalid line or value, `WISP_CONFIG_PATH` included, stops the run (exit **2**) before it picks the config and the ledger to work on, whether or not `0007` has run — and before the modules that resolve their environment as they load, so a `WISP_CONFIG_PATH` (or `WISP_CONTAINERD_SOCK`) set only there is honoured; the runner is started by `common-steps.sh` / `install.sh`, not by systemd's `EnvironmentFile=` — then `wisp-config.json` via `WISP_CONFIG_PATH` or the default — **tolerantly**: the manager setup and `ctx.getConfig()` read only the storage paths, `mounts` and `backupMountId`, a missing or wrong-typed path taking its default (`backend/migrations/lib/tolerantConfig.js`), because a host updating from an older release reaches `0007`, which repairs the file for the strict reader, only after the migrations before it — and configures + connects vmManager and containerManager through `lib/managerBootstrap.js` — the code `index.js` uses, but with `watchEvents: false`: no libvirt DomainEvent or containerd events subscription, so no container restart policy, no network reconcilers and no list caches (list calls read live state). The backend owns those concerns and is back once the update finishes — two actors would race. A failed libvirt / containerd connection is a warning, as in the backend; a migration that then needs that manager fails on its error. With nothing pending it connects to neither.
- **A strict config check after the migrations** (settled 2026-11-13; not under `--list`). Once the pending migrations have run — or with none pending — the runner checks the config as the backend's boot will: `runtime.env` parsed strictly and its `WISP_*` values checked, `wisp-config.json` through the strict schema ([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)), `config/wisp-password` readable and in its `scrypt:` form, and `WISP_DEFAULT_BRIDGE` naming a host bridge. A config still invalid then is a setup error — exit **2** — so an update fails `step:common-setup` and rolls back instead of starting a backend that refuses it. A migration error comes first and still exits **1**. Under `--dry-run` nothing was written, so the check reads the `runtime.env` text and config as `0007` would have left them, handed over through `ctx.setRepairedConfig` (the files themselves when `0007` didn't run): a dry run exits **2** exactly when the real run would. Before the migrations, a `wisp-config.json` that isn't JSON is a setup error too (exit **2**, naming the file): the tolerant reader needs JSON.
- **No `ok` without having seen the state** (settled 2026-10-16). In this mode `listVMs()` and `listContainers()` return the complete, real list or throw — where the backend's cached lists degrade for the UI (an empty list when libvirt is down, a VM whose reads failed left out, a container's last known state on a failed task lookup). `listVMs()` throws `NO_CONNECTION` when libvirt is not connected and `LIBVIRT_ERROR` naming the domains it could not read; `listContainers()` throws `NO_CONTAINERD` when containerd is not connected, `CONFIG_ERROR` for an unreadable containers directory and the task lookup's own error (a missing directory is no containers; a directory without a parseable `container.json` is not a container, to the backend either). So a migration over every VM or container fails — and the update rolls back — instead of recording `ok` over a list it never saw. There is no "not installed" exemption: setup installs and enables both libvirt and containerd on every host (`setup-server.sh`, checked by `sanity.sh`), so an unreachable daemon is a fault to fix, and updates roll back until it is. The connection itself still only warns: a migration that needs neither manager (e.g. `0003`) runs regardless.
- **Reads never write** (settled 2026-10-16; the backend too since 2026-11-12). No manager read writes stored state, in the backend or the runner: data an earlier release or bug left behind is repaired by a migration (`CODING-RULES.md` §16), and the writes that belong to the normal lifecycle are made at the event that causes them — the VM restart-required flag on libvirt connect and the STARTED event, the container's at its start, a container's addresses by the network probe ([VM-MANAGEMENT.md](VM-MANAGEMENT.md#restart-required-flag), [CONTAINERS.md](CONTAINERS.md#config-changes-that-need-a-restart)). Those events are wired only with event watching, so the runner (`watchEvents: false`) makes none of them; its cache refreshes are no-ops as well (there are no caches). The only state changes a run makes are the migrations' own, each recorded with `recordChange` — and under `--dry-run`, none: each migration guards its own writes with `ctx.dryRun`. Rejected: dry-run-only read-only accessors on `ctx` — every migration author would have to pick them, and a real run's unrecorded writes would still differ from its dry-run.
- **Files:** `backend/migrations/NNNN-short-name.js` (ESM, named exports `id` — equal to the file name without `.js` — `description`, and `async run(ctx)`), run in id order. A `.js` file not named that way, an id mismatch or a missing export is a setup error: nothing runs. The release ships the directory (holding `.gitkeep` when empty); a missing directory is an error, never "no migrations".
- **Pending** = every shipped migration without an `ok` ledger entry. After each one the ledger is written. The first failure is recorded as `error`, later migrations do not run, and the runner exits **1**. Setup errors exit **2**: bad flags, a bad migration file, an unreadable or malformed ledger, a `runtime.env` the runner can't load (before any migration runs), and a config that fails the strict check after the migrations. A clean run exits 0 and creates the ledger if it did not exist.
- **Logging:** JSON lines on stdout (pino, through Fastify's logger), so they land in `journalctl -u wisp-updater` inside `step:common-setup`; pretty single-line with `NODE_ENV=development`. Each change is a line carrying `migration` and `dryRun`.

**`ctx`** — what `run(ctx)` gets:

| Field | Purpose |
|-------|---------|
| `dryRun` | `true` under `--dry-run`: inspect and `recordChange` what would change, change nothing. Manager reads never write; the migration skips its own writes. |
| `setRepairedConfig({ runtimeEnvText, configData })` | For `0007`: the `runtime.env` text and decoded `wisp-config.json` as it leaves them, which the strict check reads under `--dry-run`. |
| `recordChange(text)` | Logs the change and adds it to the ledger entry's `changes`, e.g. `dubi: VNC listen 0.0.0.0 → 127.0.0.1 (restart required)`. |
| `log` | Logger bound to the migration's id. |
| `vmManager`, `containerManager` | The manager facades, configured and connected as in the backend. |
| `getConfig()` | The storage paths (`vmsPath`, `imagePath`, `backupLocalPath`, `containersPath`), `mounts` and `backupMountId` from `wisp-config.json`, read tolerantly (`migrations/lib/tolerantConfig.js`) — never the strict reader, which a migration before `0007` would trip on a config an older release wrote. |
| `paths` | `{ installDir, configDir, configFile, runtimeEnvFile }`. |
| `setVMPendingRestart`, `setContainerPendingRestart` | The managers' restart-required setters, passed through from the facades (`undefined` on a facade without them). |

### Ledger (`config/migrations.json`)

```json
{ "applied": [ { "id": "0002-vnc-listen-localhost", "at": "<ISO time>", "result": "ok", "changes": ["…"] },
               { "id": "0003-…", "at": "…", "result": "error", "changes": [], "error": "<message>" } ] }
```

Beside `wisp-config.json` (it follows `WISP_CONFIG_PATH`), mode `0600`, atomic writes (`lib/atomicJson.js`; the backend's boot cleanup sweeps leftovers in that directory), gitignored. One entry per id: rerunning a failed id replaces its `error` entry. Entries for ids a release no longer ships are kept (`--list` marks them). The updater preserves it on swap (`RSYNC_EXCLUDES`) and restores it on rollback with the rest of `config/` (settled 2026-11-13). Forcing a migration to run again means deleting its entry by hand.

### Failure and rollback

A failing migration fails `common-steps.sh`, so `step:common-setup` fails and the updater rolls back (tree + `step:rollback-host-setup`); so does a config that fails the runner's strict check, or a later failure (`step:health-check`). The rollback restores `config/` and the ledger together (settled 2026-11-13): what a migration changed in `config/` is reverted with its ledger entry, and every migration that update ran runs again on the next one — safe because migrations are idempotent. What they changed outside `config/` stays, which is why that state must stay backward-compatible: the restored release runs on it. `rollback-host-setup` runs the old tree's `common-steps.sh`, which — for a release that has the runner — runs the old runner against the restored ledger.

The ledger restore lives in `wisp-updater`, so it is dark-shipped (see above): the first update that carries it is still rolled back by the previous updater, which restores `config/` but keeps the ledger. An update from v2.6.0 that fails after `0007` ran therefore restores the old config while the ledger keeps `0007` as `ok`; until that entry is removed by hand, every later update then fails the strict config check and rolls back.

### Authoring a migration

- **Idempotent** — safe to run again; a no-op on a host already in the target state (fresh installs just record it).
- **Backward-compatible state** — leave state the previous release still accepts; a rollback does not undo what a migration changed outside `config/`.
- **`config/` may change** (settled 2026-11-13) — a migration may edit `wisp-config.json` or `runtime.env`, reading them raw: a rollback reverts them and the ledger together, so the migration runs again next time. Limit: only `config/` in the install dir is in the snapshot. When `WISP_CONFIG_PATH` puts `wisp-config.json` elsewhere, it and its ledger (which follows `WISP_CONFIG_PATH`) are not reverted, while `runtime.env` still is — so a rollback can bring back what `0007` removed from `runtime.env` while the ledger keeps `0007` as `ok`: the migration does not run again, and every later update fails the runner's strict check until that line is removed or `0007`'s ledger entry is deleted by hand; nothing keeps them together (accepted 2026-11-13: no host sets it). Read the config tolerantly (`ctx.getConfig()`), never through the strict reader, so an older release's file can't fail a migration that runs before `0007` has repaired it.
- **Through the managers** — change state via `ctx.vmManager` / `ctx.containerManager` (e.g. XML edits through vmManager's XML handling), never text substitution or direct file writes into a manager's files.
- **Log every change** via `ctx.recordChange`, and honour `ctx.dryRun`.
- **Restart flag only on a running workload** whose change needs a restart; a stopped workload picks the change up on its next start.
- **Deploy-user scope** — root-level host changes do not belong here; they stay in `common-steps.sh` as idempotent convergence.
- **Never renumber or rename** a shipped id — the ledger keys on it.

### Shipped migrations

| Id | Brings up to date | Restart flag |
|----|-------------------|--------------|
| `0001-pending-restart-timestamp` | Container `pendingRestart: true` → `{ since: now }` (the timestamp flag judged against the task's real start). | — (converts the existing flag) |
| `0002-vnc-listen-localhost` | Every VM's saved `<graphics>` (VNC/SPICE): the `listen` attribute and each `<listen type='address'>` child → `127.0.0.1`, through `vmManager.setGraphicsListen` ([VM-MANAGEMENT.md](VM-MANAGEMENT.md) → Graphics). | Running VMs (the live listener changes on the next full stop/start). |
| `0003-cloud-init-json-mode` | Every `<vmsPath>/*/cloud-init.json` with group/other bits → `0600` (it holds the password hash; [CLOUD-INIT.md](CLOUD-INIT.md)). Includes kept directories of deleted VMs. | — |
| `0004-app-secret-file-modes` | App-declared secret files (`getSecretMountNames`: tiny-samba passwords, zot `htpasswd` / `session-keys` / OIDC `config-json`) with group/other bits → `0600`, through `containerManager.setMountFileMode` ([CONTAINERS.md](CONTAINERS.md) → Secret file mounts). | — (same inode, the container sees it at once and still reads it) |
| `0005-container-config-modes` | Every container directory under `containersPath` → `0700` and its `container.json` → `0600`, and every container backup (timestamp directory `0700`, files `0600`) under the backup roots the backend lists — an unmounted backup mount is skipped with a warning — through `containerManager.tightenContainerFileModes` / `tightenContainerBackupFileModes` ([CONTAINERS.md](CONTAINERS.md), [BACKUPS.md → Backup file modes](BACKUPS.md#backup-file-modes)). | — |
| `0006-vm-backup-file-modes` | Every VM backup under the backup roots the backend lists → directory `0700`, files `0600`, through `vmManager.tightenVMBackupFileModes` ([BACKUPS.md → Backup file modes](BACKUPS.md#backup-file-modes)). | — |
| `0007-repair-config-and-records` | Merged before release from the unreleased `0007-container-config-shape` and `0008-backup-origin` (settled 2026-11-13). **1.** `runtime.env`, read raw: lines setting the retired `WISP_BACKEND_PORT` / `WISP_FRONTEND_PORT` removed (the runner has already loaded the rest strictly and checked every `WISP_*` value, so `WISP_CONFIG_PATH` names the right file). **2.** `wisp-config.json`, read raw: the retired keys `refreshIntervalSeconds`, `networkMounts`, `backupNetworkMountId` removed; each mount whose `mountPath` is outside `/mnt/wisp/` removed, its log line naming the containers whose mounts use it as `sourceId`; a `backupMountId` naming no mount cleared, and schedule destinations neither `'local'` nor the `backupMountId` dropped ([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)). **3.** Every `container.json`: a flat `env: { KEY: "value" }` → `{ KEY: { value } }` (non-secret; values recorded by count only), a missing env → `{}`; a missing network or a `network.type` other than `bridge` → `bridge`, a missing or malformed MAC → a generated one; `network.vlan` removed — through `containerManager.readContainerConfig` / `writeContainerConfig`, the MAC from `generateContainerMac` ([CONTAINERS.md](CONTAINERS.md)). **4.** Every VM and container backup manifest without an `origin` (written before 2026-07-14) → `origin: "manual"`, under the backup roots of the config as step 2 left it — an unmounted backup mount is skipped with a warning — through `vmManager.setVMBackupOrigin` / `containerManager.setContainerBackupOrigin` ([BACKUPS.md](BACKUPS.md)). Under `--dry-run`, steps 3–4 and the runner's strict check work from the config as steps 1–2 would leave it. | Running containers whose network type or MAC changed (the env conversion keeps every value). |

## Layout

```
backend/
  src/lib/wispUpdate.js              ← checker + downloader + systemctl trigger
  src/routes/updates.js              ← /api/updates/* routes
  scripts/wisp-updater               ← installed to /usr/local/bin
  scripts/migrate.mjs                ← state-migration runner (common-steps.sh, install.sh)
  migrations/NNNN-short-name.js      ← state migrations
  src/lib/managerBootstrap.js        ← manager configure/connect shared with src/index.js
systemd/linux/
  wisp-updater.service               ← templated to /etc/systemd/system
frontend/
  src/api/updates.js                 ← REST client
  src/components/host/WispUpdateSection.jsx  ← polls /api/host for completion
  public/sw.js                       ← offline shell; network-first navigations
  scripts/generate-sw-precache.js    ← bakes precache list + build id into dist/sw.js
scripts/
  release.sh                         ← local release tagger
  linux/setup/common-steps.sh        ← steps shared by install + update (ends with migrations)
  linux/setup/install-helpers.sh     ← installs script + unit + sudoers
.github/workflows/
  release.yml                        ← runs on v* tag push
```
