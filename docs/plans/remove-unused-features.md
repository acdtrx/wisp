# Plan — Remove unused VM features

**Created:** 2026-10-16. **Status:** implemented and merged to main; verified on the test server (tini) 2026-10-16 — removed routes 404, VM create/delete (BIOS + UEFI), delete with `virsh` snapshots, backup + restore-as-new incl. a backing chain, container restore-in-place, rename, operation lock.

## Goal

Remove four features the user doesn't use and that keep producing bugs (most recently the
2026-10-16 audit and re-review: V19, V1/V2 of the re-review, the snapshot `.mem` naming fix, the
restore-in-place staging/lock/snapshot-refusal work, the legacy-layout delete wipe V7). Smaller
surface, fewer interacting edge cases. Applies CLAUDE.md "Features earn their place".

## Decision (user, settled 2026-10-16)

Remove:
1. **VM snapshots** — create, list, revert, delete; memory files; snapshot UI.
2. **VM cloning.**
3. **Legacy backup layout** — the old `<dest>/<vm>/<ts>` folder layout (only `<dest>/vms/<vm>/<ts>`
   and `<dest>/containers/<name>/<ts>` remain).
4. **VM restore-in-place** (restore-as-new stays; container restore-in-place stays).

Kept (considered and rejected for removal): container rename, multiple backup destinations.

## State on the user's hosts (checked 2026-10-16)

- No VM on wisp or tini has a libvirt snapshot.
- No legacy-layout backup exists on any backup root (local or SMB) on wisp or tini.
- So removal strands nothing; no migration is needed (policy: migrations bring released state up
  to the current schema — there is none to bring).

## Keep (deliberately)

- **VM delete tolerates libvirt snapshot metadata** (a VM given snapshots outside Wisp, e.g. via
  `virsh`, must still delete cleanly — keep the undefine flags).
- **Backup flattening of backing chains (V19)** — a disk can have a backing chain without Wisp
  snapshots (library images, `virsh` snapshots), so backups stay complete. Rename's path rewrite
  of backing files, if any, stays only where it serves non-snapshot chains.
- **The per-VM operation lock** — still covers start, delete, backup, rename.

## Scope of removal (implementer verifies with grep; this list is a starting point)

- Backend: `vmManager/linux/vmManagerSnapshots.js` and its facade exports; snapshot routes in
  `routes/vms.js`; snapshot handling in rename (`.mem` path rewrite), deleteVM (keep metadata
  tolerance), stats/list fields if any; `cloneVM` + clone route + clone job store/progress route;
  `restoreBackupInPlace` + the VM restore-in-place route + its safety-backup path +
  `assertNoSnapshots` / `VM_HAS_SNAPSHOTS`; legacy-layout fallbacks in backup resolve/list/delete;
  MCP tools exposing any of these; error codes no longer reachable (routeErrors, ERROR-HANDLING).
- Frontend: snapshot section/panel, clone dialog/button, VM restore-in-place UI in BackupsPanel
  (container restore-in-place stays), job kinds / background-job titles for removed jobs, store
  actions.
- Docs: delete `docs/spec/SNAPSHOTS.md`; update VM-MANAGEMENT.md, BACKUPS.md, API.md, MCP.md,
  UI.md, ERROR-HANDLING.md, ARCHITECTURE.md, backend/src/lib/CLAUDE.md; record the decision
  (settled 2026-10-16) in VM-MANAGEMENT.md / BACKUPS.md; drop now-moot BACKLOG entries;
  CHANGELOG (new dated section): "Removed" lines.
- Dead code: anything only these features used (helpers, constants, tests harness hooks).

## Steps

1. Snapshots. 2. Cloning. 3. VM restore-in-place. 4. Legacy backup layout. One commit each, in one
worktree (the four overlap in `vmManagerBackup.js`, `routes/vms.js`, `BackupsPanel.jsx`).

## Verification

- `npm run check-imports`, frontend build, `npm run route-access` (no undeclared routes; removed
  routes gone).
- darwin: UI has no snapshot/clone/restore-in-place affordances (harness or dev stack); API returns
  404 for the removed routes.
- Linux (tini, via the self-updater): create/start/stop/delete a VM; VM backup + restore-as-new;
  container backup + restore-in-place still work; deleting a VM that has a `virsh`-made snapshot
  still succeeds; backups list/delete normal-layout backups.
