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

**Settled after the inventory (2026-11-12):**
- **VM restart flag:** cleared by one vmManager mechanism on libvirt connect and on the
  STARTED DomainEvent, wired only with `watchEvents`. Reads apply the rule but never
  write. `VM-MANAGEMENT.md`'s "cleared lazily" wording and its rejected alternative
  change to match.
- **Container restart flag:** cleared in `startExistingContainer` after `Tasks.Start`,
  in the same latest-config read `flagEditsMissedByStart` does. This reverses
  `CONTAINERS.md`'s "starting a container never clears the flag directly".
- **Netns IP persisted on GET:** dropped with no replacement; the network probe saves a
  missing IP. The `API.md` sentence about it goes.
- **Migration `0007-container-config-shape`:**
  - over every container: env to `{value}`, a missing env becomes `{}`, a missing or
    non-bridge network becomes bridge, a missing or invalid MAC is generated,
    `network.vlan` is removed;
  - it flags a restart only on a running container whose network changed;
  - the old-shape knowledge lives only in the migration, which writes through generic
    facade exports (`readContainerConfig`, `generateContainerMac`,
    `writeContainerConfig`).
- **PATCH `network.type`:** anything but `'bridge'` → 422 `CONFIG_ERROR` (an `API.md`
  line).
- **Old container backups** restore the shape they hold; no restore code changes.
- **Spec edits that follow:** `CONTAINERS.md` (the MAC and env lines point at 0007),
  `API.md` (the two lines above), and `UPDATES.md` Shipped migrations (rows for 0005,
  0006 and 0007).
- **Also in scope:**
  - remove the manager facade exports nothing uses (`ensureContainersDir`,
    `notifyContainerConfigWrite`, and any others found);
  - remove the old-shape tolerances in reads: a backup manifest without `origin`,
    restart flags not in the `{since}` shape, and the cloud-init `'set'` sentinel. Send
    back any one that is still reachable through stored data or API input;
  - simplify the remaining `network.type === 'bridge'` guards once 0007 and the PATCH
    check land.

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
