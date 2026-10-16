# Plan — State migrations on update

**Created:** 2026-10-16. **Status:** approved by the user (design below), implementation pending.

## Goal

Bring state that earlier Wisp releases wrote (libvirt domain XML, `container.json`, config and
data-file modes) up to the current schema automatically during an update, instead of listing
manual cleanup steps in the CHANGELOG. Make any restart a migrated change needs visible in the UI.

## Decisions (user, settled 2026-10-16)

- **Runs as part of the update process**, not at backend startup.
- **Tracked by an ID ledger**, not by version ranges: each migration has a stable id; the ledger
  records which ids ran on this host. Version ranges break on beta channels, rollbacks and
  re-installs.
- **Code still targets only the current schema.** No dual-read of deprecated keys or shapes; the
  migrations are what bring old state up to it. The "no migrations" rule in CLAUDE.md is dropped;
  the rest of that section (current-schema-only code, corrective repair is normal engineering)
  stays.
- **Restart-required flag on VMs and containers**, set by a migration (and by config edits) when a
  running workload needs a restart for the change to apply, and shown in the UI.

## Scope

1. A persisted restart-required flag for VMs (containers already have `pendingRestart`).
2. The migration runner, ledger and update-pipeline hook.
3. The first migrations from the 2026-10-16 audit.
4. Policy and contract docs.

**Out of scope:** UI for migration history (journal + ledger are enough for now; revisit if the
user asks "what did the last update change?"), down-migrations, host-level (root) changes — those
stay in `common-steps.sh` as idempotent convergence.

## Design

### Restart-required flag

- **Containers:** reuse `pendingRestart` (already persisted in `container.json`, cleared on start,
  shown as "Restart required"). Expose a manager function to set it so migrations don't write
  `container.json` directly.
- **VMs:** persist `pendingRestart` in Wisp's domain metadata (`wisp:prefs`, inactive XML) so it
  survives reloads and Wisp restarts. Set it when `updateVMConfig` returns `requiresRestart` on a
  running VM, and from migrations; clear it when the VM starts (DomainEvent STARTED — a guest-side
  reboot doesn't restart QEMU, so it correctly stays set). Surface it in the VM list/detail payload
  and show the same "Restart required" badge as containers (VM header + list item), replacing the
  per-section, session-only `requiresRestart` state.
- A migration sets the flag only on a workload that is running when it changes it; a stopped
  workload picks the change up on its next start.

### Runner

- **Files:** `backend/migrations/NNNN-short-name.js`, each exporting
  `{ id: 'NNNN-short-name', description, run(ctx) }`. Run in id order.
- **Context:** `ctx` gives the configured managers (vmManager, containerManager — connected to
  libvirt/containerd the same way `index.js` does), config access, paths, a logger, and the
  restart-flag setters. Migrations change state through the same code paths as the app (e.g. the
  VNC listen change goes through vmManager's XML handling, not text substitution).
- **Ledger:** `config/migrations.json` — `{ applied: [{ id, at, result, changes }] }`. Must be on
  the updater's preserve list.
- **Contract for every migration:**
  - **Idempotent** — safe to run again; a no-op on a host already in the target state (fresh
    installs just record them).
  - **Backward-compatible state** — leaves state the previous release still accepts, because a
    failed update rolls back the install tree but cannot undo a migration.
  - **Logs each change** (e.g. `dubi: VNC listen 0.0.0.0 → 127.0.0.1 (restart required)`).
- **Failure:** the runner records what succeeded, stops at the first failure and exits non-zero;
  the update then fails and rolls back the tree. Already-applied migrations stay applied and
  recorded.
- **Entry point:** `backend/scripts/migrate.mjs`, run as the deploy user (it has libvirt and
  containerd access; root-only work belongs in `common-steps.sh`). darwin/dev: managers are stubs,
  migrations see no workloads and no-op.

### Where it runs in the update

At the end of `scripts/linux/setup/common-steps.sh` (as the deploy user, via `sudo -u`). The
updater that runs an update is the previously installed one, so a new step in `wisp-updater`
would take effect one release late; `common-steps.sh` comes from the new tree and already runs
on every update (`step:common-setup`, after `install-deps`, before `install-unit`/`start-service`)
and on fresh installs (`setup-server.sh`). Its failure already triggers the updater's rollback.
The backend is stopped at that point, so migrations don't race the running app.

## Steps

1. **VM restart-required flag** — metadata field, set/clear paths, payload, UI badge; replace the
   per-section transient state; container setter exposed for migrations.
2. **Runner + ledger + hook** — `migrate.mjs`, `backend/migrations/`, ledger, preserve list,
   `common-steps.sh` hook, `install.sh`/`push.sh` paths covered via common-steps.
3. **First migrations** (`0001-pending-restart-timestamp` shipped with step 1):
   - `0002-vnc-listen-localhost` — every VM whose inactive `<graphics>` listens on anything other
     than `127.0.0.1` (attribute and `<listen address>` child) → `127.0.0.1`; restart flag if
     running.
   - `0003-cloud-init-json-mode` — `chmod 0600` every `cloud-init.json`.
   - `0004-app-secret-file-modes` — app-declared secret files (tiny-samba passwords, zot
     `htpasswd`/`session-keys`) to the strictest mode the container can still read through its
     idmap — confirm on the test server first; drop the migration if the container can't read it.
     Confirmed 2026-10-16 on tini: tiny-samba (runAsRoot, idmapped mount) starts, reloads and
     authenticates SMB logins with `tiny-samba-passwords` at `0600`; so `0600`, and containerApps
     now writes declared secret files `0600`.
4. **Docs** — CLAUDE.md policy section rewritten ("Migrations"); `docs/spec/UPDATES.md` contract
   (ledger, preserve list, step order, rollback semantics, authoring rules); VM-MANAGEMENT.md /
   CONTAINERS.md / UI.md for the restart flag; CHANGELOG manual-cleanup lines for V1/V13 replaced
   by "applied automatically on update".

## Verification

On the test server (tini), through the real self-updater:
- Start from a build without migrations; gubi still has `listen='0.0.0.0'`; dubi running.
- Update → journal shows the migrate run inside `step:common-setup`; gubi's inactive XML now
  `127.0.0.1`; a running VM shows "Restart required" in the UI and the flag clears after a
  stop/start; `config/migrations.json` lists the ids.
- Update again → nothing re-runs (ledger), no changes logged.
- A deliberately failing migration in a test build → update rolls back, ledger keeps the ones
  that ran, previous release starts and works with the migrated state.
- Fresh-install path (`install.sh` on a clean VM if available): migrations run as no-ops and are
  recorded.
