# Fix Plan 2 — Data safety

**Audit:** [`AUDIT.md`](AUDIT.md). **Created:** 2026-10-16. Conventions: see
[`PLAN-1-SECURITY.md`](PLAN-1-SECURITY.md) § Shared conventions.
**Goal:** no Wisp operation can silently overwrite, delete or half-write user data, and no
stream error can crash the backend mid-operation.

---

## D1 — VM directory collisions (create / clone / restore-as-new)

**Findings:** V3 (High), V4, V14. **Decision needed: yes.**

**Decision (ask):** what should creating a VM over a kept directory do?
1. **Refuse** with 409 `VM_DIR_EXISTS` naming the path; fix `VM-MANAGEMENT.md:126` to say kept
   disks are reattached via "existing disk" at create. — **recommended** (smallest, matches
   rename's guard, no new feature).
2. Implement "adopt": detect kept `disk*.qcow2` and offer them in the create form.

**Fix (option 1):**
- createVM, cloneVM, restore-as-new: refuse if `getVMBasePath(name)` exists.
- `routes/vms.js` POST: check `DomainLookupByName` + dir existence **before**
  `generateCloudInit`; on failure roll back only artifacts this request created.
- Wrap create and restore-as-new so any failure after `mkdir` removes the dir it created
  (and only then — never a pre-existing one).

**Acceptance:** delete-keep-disks then create same name → 409, kept files byte-identical;
create with an existing VM's name → 409, existing VM's `cloud-init.json`/ISO untouched; forced
failure mid-create (e.g. bad bridge) leaves no `vms/<name>/`.
**Verify:** Linux server. **Docs:** `VM-MANAGEMENT.md`, `CLOUD-INIT.md`.

---

## D2 — VM backup and restore integrity

**Findings:** V5, V6, V7. **Decision needed:** no.

**Fix:**
- createBackup: on any error `rm -rf` the backup dir it created; write `manifest.json` last
  (already) and **list only dirs with a manifest**.
- Restore-in-place: decompress into temp files in the VM dir, then rename over the live disks
  once every disk succeeded; redefine domain last.
- One per-VM operation lock in the backend (Wisp glue, not vmManager — CODING-RULES §7) that
  start, backup, restore-in-place and delete check; `409 VM_BUSY`. Frontend disables Start for
  any active VM job kind.
- Multi-destination backup: per-destination completion becomes `{step:'destination-done', id}`;
  only `completeJob` emits `done`.

**Acceptance:** kill the SMB share mid-backup → no listed partial backup; restoring a
deliberately truncated `.gz` leaves live disks untouched; Start during restore → 409 and the
button is disabled; Local+SMB backup shows done only after both and surfaces a second-destination error.
**Verify:** Linux server. **Docs:** `BACKUPS.md` (partial cleanup, locking, multi-dest progress).

---

## D3 — VM disk and config edits

**Findings:** V8, V10. **Decision needed:** no.

**Fix:**
- `updateVMConfig`: base `DomainDefineXML` on `getDomainXML(path, { inactive: true })`; live
  XML only for the hot-apply `UpdateDevice` decisions.
- `createAndAttachDisk`: validate slot (enum), require it free, require VM offline where the
  spec says so, and pick a filename that does not exist (`disk<N>.qcow2`, next free N) **before**
  `qemu-img create`.

**Acceptance:** running VM: memory 2→4 GiB (pending) then icon change → inactive XML still 4 GiB;
detach sdb (file kept) then add disk on sdb → new file, old one intact; `slot: 'sda'` when occupied → 409.
**Verify:** Linux server. **Docs:** `VM-MANAGEMENT.md` disk section.

---

## D4 — Container data

**Findings:** C1 (High), C3. **Decision needed:** no.

**Fix:**
- C1: tiny-samba share rename moves the backing dir (reuse `updateContainerMount`'s rename
  path) instead of delete+create; share removal requires an explicit confirm in the UI that
  states the data will be deleted. App flows bypass the generic delete-on-removal path, or
  pass an explicit `deleteRemoved` intent.
- C3: delete-without-files removes `container.json` (keeping `files/`), so the container
  disappears from the list; create refuses with `CONTAINER_EXISTS` when the directory exists
  and never `rm -rf`s a directory it didn't create.

**Acceptance:** rename share with files → files present under the new name, smbd serves them;
remove share → confirm dialog; delete-keep-files → gone from sidebar, files kept; create same
name → 409 with kept files untouched.
**Verify:** Linux server (tiny-samba container). **Docs:** `CONTAINERS.md`, `CUSTOM-APPS.md`,
`UI-PATTERNS.md` if the confirm introduces a pattern.

---

## D5 — Mount detection

**Findings:** P1, P12. **Decision needed:** no.

**Fix:** one shared `/proc/mounts` (or `/proc/self/mountinfo`) parser that decodes octal
escapes, used by `smbMount.getMountStatus`, `mountsAutoMount`, `hostHardware`. Status is an
exact mount-point match. The boot orphan sweep excludes `WISP_MOUNT_ROOT` itself.
(Placement: the parser serves storage + host — check CODING-RULES §2 for where shared code by
purpose lives.)

**Acceptance:** with a bind/tmpfs mounted at `/mnt` (or `/mnt/wisp`), an SMB share under it
reports unmounted until actually mounted and auto-mount mounts it; `/mnt/wisp` isn't
lazy-unmounted at boot; a mount path with a space shows in Host → Storage.
**Verify:** Linux server. **Docs:** `STORAGE.md`.

---

## D6 — Stream error crashes

**Findings:** V9, P11, V17; unconfirmed HAOS race. **Decision needed:** no.

**Fix:** `stream/promises.pipeline(Readable.fromWeb(res.body), writer)` (or attach `error` at
creation + honor backpressure) in `downloadUtils.js` and `wispUpdate.js`; clean up the partial
file on error. Catch the reconnect rejection in `vmManagerConnection.js` and reschedule with
backoff (existing pattern — no new timers masking races). Confirm the HAOS `xz` exit/finish race
and fix ordering (await both).

**Acceptance:** a download into a full tmpfs returns a job error and the backend stays up;
double-starting the same image download → one wins, the other errors cleanly; stopping
libvirt-dbus → backend logs retries, doesn't exit.
**Verify:** darwin can exercise the download path against a tiny tmpfs-like full disk (or
`ulimit -f`); libvirt reconnect on Linux.
**Docs:** none expected (`ERROR-HANDLING.md` if a new error code appears).

---

## Phase 2 exit

All bundles merged and verified on the Linux server; results recorded per bundle here.

---

## Results (2026-10-16)

Branch `fix/audit-phase2` (D1–D6; doc conflicts in ERROR-HANDLING/BACKUPS resolved by union; the
auto-merged overlaps in `vmManagerBackup.js` restore-as-new, `vmManagerCreate.js` clone and
`routes/vms.js` reviewed by hand). `check-imports`, module load, frontend build OK. Deployed to the
test server (tini) via the self-updater; backend never restarted during the run.

| Bundle | Linux (tini) — all PASS unless noted |
|---|---|
| D1 | kept `vms/d1keep` → create / clone / restore-as-new each 409 with the path, kept file sha256 unchanged; create `gubi` (has cloud-init) → 409, its ISO/json hashes unchanged; bogus machine type → job error, no dir, no domain; happy create → disk + cloud-init 600 + sde |
| D2 | single-destination backup → exactly one `done`; manifest-less dir not listed; truncated `.gz` restore-in-place → error, live disks/cloud-init/XML byte-identical, no `.restore-*`; during restore-in-place start/backup → 409 VM_BUSY, start OK after. **Skipped:** multi-destination + mid-backup share loss (no reachable SMB, no sudo) |
| D3 | running VM: memory change (requiresRestart) then icon/balloon edits keep the pending memory in inactive XML; add disk → `disk1`, detach-keep + add → `disk2` (disk1 untouched); occupied sda → 409; `sdz` → 422; running VM → 409, no file |
| D4 | delete-keep-files → not listed, only `files/` kept; re-create → CONTAINER_EXISTS, files unchanged; bogus image → no dir; tiny-samba share rename stopped and running → data moved with identical hashes, SMB lists the new share. **Skipped:** removal confirm dialog (driven in a UI harness by the implementer) |
| D5 | parser matches `/proc/self/mounts`; escape decoding + orphan sweep (synthetic); all four readers use the parser; no hard-converge lines. **Skipped:** real SMB/disk mounts (share unreachable, no sudo) |
| D6 | two concurrent same-name ISO downloads → `x` and `x (1)`, identical; HAOS end-to-end → clean qcow2, no `.haos_download_*` left; no unhandled errors in the journal. **Skipped:** full-disk download, libvirt reconnect (need sudo) |

Found during verification (pre-existing on main, not a regression): creating an *app* container
logs "Background job failed — Cannot read properties of undefined (reading 'name')" after `done`
— `createAppContainer` returns nothing and the job store's `formatResult` reads `result.name`.
Queued in Plan 4 (L5).
