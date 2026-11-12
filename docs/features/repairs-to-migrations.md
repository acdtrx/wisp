# Repairs to migrations

**For:** CODING-RULES §16 — data left by a past bug is repaired by a migration, never by
code in the normal path. The backend still repairs on read (`repairOnRead` in
`connectManagers`, `backend/src/lib/managerBootstrap.js`). Closes the backlog entry "Move
the normal path's repairs into migrations".

**Scope:** every write the normal path makes to repair stored data an earlier release or
bug left behind. Known today: the stale restart-flag clearing (VMs and containers), the
`container.json` env-shape, network-type and MAC rewrites, and persisting a
netns-discovered IP in `getContainerConfig`. Look for others beyond `repairOnRead` too.

Sort each write into one of two kinds:
- **Repair of past data** — becomes a migration under `backend/migrations/`, and the
  normal-path code goes.
- **Normal lifecycle** (e.g. a restart flag a VM outgrows when it restarts) — stays, but
  is made at the event that causes it, not on a read. Send each one of these back to the
  design session as a decision before changing it: it is a contract change.

Once nothing is left behind it, remove the `repairOnRead` option.

**Specs changed:**
- `specs/UPDATES.md` → State migrations, "Reads never write": drop the `repairOnRead`
  wording and the backlog pointer. Reads never write in the backend either.
- `specs/VM-MANAGEMENT.md` (`resolveVMPendingRestart`) and `specs/CONTAINERS.md`
  (restart-required flag): where the flag is cleared, if that moves.
- `ARCHITECTURE.md`: the migration runner's `connectManagers` options.

## Milestone 1 — inventory

The builder lists every normal-path repair found, with its file and line, its kind, and
the migration or event it moves to. Then it reports to the design session.

- **Acceptance:** the list is sent. Every write reachable from a read path in
  `vmManager` / `containerManager` (including `getContainerConfig` and the list refresh)
  appears in it or is ruled out.

## Milestone 2 — move them

- **Acceptance:**
  - `grep -rn repairOnRead backend/` finds nothing.
  - Each new migration passes `backend/scripts/migrate.mjs --dry-run`, then a real run,
    on the Linux test host. The real run records its changes; a second run is a no-op.
  - After the migration, a backend restart and loads of the VM and container lists and
    detail pages leave every `container.json` and domain XML byte-identical
    (checksummed before and after).
  - A running VM and a running container with a pending restart, then restarted, show
    the flag cleared.
  - `npm run check-imports` passes.
