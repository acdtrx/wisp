# Wisp Self-Update

Wisp can update itself in place from GitHub Releases. The full chain is GitHub-only — no central update server.

## Architecture: who-runs-what

The update applier is **a separate systemd unit** (`wisp-updater.service`, `Type=oneshot`) so the backend that triggers an update is not the process trying to swap itself. The updater lives in its own cgroup, with its own stdio (journald), and the backend's death during `step:stop-service` cannot reach it.

## Pieces

**A release** — `scripts/release.sh <version>`, then the workflow on GitHub.

- The script runs every check before its first change (settled 2026-11-22): a failure of any stops it with no file changed.
- It bumps the version in the root `package.json`, the version's one source (settled 2026-11-22: the backend's and the frontend's carry none), and in the root `package-lock.json`. It retitles the topmost `## YYYY-MM-DD` CHANGELOG section to `## YYYY-MM-DD (vX.Y.Z)`, commits, and tags `vX.Y.Z`. A **prerelease** version skips that retitle (see Tag convention). `CHANGELOG.md` may be the only dirty file in the working tree — its contents are folded into the same `release: vX.Y.Z` commit so a release lands as one commit. Push is left to the operator.
- The workflow runs on a `v*` tag push. It verifies the tag matches the root `package.json`'s version, runs `npm run check` (a failure stops it before anything is published), builds the frontend, packages a release tarball with **prebuilt** `frontend/dist/`, generates a SHA256, extracts the matching CHANGELOG section as release notes, and creates a GitHub Release with the tarball + sha256 attached. Tags shaped `v*-*` (e.g. `v1.0.6-rc.1`) are marked as prereleases.

**The check** — the backend polls GitHub Releases once per hour starting 30s after backend boot, following the host's configured **update channel** (see below). The `available` flag drives the Software-tab badge via the host stats SSE.

**The install, in the backend** — downloads tarball + sha256 (via the shared **SSRF-safe fetch**), verifies, extracts to `/var/lib/wisp/updates/staging-<version>/`, and checks that the staged tree's root `package.json` carries the expected version (settled 2026-11-22). Then writes the staging path to `/var/lib/wisp/updates/target` (atomic via `rename(2)`) and runs `sudo -n /usr/bin/systemctl start --no-block wisp-updater.service`. The job's `done` carries `{ targetVersion }` — the backend dies a moment later as the updater runs `systemctl stop wisp`.

