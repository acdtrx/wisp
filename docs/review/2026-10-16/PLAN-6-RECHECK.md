# Fix Plan 6 — Re-review follow-ups (before the next release)

**Source:** [`RECHECK.md`](RECHECK.md). **Created:** 2026-10-16. Conventions as in
[`PLAN-1-SECURITY.md`](PLAN-1-SECURITY.md) § Shared conventions (one Opus agent per bundle in a
worktree; main session integrates and verifies on the test server via the self-updater).

Moot after the feature removal (`docs/plans/remove-unused-features.md`): V1, V2, V7, the snapshot
and restore-in-place parts of V5. Done: A1 (OIDC session-only).
Backlogged by the user: **P2** (OS upgrade runs inside wisp.service) — "never happened, upgrades
are manual"; revisit if an upgrade is ever interrupted or upgrades become unattended.

## B1 — Secrets and untrusted input
- **C1** — `container.json` written 0600, container dirs 0700, container backup archive + manifest
  0600; migration `0005-container-config-modes` tightens existing files (and backup files under
  every backup root). Confirm the container (idmapped / runAsRoot) never needs to read container.json
  itself.
- **V3** — VM restore validates the backup's `domain.xml` before defining: every disk/CD-ROM/NVRAM
  source must be remapped into the new VM dir or be an image-library path; reject `lun` disks,
  `<hostdev>`, `<filesystem>`, `<qemu:commandline>`/qemu namespace; payload files must be regular
  files (lstat, no symlinks).
- **V4** — library images: `qemu-img info -f <fmt> --output=json` before convert/attach/resize;
  refuse a backing file, non-qcow2/raw formats; always pass `-f`.

## B2 — Container runtime
- **C2** — per-container operation lock (glue, mirrors the VM lock) for start/stop/restart/delete/
  rename/backup/restore and app-config saves; the restart-policy start takes it; lost race → 409
  `CONTAINER_BUSY`.
- **C3** — live log stream: serialize reads, set the offset from the history read, buffer partial
  lines (no duplicates, no gaps).
- **C4** — short image refs: normalize in PATCH and MCP the same way as create; use the pulled ref.

## B3 — Frontend
- **F1** — container console: reconnect counter not reset on each attempt (only on a real session),
  4000 close is final, `exit` doesn't respawn a shell, session-expired path works.
- **F3** — container command: edit as a list of arguments (or shell-style quoting), shown the same
  way it's parsed; API-set commands round-trip unchanged.

## B4 — Migrations and update safety
- **P3** — `listVMs`/`listContainers` throw `NO_CONNECTION` when not connected (at least in runner
  mode); per-domain fetch failures surface; migrations can't record `ok` without having seen state.
- **P5** — runner loads `runtime.env` before config resolution.
- **P15** — `--dry-run` is side-effect free (read-only accessors for migrations).
- **P1** — updater gates `step:done` on a health check (service active + local API answers within
  N s); failure → rollback (one release late, like every updater change).

## B5 — VM operation lock coverage (rest of V5)
- Per-VM lock on disk attach/detach/resize/bus, non-rename PATCH, cloud-init edits; rename reserves
  the target name (no race on the target dir).

## Verification
Frontend build, `check-imports`, `route-access`; darwin harnesses per bundle; then the integrated
branch on tini through the self-updater (C1 migration run + file modes, VM restore with a tampered
domain.xml refused, crafted backing-file image refused, container lock 409, log stream, short image
ref, console behaviour, command round-trip, migration with libvirt unreachable → recorded error,
updater health-gated rollback with a deliberately broken build).