**The updater unit** (`wisp-updater.service`) — `Type=oneshot`, `User=root`, `Environment=WISP_INSTALL_DIR=<install-dir>` (templated at install time), `ExecStart=/usr/local/bin/wisp-updater`, `StandardOutput=journal`, `TimeoutStartSec=1800` (30 min, a backstop: the steps' own bounds fire first; settled 2026-11-13), `TimeoutStopSec`, at least the updater's stop budget, and `KillMode=mixed` (see Rollback; settled 2026-11-19).

**The updater** (`/usr/local/bin/wisp-updater`), in this order:

1. Reads the target staging path from `/var/lib/wisp/updates/target` (its canonical path must be a direct `staging-*` child of `/var/lib/wisp/updates`).
2. Takes the install lock (`/run/wisp.lock`, the one the installer and setup take).
3. Stops `wisp.service`: one that does not stop fails the update before anything is changed.
4. Keeps a copy of the install at `<install>.prev/`.
5. Runs **the staged tree's own install**, `scripts/linux/install-tree.sh <staging> <install> <user> <group>` (the install dir's owner **user and group**; a staged tree without it is refused before anything changes), which copies the tree by the keep rule, runs setup and starts Wisp, that start being the gate (see [An update is an install with a way back](#an-update-is-an-install-with-a-way-back) and [Health-gated start](#health-gated-start)).

Each step a stop may cut short runs so that a TERM reaches the updater at once and is passed to that step only (settled 2026-11-19). The updater exits non-zero on any failure, rolling back.

**Setup** — the one list of steps the installer and the updater both run, by path from the install tree (settled 2026-11-18; [DEPLOYMENT.md → Setup](DEPLOYMENT.md#setup)). No migration step: the backend runs the state migrations at its start ([State migrations](#state-migrations)). A failed step fails the run, naming it; the updater turns that into a rollback.

**The page** (Host → Software) — after Update, the install job downloads (progress in the jobs tray); once it hands over to the updater (its `done`, or its stream ending as the backend stops), the UI **polls `GET /api/host` every 5 s** comparing `wispVersion` to the target. On match → reload page. After 12 failed polls (1 min): show "may be slow" hint. It gives up with a "check journalctl" message only once the updater can no longer be running: after its unit's `TimeoutStartSec` and the `TimeoutStopSec` its rollback gets, so a long state migration inside the start is followed to the end.

## API

| Method | Path | Behavior |
|--------|------|----------|
| `GET` | `/api/updates/status` | Returns the cached check result. Body shape: `{ current, latest, available, notes, publishedAt, lastChecked, lastError, repo }`. |
| `POST` | `/api/updates/check` | Forces an immediate check; answers 204, and the new status reaches every tab as `{ kind: "wisp-update" }` on the `changes` topic. 503 `UPDATE_CHECK_UNAVAILABLE` on network or rate-limit failure. |
| `POST` | `/api/updates/install` | Starts a job ([API.md → Job routes](API.md#job-routes)) and returns 202 `{ jobId, kind, title, subject }`; the job downloads + verifies + extracts (progress on its stream), writes the target marker, triggers `wisp-updater.service` and ends. 409 `UPDATE_NOT_AVAILABLE` if `available=false`, `UPDATE_JOBS_ACTIVE` if other jobs that must finish are running — the update checks, which a restart may cut, do not count (pass `?force=1` to override), or `UPDATE_INSTALL_IN_PROGRESS` if an install is already in flight — taken before the first await, released when that install fails, and expired after the updater unit's 30 min start limit (`TimeoutStartSec`), so an updater that fails before stopping Wisp can't block installs for good; `force` doesn't bypass it (settled 2026-11-12). A failed download, verify or unpack, or a missing unit file, is the job's `error` event (the claim is released); a failed download (network, disk full) removes the partial tarball and the backend keeps running. Once the job reports `restarting` and starts the updater, the backend dies as the updater runs `systemctl stop wisp` — the job's stream may end before its `done` — and the UI polls `/api/host` to detect completion. |

The host stats payload (the `stats` topic on `/api/events`) includes `wispUpdate: { current, latest, available, lastChecked }` for badge rendering and the section's hydration.

## Privilege model

For an update the deploy user can do exactly one root-side thing (the helpers' rules, one per helper, are in [DEPLOYMENT.md](DEPLOYMENT.md), The helpers):

```
<deploy-user> ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service
```

- Sudoers matches argv exactly — no other systemctl verbs, no other units.
- The unit file is root-owned at `/etc/systemd/system/wisp-updater.service`, so the deploy user can't redirect what runs.
- The install dir is hardcoded into the unit (templated at install time as `WISP_INSTALL_DIR=<path>`), so a tampered target file cannot point the updater at an arbitrary install location.
- The staging path read from the target file is resolved with `realpath -e` and must then be a direct `staging-*` child of the (equally resolved) `/var/lib/wisp/updates` — so `..` segments, a symlinked `staging-*` entry, or a nested path cannot point the swap at another tree. Resolving the updates dir too keeps hosts that symlink `/var/lib/wisp` to another disk working.

**The real boundary: the deploy user is root-equivalent.** The checks above pin *which* updater runs and *where* it swaps — not *what* it executes. The staging tree is written by the deploy user (the backend extracts the tarball there), and the updater, as root, runs that tree's install and setup. The narrow sudoers rule stops the deploy user from running *other* root commands directly; it does not separate the deploy user from root. What actually guards the root path is the integrity of what gets staged: the backend only stages a tarball from the configured GitHub release whose sha256 matches (no signature), and the install tree, `/var/lib/wisp/updates` and the deploy account must be treated as root-sensitive.

## Service worker interaction

The offline shell (see [ARCHITECTURE.md](../ARCHITECTURE.md#offline-shell-frontendpublicswjs)) controls every navigation, so it sits directly in the update path. Three invariants keep a self-update from stranding a client on a stale build:

1. **Navigations are network-first**, never cache-first. After an update the next launch fetches the new `index.html`; the cached shell is only a fallback for when the server does not answer.
2. **`sw.js` and `index.html` are served `Cache-Control: no-cache`; `/assets/*` is `immutable`.** Asset filenames are content-hashed. A **missing** `/assets/*` (or `/vendor/*`) file — a chunk a pre-update page still asks for — is a JSON **404** `ROUTE_NOT_FOUND` with `Cache-Control: no-store`, never the SPA shell: the shell under an asset URL would be cached as `immutable`.
3. **Cache names are scoped by a build id** derived from the hashed asset list, put into the built `sw.js`. A new release changes the asset hashes → changes `sw.js` → the browser installs the new worker, which precaches the new assets and purges the previous build's caches on `activate`.

A build that cannot resolve the asset manifest fails rather than shipping a worker without its precache list. The worker never intercepts `/api`, so the page's poll of `GET /api/host` after an update is unaffected.

## Repo configuration

The default repo is `acdtrx/wisp`. To point at a fork (testing, mirror), set `WISP_UPDATE_REPO=<owner>/<repo>` in `config/runtime.env`.

## Update channels

A host picks which releases it is offered with `updateChannel` in `wisp-config.json` (`"stable"` | `"beta"`, default `"stable"`). It is set with `PATCH /api/settings` from the Wisp Update card (Host → Software), not from the Settings page.

| Channel | What the checker asks GitHub for |
|---------|----------------------------------|
| `stable` | `GET /repos/<repo>/releases/latest` — GitHub excludes prereleases server-side, so this is always the newest stable release. |
| `beta` | `GET /repos/<repo>/releases?per_page=15`, drafts dropped, then the **highest semver `tag_name`** among the rest (prereleases included). Not the newest by date: a stable cut published after a higher-numbered prerelease must not win. An empty list behaves like a repo with no releases — nothing to update to, not an error. |

Everything past that release object is shared between the channels: notes, `publishedAt`, tarball + sha256 asset discovery, and the `available` computation.

**The channel is read at check time** (settled 2026-08-25): every check reads the setting, and nothing pushes the channel into the checker. The UI PATCHes the setting and then POSTs `/api/updates/check`. Flipping the channel installs nothing by itself.

**Convergence.** `available` requires the latest version to be above the current one by full semver precedence — a prerelease sorts *below* the release it leads to. So a beta host running `2.2.0-beta.3` is offered `2.2.0` the moment it is cut, and beta and stable hosts land on the same version at every stable release.

**No downgrades** (settled 2026-08-25). Switching from beta back to stable while running a prerelease newer than the latest stable offers nothing: the check reports no update and the host waits for stable to catch up. Getting back to an older release is a manual operation (the `<install>.prev/` rollback below, or a reinstall).

## Tag convention

Releases use the `v` prefix (`v1.0.5`, `v1.0.6-rc.1`). The asset filename strips the prefix (`wisp-1.0.5.tar.gz`), for prereleases too (`wisp-2.2.0-beta.1.tar.gz`).

The release workflow detects prereleases by the presence of a hyphen in the tag: `v1.0.6` is stable, `v1.0.6-rc.1` is prerelease. GitHub's `releases/latest` endpoint excludes prereleases server-side, so a host on the stable channel never sees one; the beta channel reaches them by listing releases instead.

**A prerelease consumes no CHANGELOG section** (settled 2026-08-25). `release.sh` skips the retitle for a version carrying a `-prerelease` part, so the topmost `## YYYY-MM-DD` section stays unreleased across a whole beta series and the stable cut that follows retitles it — one batch, one set of release notes. The workflow's notes extraction then finds no section matching a `v*-*` tag and falls back to its built-in one-line `Wisp <tag>` note. The "topmost entry already has a release suffix" guard therefore fires on stable cuts only. Build metadata alone is not a prerelease: `2.2.0+build.1` takes the stable path.

## Active-jobs guard

`POST /api/updates/install` refuses to start while any other background job is running. The UI handles this with a confirm dialog that calls `?force=1` when the user explicitly chooses to proceed.

## An update is an install with a way back

(settled 2026-11-22.) Stop, copy, set up and start are written once, in `scripts/linux/install-tree.sh`, which lives in the tree being installed. The installer runs it for a first install, a manual upgrade and a push; the updater runs the staged tree's copy for an update, and the restored tree's copy on its way back.

- **The entry point's contract**: `install-tree.sh <source-dir> <install-dir> <deploy-user> <deploy-group>`, as root, holding `/run/wisp.lock` or taking it. Four phases, each announced as `phase: stop|copy|setup|start`: stop Wisp when it runs; copy the tree by the keep rule and give it to the deploy user; run the installed tree's setup; start Wisp and wait until it is ready. Exit `0` installed and ready, `1` Wisp did not stop (nothing changed), `2` the copy failed, `3` setup failed, `4` Wisp did not start. A TERM ends it: setup within its own stop bound, any other phase at once. With source and install the same folder, the copy is skipped.
- **It is the one thing an updater reads from the tree it installs**, so it is what stays stable from release to release: a later release may add phases or exit codes, and never changes the path, the arguments, what `0` means, or lengthens its stop. Everything else in a tree is free to change.
- **What the updater adds**: the lock, its own stop (so the copy it keeps is of a stopped install, and a Wisp that will not stop fails the update with nothing changed), the kept copy, the way back, and removing the staging folder and the target file on success.
- **The keep rule**, written once (`scripts/linux/setup/copy.sh`): `config/` holds the host's own files, which an install never deletes or overwrites, beside the tree's `*.example` files, which are replaced, a dropped one removed. Everything else in the install folder is the tree's: replaced, and removed when the new tree no longer has it, a file someone left at the top of the folder included. A persisted file of Wisp's own therefore lives in `config/` or outside the install folder. Each entry is copied beside its place and swapped in, so a copy that fails (a full disk) leaves the entry as it was.
- **Wisp's data never sits in the folder an install replaces.** The installer refuses an install folder that is, is inside, or holds `/var/lib/wisp` or `/mnt/wisp`; the settings refuse, when saved, a VMs, images, backups or containers path inside the install folder (422 `INVALID_SETTINGS`).
- **A host on v2.8.0-beta.1 or older does not update to this release by itself** (the user's choice, 2026-11-23: nothing is kept in a tree for the sake of an older updater). Its own backend refuses the download before its updater starts (`UPDATE_CHECK_UNAVAILABLE`, "Staged tree version mismatch"), with nothing changed. It is updated once by hand ([DEPLOYMENT.md → Manual upgrade](DEPLOYMENT.md#manual-upgrade)), and updates by itself from then on.

## The updater updates itself one release late

Setup replaces `/usr/local/bin/wisp-updater` atomically, so the **currently running** updater keeps executing its old copy to completion. A release that changes `wisp-updater` therefore ships the new script but runs the old one — the change only takes effect on the *next* update.

- **A new step does not run on the release that introduces it.** Verify it on the release after, by its `step:` line, not just `step:done`.
- **Never make a release depend on its own updater changes** for correctness.
- **Put new work in the install or in setup.** The updater runs `install-tree.sh` from the staged tree, and that runs the installed tree's setup, so both are always the *new* release's copies: a step added there takes effect on the very next update. Keep `wisp-updater` thin.
- There is never a reason to delay an updater change to a later release: postponing it only postpones its activation by the same amount.

## Health-gated start

`wisp.service` is **`Type=notify`** (settled 2026-11-18): the backend tells systemd it is ready once it listens — after its state migrations and its boot work (mounts, container autostart) — by running `systemd-notify --ready` (`NotifyAccess=all`, since the sender is a child of node). So `systemctl start wisp` is the gate, read from the service and from nothing of Wisp's own:

- it waits while the new backend is alive and still starting, however long its migrations take, up to the unit's `TimeoutStartSec=15min`, which sits inside the updater unit's 30 min;
- it returns success once the backend is ready;
- it fails as soon as the backend exits first — a failed migration or an invalid config ends the start within seconds — and on the timeout, when systemd stops the hung start.

The install's `phase: start` is that call. On failure it prints the service's last lines and exits `4`, and the updater rolls back; on success the updater drops the staging dir and the target marker and prints `step:done`. The installer and `wispctl svc start|restart` wait the same way, and on a failure print the service's last log lines and exit non-zero.

A start that fails is retried by systemd with a growing delay (`Restart=on-failure`, `RestartSec=5`, `RestartSteps=6`, `RestartMaxDelaySec=5min`): a transient cause heals by itself, a permanent one stops filling the log. The counter behind that delay is not reset by the service running well in between: crashes weeks apart keep lengthening it; a manual `systemctl start` or `restart` resets it. Boot counts as finished only once Wisp is ready: `multi-user.target` waits for its start. Without `NOTIFY_SOCKET` (the macOS dev backend) the backend sends nothing.

## Rollback

After a successful update, the old install tree is kept at `<install>.prev/` (one-deep). The `wisp-updater` script restores from there automatically if any step after the snapshot fails — including the run being stopped by `TimeoutStartSec` (the TERM is turned into a non-zero exit so the rollback fires).

What an automatic rollback restores (settled 2026-10-16):

| Failure point | Restored |
|---------------|----------|
| `step:stop-service` (settled 2026-11-20) | Nothing to restore: a `wisp.service` that does not stop within the updater's bound fails the update before anything is changed — no snapshot, no swap. The rollback then only stops it again, runs `daemon-reload` and starts it, as it begins and ends every rollback (below). |
| The copy is kept, the install fails in its copy | The install tree only. Nothing host-level has changed yet. |
| The install's setup or start | The install tree, then **`step:rollback-install`**: the restored (old) tree's own install runs, its setup first — re-installing its backend dependencies, `wisp-*` helpers, their sudoers rules, `wisp-updater` + `wisp-updater.service`, the container-DNS host config and `wisp.service`. |

**Restored with the tree: `config/` and the migration ledger** (settled 2026-11-13). The restore rsync brings back all of `config/` from the snapshot — `wisp-config.json`, `runtime.env` and `config/migrations.json` together — so every migration the new backend's start ran runs again at the next start of a release that ships it. What the state migrations changed outside `config/` (domain XML, `container.json`, file modes) is not undone — see [State migrations → Failure and rollback](#failure-and-rollback).

**A tree that was not restored is neither set up nor started** (settled 2026-11-19). When the restore rsync fails or runs past its bound, the tree may be part old, part new, so the install it would run could be the new release's: the rollback ends there, with a `rollback-warning:` that says the tree was not restored and names the manual finish below. This is the one exception to the rollback carrying on (see Limits).

In every other case the rollback **begins** with `systemctl stop wisp` — after a failed start the new backend may be cycling through `Restart=on-failure`, and the tree may not be restored under it — and **ends** with the old release running: by the restored tree's own install (its setup, then its start), and, when that install failed or ran past its limit before Wisp was up, by a `systemctl start wisp` of the updater's own, given 120 s (settled 2026-11-22: a rollback always ends by starting the release that ran before, whatever its setup did). That final start is not retried and fails nothing: the restored release is what ran before, there is nothing further to fall back to, and the rollback must finish. A start not done by then is reported as a `rollback-warning:` with the unit's state, and left to systemd.

Limits, by design:

- **What the failed release added goes** (settled 2026-11-22). The restored release's setup installs exactly its own set of helpers and sudo rules and removes any other `wisp-*` ([DEPLOYMENT.md → The helpers](DEPLOYMENT.md#the-helpers)). What stays: packages setup installed or upgraded, a bridge it made, and what the state migrations changed outside `config/`.
- **After a rollback the staged tree and the target file stay** under `/var/lib/wisp/updates`, and the rollback's last line says so; a new download of that version replaces them (backlog).
- **No retry inside the rollback.** The rollback runs from the `EXIT` trap and, but for a failed restore (above), never aborts: each step that fails logs a `rollback-warning:` line and the rollback carries on to starting the service. An install that fails inside it says that the helpers, sudo rules, units and the backend's dependencies may still be the new release's.
- **Stops and bounds** (settled 2026-11-19).
  - `wisp-updater.service` has `KillMode=mixed`: on its start timeout systemd sends TERM to the updater alone, which passes it on, and then rolls back. Its EXIT trap's first action is to let TERM and INT no longer cut the rollback short.
  - Each layer owns its own bound:
    - every command the updater runs is the leader of a session of its own, signalled as a whole session (so `timeout`'s own process group too) and waited for until the session is empty;
    - every step setup runs is the leader of a session of its own too, but is sent a stop alone and stops what it runs itself, and setup waits until its session is empty.
  - The updater sends setup a TERM alone and waits for it to end, and never kills it. Setup guarantees its own end: its step gets setup's step stop bound (the bridge step's undo, every bound in it run out), then its session is killed. The updater holds no copy of setup's numbers: the updater that runs is always one release older than the setup it stops.
  - Every other command the updater runs has the updater's own bound, past which its session is killed. The rollback's setup has a limit of the updater's, past which it is sent TERM and waited for in the same way.
  - The stop budget, `TimeoutStopSec` (**2100 s**), is the backstop, and covers the honest worst case: the stopped install ending (its setup within setup's stop bound, any other phase at once), then the whole rollback: the stop, the restore, the old release's install with setup's stop bound counted again, and the updater's own last start.
  - `npm run check` computes that sum from the numbers where they live (setup's bounds file, the updater, the unit). It fails when `TimeoutStopSec` is below it, or when the frontend's wait for an update is not the unit's start timeout plus its stop budget.
  - `KillMode` is not `control-group`: systemd would send TERM at once to every process of the unit, cutting the running step's children short before the step can end in order.
- **Stopping the backend** (settled 2026-11-20). The updater's bound on `systemctl stop wisp` covers systemd's own stop of it — `wisp.service`'s `TimeoutStopSec` for the TERM, the same again after the KILL — and a margin past that, so its "did not stop" never races systemd's second wait; `npm run check` fails when it does not.
- **The updater unit's budgets are never lowered by a later release** (settled 2026-11-19). From the `daemon-reload` inside setup's `helpers` step, which installs the new `wisp-updater.service`, the limits in force are the new release's while the old release's updater code runs; a lower `TimeoutStartSec` or `TimeoutStopSec` would cut short a rollback written for the old numbers.
- **Finishing a failed rollback by hand** — `journalctl -u wisp-updater` names the step that warned; then, as root: `rsync -a --delete <install>.prev/ <install>/`, `chown -R <deploy-user>:<group> <install>`, `<install>/scripts/linux/install-tree.sh <install> <install> <deploy-user> <group>` (its setup, then its start).

The rollback logic lives in `wisp-updater` itself, so a change to it is dark-shipped like any other updater edit: the release that carries it is still rolled back by the previous release's logic.

There is no UI for explicit user-initiated rollback; if needed, run the same "by hand" sequence above.

## State migrations

State an earlier release wrote — libvirt domain XML, `container.json`, config and data-file modes — is brought up to the schema the current code targets by **state migrations** (policy: `CODING-RULES.md` §16). Two decisions shape them:

- **The backend runs them at every start, and nothing else does** (settled 2026-11-18). Before it reads stored state for any other purpose, starts a workload or answers a request, so every way of starting newer code meets migrated state: an update, a manual upgrade, a stop and a start, a dev push, a config restored from an older copy. The updater, the installer, the setup steps and `wispctl` hold no migration step, and no command runs them on demand (a migrate command, or a restart that also migrates, would leave a way to start newer code on unmigrated state): what ran is in the ledger and in the start's log.
- **An ID ledger, not version ranges.** Each migration has a stable id; the ledger records which ids ran on this host. Version ranges break on the beta channel, on rollbacks and on re-installs.

### When they run

- **Every start of the backend**, `wisp.service` and the dev backend alike, in the start's order ([ARCHITECTURE.md → Run shape](../ARCHITECTURE.md#run-shape)): `runtime.env` loaded, then the pending migrations, then the strict config checks, then the managers, the app, the boot work, and the port last.
- **A start that cannot migrate does not serve.** A failed migration ends the start before its port opens: the log names the migration and the reason (`Failed to start: state migration <id> failed: <reason>`) and the process exits 1. The next start, systemd's restart included, runs it again. A config still invalid once the migrations have run ends the start the same way.
- **A start with nothing pending costs a ledger read**: the migration file names and the ledger are read, and neither manager is connected for them.
- **As the deploy user, never root.** The service runs as the deploy user, which owns the install tree and has libvirt and containerd access. A start as root that would write — a migration pending, or no ledger yet — refuses with `state migrations must run as the deploy user, not root: files they write as root would be unreadable to wisp.service` and exits 1, before anything runs.
- **macOS dev:** the managers are stubs — migrations see no workloads.

### Runner

- **Config before the migrations.** The start has loaded `runtime.env` strictly, except for the lines setting the retired `WISP_BACKEND_PORT` / `WISP_FRONTEND_PORT` (they are not loaded from the file), and checked every `WISP_*` value; and an installed Wisp has refused `WISP_CONFIG_PATH` (`CONFIG_PATH_NOT_ALLOWED`, [CONFIGURATION.md → Password Storage](CONFIGURATION.md#password-storage)), so on a host the migrations work on `config/`. For the migrations `wisp-config.json` is read **tolerantly**: only the storage paths, `mounts` and `backupMountId`, a missing or wrong-typed path taking its default, because an older release's file is repaired for the strict reader by a migration. It must still be JSON: a file that isn't is a setup error naming it.
- **The managers** are configured with that tolerant reader and connected with `watchEvents: false`: no libvirt DomainEvent or containerd events subscription, no reconcile timers, so no container restart policy, no network reconciler and no list caches (list calls read live state). Once the migrations are done they are disconnected, and the start configures them with the strict reader and connects them with events for normal work. A failed libvirt / containerd connection is a warning; a migration that then needs that manager fails on its error.
- **The strict check after the migrations.** Once they have run — or with none pending — the start checks the config as it always has: `runtime.env` parsed strictly, retired keys included; `wisp-config.json` through the strict schema ([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)); `config/wisp-password` readable and in its `scrypt:` form; `WISP_DEFAULT_BRIDGE` naming a host bridge. A config still invalid ends the start.
- **No `ok` without having seen the state** (settled 2026-10-16). Connected this way, `listVMs()` and `listContainers()` return the complete, real list or throw. `listVMs()` throws `NO_CONNECTION` when libvirt is not connected and `LIBVIRT_ERROR` naming the domains it could not read; `listContainers()` throws `NO_CONTAINERD` when containerd is not connected, `CONFIG_ERROR` for an unreadable containers directory and the task lookup's own error (a missing directory is no containers; a directory without a parseable `container.json` is not a container). So a migration over every VM or container fails — and the start with it — instead of recording `ok` over a list it never saw. There is no "not installed" exemption: setup installs and enables both libvirt and containerd on every host, so an unreachable daemon is a fault to fix. The connection itself still only warns: a migration that needs neither manager runs regardless.
- **Reads never write** (settled 2026-10-16; the backend's normal work too since 2026-11-12). No manager read writes stored state: data an earlier release or bug left behind is repaired by a migration (`CODING-RULES.md` §16), and the writes that belong to the normal lifecycle are made at the event that causes them ([VM-MANAGEMENT.md](VM-MANAGEMENT.md#restart-required-flag), [CONTAINERS.md](CONTAINERS.md#config-changes-that-need-a-restart)). Those events are wired only with event watching, so none of them happens while the migrations run. The only state changes the migrations make are their own, each recorded with `recordChange`.
- **Files:** `backend/migrations/NNNN-short-name.js` (ESM, named exports `id` — equal to the file name without `.js` — `description`, and `async run(ctx)`), run in id order; subdirectories are not read (`lib/`, the migrations' shared code; `test/`, their unit tests). A `.js` file not named that way, one that cannot be loaded (its file and the reason are named), an id mismatch or a missing export is a setup error: nothing runs. The release ships the directory (holding `.gitkeep` when empty); a missing directory is an error, never "no migrations".
- **Pending** = every shipped migration without an `ok` ledger entry. After each one the ledger is written. A migration fails when it throws or rejects, whatever it throws — a rejection with no reason included. The first failure is recorded as `error`, later migrations do not run, and the start ends. Setup errors end the start too, before any migration runs: a bad migration file, an unreadable or malformed ledger (not JSON, no `applied` array, an entry that is not an object with a string `id`), a config that isn't JSON, a run as root that would write. A clean run creates the ledger if it did not exist.
- **Logging:** through the backend's logger (`journalctl -u wisp` in production): `state migrations: none pending` or `state migrations: N pending` with their ids, then per migration `running: <description>`, a line per change carrying `migration`, and `migration done` or `migration failed — later migrations not run` with the error.

### Ledger (`config/migrations.json`)

```json
{ "applied": [ { "id": "0002-vnc-listen-localhost", "at": "<ISO time>", "result": "ok", "changes": ["…"] },
               { "id": "0003-…", "at": "…", "result": "error", "changes": [], "error": "<message>" } ] }
```

Beside `wisp-config.json` (it follows `WISP_CONFIG_PATH`, as `wisp-password` does, in development and tests only: an installed Wisp refuses the key — [CONFIGURATION.md → Password Storage](CONFIGURATION.md#password-storage)), mode `0600`, atomic writes, gitignored. One entry per id: rerunning a failed id replaces its `error` entry. Entries for ids a release no longer ships are kept. An update keeps it, as it keeps all of `config/` (the keep rule), and a rollback restores it with the rest of `config/` (settled 2026-11-13). Forcing a migration to run again means deleting its entry by hand; the next start runs it.

### Failure and rollback

A failing migration ends the new backend's start, so under the updater the install's start phase fails within seconds and the updater rolls back (tree, `config/`, host setup). The rollback restores `config/` and the ledger together (settled 2026-11-13): what a migration changed in `config/` is reverted with its ledger entry, and every migration that start ran runs again at the next start of the newer release — safe because migrations are idempotent. What they changed outside `config/` stays, which is why that state must stay backward-compatible: the restored release runs on it. The restored release then migrates at its start, against the restored ledger, and finds nothing pending.

### Authoring a migration

- **Idempotent** — safe to run again; a no-op on a host already in the target state (fresh installs just record it).
- **Backward-compatible state** — leave state the previous release still accepts; a rollback does not undo what a migration changed outside `config/`.
- **`config/` may change** (settled 2026-11-13) — a migration may edit `wisp-config.json` or `runtime.env`, reading them raw: a rollback reverts them and the ledger together, so the migration runs again next time. Only `config/` in the install dir is in the snapshot, and on an installed Wisp it holds `wisp-config.json`, the ledger and `wisp-password`: the start refuses `WISP_CONFIG_PATH` (settled 2026-11-20). Read the config tolerantly (`ctx.getConfig()`), never through the strict reader, so an older release's file can't fail a migration that runs before it is repaired.
- **Through the managers** — change state via `ctx.vmManager` / `ctx.containerManager` (e.g. XML edits through vmManager's XML handling), never text substitution or direct file writes into a manager's files.
- **Log every change** via `ctx.recordChange`.
- **Leave nothing behind in the process** — migrations run inside the backend that goes on to serve: a migration ends with no subscription, timer, listener or open handle of its own, and changes no module or manager state beyond its recorded writes (no `configure()`, no connect or disconnect, no cached value set).
- **Restart flag only on a running workload** whose change needs a restart; a stopped workload picks the change up on its next start.
- **Deploy-user scope** — root-level host changes do not belong here; they stay in `common-steps.sh` as idempotent convergence.
- **Never renumber or rename** a shipped id — the ledger keys on it.

### Shipped migrations

The migrations are the files in `backend/migrations/`; each names what it brings up to date in its `description`. What a reader of the other specs needs to know of them:

- `0007-repair-config-and-records` repairs what older releases wrote, so the strict readers accept it: retired keys in `runtime.env` and `wisp-config.json`, mounts outside `/mnt/wisp/`, old `container.json` shapes, backup manifests without an `origin` ([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)).
- The migrations over backups (`0005`, `0006`, `0007`) cover the backup roots the backend lists when they run: an unmounted backup mount is skipped with a warning.
- `0009-backup-status-error-code`: in a failed backup attempt record the key `error` always holds a code ([BACKUPS.md → Backup attempt status](BACKUPS.md#backup-attempt-status)). The file and the ledger are in the rollback's snapshot (`config/`), so a rollback reverts both.
- The ids skip `0010`, which an unreleased migration used and dev hosts' ledgers still record.
- `0012-vm-profile` (settled 2026-11-21): every VM without a profile gets one, from what its saved definition holds: `windows-11` with Hyper-V features, else `linux`. A domain that is not persistent is left without one.
- `0013-cloud-init-key-source` (settled 2026-11-21): every `<vmsPath>/*/cloud-init.json` loses `sshKeySource`. The file keeps its mode and is written atomically; the seed ISO is not touched.
- `0014-retire-helper-path-overrides` and `0015-retire-cni-dir-overrides` (settled 2026-11-22): `runtime.env` loses the five `WISP_*_SCRIPT` lines, `WISP_CNI_BIN_DIR` and `WISP_CNI_CONF_DIR`. Other lines, comments and the file's mode stay.
- `0016-canonical-mount-forms` (settled 2026-11-22): every stored mount gets its `mountPath` in canonical form and its `share` as `//host/share[/folder]`. A share that cannot be brought into form is left as it is and reported.

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) The GitHub releases API: **30 s** per request, its DNS lookup and body included. The release tarball download (through the SSRF guard): connect **10 s**, response headers **30 s**, and **120 s** between body chunks — an idle bound, no total (settled 2026-11-13). Unpacking it: **60 s** without progress (tar's checkpoints), no total (settled 2026-11-13). Starting `wisp-updater.service` **15 s**.

The install runs as a server job (settled 2026-11-13), its progress (download, verify, unpack) on the job's stream until Wisp restarts. In setup's backend-dependencies step, which the updater runs, `npm ci` is stopped after **10 min** without output (it logs each fetch), under the unit's **30 min** backstop (settled 2026-11-13); `npm ci` runs in a process group of its own, and the stall kills the whole group.
