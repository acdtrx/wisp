# Backups

The backup system creates full VM snapshots to local or network (SMB) storage, and supports restoring backups as new VMs.

## Backup Preconditions

- The VM **must be stopped** (`shutoff` — see [VM-MANAGEMENT.md → States](VM-MANAGEMENT.md#states)) before creating a backup
- At least one backup destination must be configured and accessible

## Backup Contents

A backup directory contains:

| File | Description |
|------|-------------|
| `manifest.json` | Backup metadata: VM name, timestamp, **`origin`** (`"manual"` / `"scheduled"` — all VM backups are manual today; the field exists for API symmetry with containers and backups predating it list as manual), **`vmBasePath`** (absolute path to the VM’s directory at backup time, used when restoring under a new name or after `vmsPath` changes), disk file list, total size |
| `domain.xml` | The libvirt domain XML at time of backup (a [flattened](#disks-on-a-backing-chain) disk's entry names its standalone file) |
| `disk0.qcow2.gz` | Gzipped primary disk image — always standalone, see [Disks on a backing chain](#disks-on-a-backing-chain) |
| `disk1.qcow2.gz` | Gzipped secondary disk image (if present) |
| `VARS.fd` | UEFI NVRAM file (if UEFI firmware). Copied via the **`wisp-nvram`** privileged helper because libvirt creates the source as `libvirt-qemu:kvm` mode `600`. |
| `cloud-init.json` | Cloud-init configuration (if the VM has cloud-init), `0600` like the source — it holds the password hash |

Disk images are gzipped to reduce backup size. NVRAM and config files are stored uncompressed.

### Cloud-init seed ISO

*(settled 2026-10-16)* The cloud-init seed ISO is **not backed up** — it is derived data, built entirely from `cloud-init.json` (plus the VM name and first NIC's MAC). Restore rebuilds it from the restored `cloud-init.json` through the same generator a cloud-init edit uses (`lib/cloudInit.js`, Wisp glue — vmManager stays free of it): the routes pass `rebuildCloudInitISO` to vmManager's restore as its `populateVMDir` hook, which runs once the payload is in place and before the domain is defined, so a failed rebuild rolls the restore back like any other step. The rebuilt ISO is `0600`, reuses the stored password hash (never re-hashes), takes the first NIC's MAC from the domain about to be defined, and lands at the path the restored domain's `sde` CD-ROM already names. No `cloud-init.json`, or one with `enabled: false`, builds nothing. **One rule for every backup:** a `cloud-init.iso.gz` in a backup taken before this change is ignored and the ISO is rebuilt from the JSON like any other restore (every Wisp backup that holds an ISO also holds the JSON — both have been written together since the first release).

Why not back it up: libvirt chowns the read-only CD-ROM image to its qemu user when the VM starts and never restores read-only images on stop, and the ISO is `0600` (it carries the password hash) — so after a VM's first boot the wisp user can no longer read its own ISO. The backup used to swallow that error and silently finish without the ISO (V19 follow-up). Rejected: copying it through the privileged `wisp-nvram` helper (widens a privileged path to carry data the JSON already holds) and relaxing the ISO to group-readable `0640` (weakens the password-hash hardening).

Consequence: the rebuilt ISO's cloud-init `instance-id` (`<vmName>-<hash of user-data>`) can differ from the old one — always on restore-as-new (new name, new MAC), and on restore-in-place when the original ISO was built without the MAC hint (created and never edited: create builds the ISO before the domain, so it has no MAC). A new instance-id makes cloud-init re-run its once-per-instance modules on the next boot: user and password, SSH keys, packages, and **regenerated SSH host keys**.

### Disks on a backing chain

*(settled 2026-10-16)* Every VM backup is complete and self-contained, whatever snapshots the VM has. A live snapshot leaves each disk on an external overlay (`disk0.<snapshot>`, backing file the original `disk0.qcow2` — see [SNAPSHOTS.md](SNAPSHOTS.md#create)), and the domain points at the overlay until the snapshot is deleted. For each disk the backup reads the image's chain (`qemu-img info --backing-chain --output=json`, with the format pinned to the domain's `<driver type>` so a guest-written raw image is never probed as qcow2):

- **No backing file** (the usual case): the image file is gzip-streamed as-is (fast path).
- **A backing chain:** the whole chain is **flattened** — `qemu-img convert -O qcow2` of the top image into a scratch file `<file>.flatten` inside the backup's own directory, which is then gzipped and removed. The result is a standalone qcow2 with the content the VM currently sees (base plus every overlay). It is saved under the **chain base's** file name (`disk0.qcow2.gz`, not `disk0.<snapshot>.gz`); `manifest.json` lists that name, and the saved `domain.xml` points that disk at the base path as a qcow2 file with no `<backingStore>`, so a restore produces a normal standalone disk and needs nothing chain-aware.

The VM is stopped, so the chain is stable while it is read. Flattening needs the disk's allocated size free at the destination, briefly, on top of the compressed copy, and costs a second pass over the data (convert, then gzip). A failed flatten (disk full, unreadable or missing backing file) fails the destination like any other error — the backup directory, scratch file included, is removed, and nothing is ever written to the VM directory. Two disks that would land under the same file name (two overlays on one base image, or two same-named images in different directories — before this check the second silently overwrote the first) fail the backup (`CONFIG_ERROR`) rather than overwrite each other.

Rejected: refusing to back up while any disk has a backing chain — a VM with a live snapshot could then not be backed up at all until the snapshot was deleted.

### Not backed up

A VM backup holds the files above and nothing else. Outside it:

- **vTPM state.** A VM with a vTPM (the Windows 11 template enables one) keeps its TPM in libvirt's swtpm state directory (`/var/lib/libvirt/swtpm/<uuid>/`, root-owned), keyed by the domain UUID — not in the VM directory, and not copied. Consequences on restore:
  - **Restore as new** gets a new UUID and therefore a fresh, empty TPM. Anything the guest sealed to its TPM is gone: **BitLocker asks for its recovery key** on first boot, and Windows Hello PINs / biometrics, TPM-backed certificates and similar keys must be set up again. Have the BitLocker recovery key before relying on such a backup.
  - **Restore in place** keeps the live UUID, so the guest finds the TPM it has *now* — normally the same TPM the backup was taken with, and BitLocker unseals as before. It does not if the TPM changed since the backup (VM deleted and recreated under the same name, TPM cleared in the guest, vTPM toggled off and on): then the same recovery-key prompt applies.
  - Deleting a VM lets libvirt remove its TPM state, so once the original VM is gone no restore gets its TPM back.
- **Snapshots.** Snapshots are not part of a backup: a backup holds the disks' *current* state only, and restore defines no snapshot metadata, so a restored VM shows no snapshots. Internal (offline) snapshots live inside a qcow2 file and travel with it when the disk is copied as-is, but a flattened disk (above) carries only the active layer; a live snapshot's memory file (`snapshots/*.mem`) is never copied.

vTPM state backup is a backlog item (see `docs/BACKLOG.md`); the gap is documented rather than closed. (settled 2026-10-16)

## Backup Directory Structure

```
<destination>/vms/<vm-name>/<timestamp>/
├── manifest.json
├── domain.xml
├── disk0.qcow2.gz
├── VARS.fd
└── cloud-init.json
```

VM backups land under a `vms/` subdirectory of each destination root. This mirrors container backups, which already live at `<destination>/containers/<name>/<timestamp>/` — VM and container namespaces are now symmetric and never collide.

The timestamp folder name is `YYYY-MM-DDTHH-mm-ss` (ISO with `:` swapped to `-`, e.g. `2026-05-08T06-30-00`).

**Legacy layout:** Backups taken before this layout flip live at `<destination>/<vm-name>/<timestamp>/` (no `vms/` prefix). `listBackups` walks both paths and dedupes by `(vmName, timestamp)` preferring the new layout. Restore/delete still work on legacy backups — `resolveVmBackupDir(root, name, ts)` checks the new path first, then falls back. New backups always use the new layout; nothing is moved on disk.

**The on-disk layout is a server-side detail, not part of the API.** Backups are identified across the API as `(destinationId, vmName, timestamp)`; clients never receive or send the absolute backup path. See [API.md → Backups](API.md#backups).

## Backup Destinations

### Local

The default backup path is `/var/lib/wisp/backups` (configurable via `backupLocalPath` in `config/wisp-config.json`).

### Optional extra mount

All configured mounts (SMB shares and adopted removable drives) live under **`mounts`** in settings (**Host → Host Mgmt → Storage**). Only one mount may be selected for backups via **`backupMountId`** (**Host → Host Mgmt → Backup**). When set, that mount's local path is offered as a second destination in the VM Overview backup modal (alongside Local).

Each mount entry has a `type` (`smb` or `disk`) and common fields (id, label, mountPath, autoMount) plus type-specific fields as documented in [CONFIGURATION.md](CONFIGURATION.md).

SMB shares must be mounted before use (or the backup job attempts to auto-mount). Disk mounts follow removable-drive insertion events. Mount/unmount is performed via the `wisp-mount` helper script (invoked with `sudo`).

### Auto-mount

At backend startup, `ensureMounts()` attempts to mount every configured SMB share (unless `autoMount` is false) and hard-converges orphan mounts under `/mnt/wisp/`. Disk mounts are triggered by insertion events, not startup reconciliation. Failures are logged but do not prevent the backend from starting.

## Creating a Backup

1. Client sends `POST /api/vms/:name/backup` with `destinationIds` (e.g. `["local"]` or `["local", "<backupMountId>"]`); defaults to `["local"]` when omitted. Only `local` and the single configured `backupMountId` are accepted — any other id returns 422.
2. Backend refuses a VM that is not stopped with **409** `VM_MUST_BE_OFFLINE` in the request itself — no job is created and no attempt is recorded (vmManager's `createBackup` re-checks inside the job, covering a VM started in between)
3. Backend resolves paths from `backupLocalPath` and, when requested, the mount referenced by `backupMountId` (with mount check / auto-mount for SMB)
4. The VM's [operation lock](#per-vm-operation-lock) is taken (**409** `VM_BUSY` if another start / backup / restore / delete / rename / clone of this VM is running) and a background job is created (returns `jobId`)
5. For each destination path, in order:
   - Create backup directory `<dest>/vms/<vmName>/<timestamp>/` — exclusively: if that directory already exists (a second backup within the same second) the destination fails with `BACKUP_EXISTS` rather than writing into another run's backup
   - Save domain XML
   - Gzip and copy each disk image — a disk on a backing chain is flattened first ([Disks on a backing chain](#disks-on-a-backing-chain))
   - Copy NVRAM file (if present)
   - Copy cloud-init config (if present — absent means the VM has no cloud-init; any other read failure fails the backup). The seed ISO is not copied ([Cloud-init seed ISO](#cloud-init-seed-iso))
   - Write manifest.json — **last**; its presence is what makes the directory a complete backup
6. Progress is reported via SSE — see [Progress Tracking](#progress-tracking)

**Failure cleanup:** any error while writing a destination's backup (disk full, SMB share dropped, unreadable source) removes the directory that run created and fails the job; destinations already finished stay complete and listed. If even the removal fails (destination gone), the leftover directory has no `manifest.json` and is never listed or restorable.

## Listing Backups

`GET /api/backups` scans configured destinations that are currently usable (a `<vmName>/<timestamp>/` directory is listed only when it holds a parsable `manifest.json` — every backup Wisp has completed has one, so a manifest-less directory is an interrupted backup): always the local backup path; the extra destination only if `backupMountId` is set **and** the corresponding mount is currently mounted. For each found backup, returns: VM name, timestamp, total size in bytes, `origin` (`"manual"` / `"scheduled"`, manual when the manifest predates the field), plus `destinationId` (`'local'` or the mount UUID) and `destinationLabel` for display.

Optional `?vmName=` filter restricts results to a specific VM.

A configured network backup path that is not mounted is omitted from the scan (same as before for unmounted SMB).

## Restoring a Backup

`POST /api/backups/restore` with `{ destinationId, vmName, timestamp, newVmName }` — `(destinationId, vmName, timestamp)` are typically copied from a list row:

0. Refuse with **409** if `newVmName` is taken — `VM_EXISTS` (a libvirt domain) or `VM_DIR_EXISTS` (`<vmsPath>/<newVmName>/` already exists, e.g. kept by *Delete VM, keep disks*). The restore never writes into a directory it did not create.
1. Read `manifest.json` and `domain.xml` from the backup (both required — a directory without a manifest is incomplete, 422 `BACKUP_INVALID`)
2. Create the new VM's directory (`<vmsPath>/<newVmName>/`, exclusively) and decompress/copy disk images into it
3. Copy NVRAM and `cloud-init.json`; the restored `cloud-init.json` is chmodded `0600` (it carries the password hash — see [CLOUD-INIT.md](CLOUD-INIT.md) § Password hashing). It is optional, but present in the backup and failing to copy fails the restore. Then the cloud-init seed ISO is **rebuilt** from it ([Cloud-init seed ISO](#cloud-init-seed-iso)); a `cloud-init.iso.gz` in an older backup is ignored. Restore-in-place uses the same steps.
4. Rewrite domain XML: new name, new UUID, new MAC addresses, and **path updates** so every file reference under the original VM directory (including block disks, CD-ROM paths such as cloud-init, UEFI NVRAM, and optional loader paths under that directory) points at `<vmsPath>/<newVmName>/`. This uses **`manifest.vmBasePath`** when available (older backups fall back to the backed-up VM name or inferred paths). Disk images that lived outside the VM directory (e.g. image library) are still remapped using the same per-disk logic as before.
5. Define the new domain with `DomainDefineXML`

Any failure in steps 2–5 (missing disk in the backup, gunzip error, ISO rebuild failure, define failure) removes the new VM's directory, so a failed restore leaves nothing behind.

The restored VM gets a new name, new UUID, and new MAC addresses — it is a fully independent copy.

### `vmBasePath` portability

`manifest.vmBasePath` is recorded as an **absolute path** at backup time (e.g. `/var/lib/wisp/vms/<oldName>`). Restore uses it as the prefix to rewrite when emitting the new domain XML. This is resilient to the VM being renamed since the backup was taken (the manifest still points at the old path, which is what disk `<source file>` entries in the backup XML refer to), and also tolerates `vmsPath` changes (the rewrite produces paths under whatever `vmsPath` is configured **at restore time**).

Where it can fail: if a backup was produced under one `vmsPath` and you later move the entire `vms/` tree to a different absolute path **and** edit `wisp-config.json` accordingly, the manifest's recorded `vmBasePath` no longer matches anything Wisp recognises. In that uncommon case the restore falls back to inferring from the original VM name — and if that also doesn't match, the operator must edit `manifest.vmBasePath` to the path that was current when the backup was taken before retrying. We accept this rare manual step rather than carrying historical `vmsPath` history in the manifest.

## Restoring in place

Both workload kinds can also be restored **over the live workload the backup was taken from** — same name, identity preserved — via `POST /api/backups/restore-in-place` and `POST /api/container-backups/restore-in-place`. Both run as background jobs (kinds `vm-restore` / `container-restore`, title `Restore <name>`) streaming progress over the same per-kind backup-progress SSE endpoints, and both accept `safetyBackup` (default `true`): the job first takes a normal manual-origin backup of the *current* state to the same destination (progress steps prefixed `safety-`, mapped to 0–45% of the job's bar), then restores (45–100%). If the safety backup fails, the job aborts before touching the live workload. A VM restore-in-place holds the VM's [operation lock](#per-vm-operation-lock) for the whole job (**409** `VM_BUSY` while another start / backup / restore / delete / rename / clone of the VM runs); a container restore-in-place is rejected with **409** `BACKUP_IN_PROGRESS` while another backup or restore job for the same container is running.

**VM** (`restoreBackupInPlace` in vmManager): the target VM is identified by the backup itself (`manifest.vmName`, falling back to the domain XML name), must exist (404 `VM_NOT_FOUND` otherwise — restore-as-new covers deleted VMs), must be stopped (409 `VM_MUST_BE_OFFLINE`), and must have **no snapshots** (409 `VM_HAS_SNAPSHOTS` — see below). Disks, NVRAM, and `cloud-init.json` are decompressed into a staging directory, the cloud-init seed ISO is rebuilt there from that JSON inside the VM's directory (`.restore-<uuid>/`, same filesystem), and only once **every** file staged are they renamed over the live files; the backed-up domain XML is re-defined over the live definition last. A missing, truncated, or corrupt file in the backup fails the job with the live disks byte-identical and the staging directory removed. A `DomainDefineXML` failure after the swap leaves the restored disks under the live definition and says so in the error. (A backend crash mid-restore can leave a `.restore-*` directory in the VM's directory; it is safe to delete.)

- **Name and UUID stay those of the live domain.** The UUID only differs when a same-named VM was deleted and recreated since the backup; adopting the live UUID lets `DomainDefineXML` replace the definition without an undefine/define window.
- **MAC addresses, hardware config, and disk contents revert to the backup's state** (unlike restore-as-new, which regenerates them).
- **Disks that lived outside the VM directory at backup time** (e.g. image library) are restored into the VM directory and remapped — identical to restore-as-new; the outside file is never overwritten.
- Files in the VM directory the backup does not reference (e.g. a disk added later) are left in place, orphaned.
- **A VM with snapshots is refused** *(settled 2026-10-16)*: 409 `VM_HAS_SNAPSHOTS`, checked in the request — before the operation lock, the safety backup or the job — and again by vmManager before anything is staged. A restore replaces the very disks the snapshots depend on (a live snapshot's overlay sits on the base file the restore writes; an internal snapshot lives inside the qcow2 being replaced), so the libvirt snapshot metadata would survive pointing at disk content it wasn't taken with — reverting would pair a snapshot's memory state with the wrong disks. Delete the snapshots first. Rejected: restoring anyway and documenting the stale metadata. Restore-as-new is unaffected — the new VM has no snapshots.

**Container** (`restoreContainerBackupInPlace` in containerManager): the target is the backup's manifest name, must still exist on disk (404 `CONTAINER_NOT_FOUND`), and must be stopped (409 `CONTAINER_MUST_BE_STOPPED` — the directory is swapped out from under any rootfs mounts, so pausing is not enough; a lingering STOPPED task record is cleaned up like backup does). The archive is extracted to a staging dir and validated (single top-level dir matching the name, parsable `container.json`, mounts/devices per *Archive validation* below) *before* the live directory is moved aside and the staged one renamed in; a failed swap rolls the old directory back. Then:

- **Identity is preserved**: same name, same MAC (and therefore the same DHCP lease), same containerd record (kept if present, recreated if missing). The rootfs snapshot is re-prepared from the image on next start either way.
- The archived `container.json` replaces the live one wholesale — config edits made after the backup revert with it. The write goes through `writeContainerConfig` so list caches and the UI refresh.
- The image is re-pulled if missing and the persisted digest refreshed, same as restore-as-new. If that fails the restored directory stays in place and the error surfaces — a later start or retry finishes the job.

## Backup attempt status

The on-disk backup tree only records successes (a failed backup removes its partial directory, and listing ignores any directory without a manifest), so "did last night's scheduled backup work?" is unanswerable from disk. Wisp persists the **most recent backup attempt per workload** in `config/backup-status.json` — the install root's `config/`, beside `wisp-config.json`, not `backend/config/` (app-glue `lib/backupStatus.js`, atomic JSON writes, preserved across self-updates via the updater's `RSYNC_EXCLUDES`, gitignored):

```json
{
  "vms":        { "<name>": { "at": "<ISO>", "ok": true,  "origin": "manual",    "destinationIds": ["local"], "timestamp": "<backup dir name>" } },
  "containers": { "<name>": { "at": "<ISO>", "ok": false, "origin": "scheduled", "destinationIds": ["local"], "error": "<message>" } }
}
```

Recorded on every completion of a manual backup (both route handlers), a scheduled backup (the scheduler), and the safety backup inside a restore-in-place job. It is a last-outcome cache, not history — safe to delete, self-healing.

The map is pushed on the **`backups` topic of `GET /api/events`**: a snapshot on connect, then a frame after every attempt record and every backup delete/prune (`notifyBackupsChanged`). The frontend's Backups panel uses each frame both for the status badges and as its cue to refetch the backup lists — there is no polling.

## Deleting a Backup

`DELETE /api/backups` with `{ destinationId, vmName, timestamp }`:

- The route resolves `destinationId` to a configured destination root (rejecting unknown ids), validates `vmName` (`validateVMName`) and `timestamp` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, max 64 — the leading alphanumeric makes `.` / `..` impossible), then constructs the absolute path server-side. The client never sends a path. Invalid input is **422 before anything touches disk**.
- The manager (`deleteBackup` / `deleteContainerBackup`) independently refuses (422 `BACKUP_INVALID`) a resolved target outside every configured destination root, or equal to a destination root itself or its `vms/` / `containers/` sub-root — defense in depth that holds regardless of the route's validation.
- The entire backup directory is removed.

## Progress Tracking

Backup creation and restore-in-place run as background jobs with SSE-based progress streaming (restore-as-new is a synchronous request):

- **Job store** manages job state (pending, running, complete, failed)
- **SSE stream** at `/api/vms/backup-progress/:jobId` (VMs) or `/api/containers/backup-progress/:jobId` (containers) pushes events
- Events include: step name, percent complete, current file being processed
- The terminal event is `done` (emitted only by the job store on job completion) or `error`; the frontend closes the stream on either
- **Multi-destination backups** (VM and container, manual and scheduled — one shared runner, `backupToEachDestination` in `lib/backupDestinations.js`): each destination owns an equal slice of the job's 0–100% bar, `currentFile` is prefixed with the destination label (`Local: Copying disk0.qcow2`), and a finished destination emits `{ step: "destination-done", destinationId, percent, currentFile }` — never `done`; managers emit no `done` of their own. A later destination's failure therefore still reaches the client as the job's `error` (message prefixed with that destination's label).
- Byte-driven progress (disk gzip, container tar) is emitted once per integer percent change, and a stream that (re)connects mid-job replays a short history — see [API.md → Job store contract](API.md#background-jobs).

## Per-VM operation lock

*(settled 2026-10-16)* Start, backup, restore-in-place, delete, rename and clone of a VM are mutually exclusive: each takes an in-memory per-VM lock (`lib/vmOperationLock.js`, Wisp glue — vmManager stays policy-free) and a second one is refused with **409** `VM_BUSY` instead of queueing. Backup, restore and clone hold it for the whole background job (a restore's safety backup included; a clone locks its **source** VM); start, delete and rename (`PATCH /api/vms/:name` with a different `name` — other edits don't lock) for the duration of the call. This closes e.g. a Start landing while a restore is replacing the disks, two backups of one VM interleaving, a delete under a running backup, or a rename moving the VM directory out from under a backup, restore or clone reading it. The other lifecycle actions (stop, reboot, …) don't take it — they apply to a running VM, and the locked operations require a stopped one. The frontend mirrors it from the background-jobs list: while a `backup` or `vm-restore` job for the VM runs, Start, Clone and Delete are disabled (and Backup during a restore); a rename attempted then surfaces the 409 as the save error. A running clone is not mirrored (its job is titled by the new name), so actions on the source during a clone get the backend's 409. Rejected: deriving busy state from the job store's titles (as the container restore check does) — start and delete are not jobs, so they would have nothing to hold.

## Container Backups

Containers reuse the same backup destinations and pre-checks (configured roots, mount-when-needed for SMB) as VMs, but the on-disk layout and contents are different — there is no analog to a VM's qcow2 disk. The container's writable rootfs is **ephemeral** (re-prepared from the image on every start, see [CONTAINERS.md → Ephemeral rootfs](CONTAINERS.md#ephemeral-rootfs)), so a backup only needs to capture the container directory itself: `container.json` plus Local mount data (`files/<mountName>/`) and recent run logs (`runs/`).

Unlike VMs, containers do **not** need to be stopped: a running container is **paused** (containerd `Tasks.Pause` → cgroup freezer) for the duration of the archive and resumed automatically. Nothing can write to the container directory while its processes are frozen, so the archive is a point-in-time capture — equivalent to a power cut, which well-behaved apps (SQLite incl. WAL, Postgres, registries) recover from by design. The container keeps its PIDs, memory, and open TCP connections; clients just see a stall for the seconds the tar takes. The UI shows the container as `paused` for that window.

### Layout

Container backups live under a sibling `containers/` subdirectory at each backup root, kept separate from VM backups so VM and container names can never collide:

```
<destination>/containers/<container-name>/<timestamp>/
├── manifest.json
└── data.tar.gz
```

`data.tar.gz` is a single gzipped tar of the container's directory under `<containersPath>/<name>/`. The archive's top-level entry is the original container name (used by restore to detect a one-directory archive layout). `manifest.json` is uncompressed and carries metadata for listing without extracting:

| Field | Description |
|-------|-------------|
| `type` | Always `"container"` (discriminator vs VM backups) |
| `schemaVersion` | Manifest schema version (currently `1`) |
| `name` | Container name at backup time |
| `timestamp` | ISO 8601 timestamp (filesystem-safe form, used as the dir name) |
| `origin` | `"manual"` or `"scheduled"` — who took the backup. Backups predating this field list as `manual`. Retention pruning only ever deletes `scheduled` backups. |
| `image` | OCI image reference from `container.json` (e.g. `nginx:latest`) |
| `imageDigest` | Top-level manifest digest at backup time (`sha256:…`) — informational; restore re-pulls and adopts whatever the registry currently advertises |
| `sourceBytes` | Pre-walked total bytes of the container directory (uncompressed) |
| `archiveBytes` | Final size of `data.tar.gz` |
| `sizeBytes` | Same as `archiveBytes` (parallels the VM manifest field used by listings) |

### Creating a container backup

`POST /api/containers/:name/backup` with `{ destinationIds }` — same body shape as the VM backup route; both routes resolve ids via the shared `lib/backupDestinations.js` helper (`'local'` → `backupLocalPath`; the configured `backupMountId` → its mount path, auto-mounting SMB; unknown ids → 422, mount failure → 503). A second backup request for the same container while one is running returns **409** `CONTAINER_BACKUP_IN_PROGRESS`.

The task state decides how the archive is taken (`freezeForBackup` in `containerManagerBackup.js`):

- **RUNNING** → `pauseContainer` (cgroup freezer), tar, then resume in a `finally` (a resume failure — e.g. the task was killed externally while frozen — is logged and never masks a tar error nor fails a good archive).
- **STOPPED** → task record deleted (`cleanupTask`), archived cold — unchanged behavior.
- **CREATED** / no task → archived cold, nothing to pause.
- **PAUSED** (pre-existing) → archived as-is and **left paused** (the backup didn't pause it, it won't resume it).
- **PAUSING / UNKNOWN** → **409** `CONTAINER_TASK_TRANSIENT` — retry when the state settles.

The backup directory `<dest>/containers/<name>/<timestamp>/` is created **exclusively**, as for VMs: if it already exists (a second backup of the container within the same second) that destination fails with **409** `BACKUP_EXISTS` rather than writing into — or, on a later failure, removing — another run's backup. The pause happens as late as possible (after destination validation and dir creation) so the frozen window covers only measure + tar. If the archive or the manifest write fails, the partial backup dir is removed. The job spawns `tar -cf - <containerDir>`, pipes its stdout through Node's `createGzip()` and a bytes-counter `Transform` (driving percent against the pre-walked source size), then writes to `data.tar.gz`. After the archive is finalized, the manifest is written.

Progress steps are `pausing → measuring → archiving → resuming → manifest` (the pause/resume steps are skipped for cold archives), then `destination-done` per destination; the terminal `done` comes only from job completion (see [Progress Tracking](#progress-tracking)). Events are emitted via the shared `backupJobStore` — same SSE consumer (`backgroundJobsStore` on the frontend, top-bar progress + modal mirror) as VM backups, just routed via `/api/containers/backup-progress/:jobId` and `JOB_KIND.CONTAINER_BACKUP`.

**Crash recovery:** if the backend dies mid-archive, the container stays frozen until the next backend boot, where `resumeStalePausedContainersAtBackendBoot` resumes any paused wisp-managed task (Wisp exposes no user-facing pause, so a paused task at boot can only be an interrupted backup). Runs before the autostart pass.

### Scheduled backups

A daily scheduler (`lib/containerBackupScheduler.js`, app-glue — started/stopped from `index.js` alongside the update checkers) backs up every container whose `container.json` has **`autoBackup: true`** (toggle in the container's General section; default `false`).

**Configuration** lives in `settings.backupSchedule` (**Host → Host Mgmt → Backup Scheduler**):

| Field | Default | Constraints | Description |
|-------|---------|-------------|-------------|
| `enabled` | `false` | boolean | Master switch |
| `time` | `"03:00"` | `HH:MM` 24h, host-local | Daily fire time |
| `destinationIds` | `["local"]` | non-empty subset of `'local'` + the configured `backupMountId` | Where scheduled backups go |
| `retainDays` | `7` | integer 1–365 | Daily retention window |
| `retainWeeks` | `4` | integer 0–52 | Weekly retention window |

**Firing semantics:** a 60-second tick fires when the configured time is crossed between two ticks (`target ∈ (lastTick, now]`), at most once per boundary. There is **no missed-window catch-up** — the server is assumed to run 24/7; if the backend was down (or the scheduler disabled) at the configured time, that day is skipped. The tick baseline is set at boot, so booting *after* today's time does not fire. A clock-backwards jump re-baselines instead of double-firing.

**Run:** the run is `runScheduledBackups({ trigger })`, exported for manual invocation (CODING-RULES §7) — it uses `settings.backupSchedule`'s destinations and retention whether or not the schedule is enabled; the tick is one trigger. At most one run is in flight whatever triggered it (a second call returns `false` and logs the skip), and every run logs its trigger and the backed-up / failed / skipped counts. Containers are processed **sequentially** (at most one container frozen at a time), each as a `CONTAINER_BACKUP` job in the shared `backupJobStore` — visible in `GET /api/background-jobs`, streamable via the normal progress SSE, and picked up by the frontend's page-load job rehydration (an already-open tab doesn't learn of a scheduler-started job until reload). A container with a manual backup already running is skipped. Destination resolution failure (e.g. unreachable SMB share) aborts the run with a warning — containers are never left paused because a destination was missing. Per-container failures are logged and the run continues.

**Retention (GFS-lite, scheduled backups only):** after each successful backup, per container and per destination (`lib/backupRetention.js`):

- keep the **newest scheduled backup per calendar day** for the last `retainDays` days (today inclusive);
- among older scheduled backups, keep the **newest per ISO week** for the `retainWeeks` most recent weeks that have backups (presence-based, so a gap in the schedule never causes the only remaining old backups to be deleted);
- delete every other **scheduled** backup. **Manual backups — and backups predating the manifest `origin` field — are never auto-pruned.**

### Listing

`GET /api/container-backups[?containerName=]` scans each currently-usable destination's `containers/` subdirectory and reads each `manifest.json`. Entries without `type === "container"` are skipped (defensive). Rows carry `origin` (`"manual"` / `"scheduled"`). The VM list scanner (`GET /api/backups`) explicitly skips a top-level `containers/` directory under each root for the symmetric reason — keeps the two namespaces independent.

### Restoring

Container backups can also be restored **in place** over the still-existing container — see [Restoring in place](#restoring-in-place) above. Restore-as-new:

`POST /api/container-backups/restore` with `{ destinationId, name, timestamp, newName }`:

1. Validate `newName` (same rules as create — `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`, 1–63 chars). Reject if a container with that name already exists either on disk or in containerd.
2. Extract `data.tar.gz` into a temporary `.restore-<rand>` directory under `<containersPath>`. Verify the archive contains exactly one top-level directory (the original name).
3. Move that extracted directory to `<containersPath>/<newName>/` (atomic rename on the same filesystem).
4. **Validate** the archived `container.json` (see *Archive validation* below), then rewrite it with `name: <newName>` and a fresh **MAC address** (the old MAC stayed with the source container's DHCP lease — the restored copy gets a new lease). Drop any persisted `network.ip` (it belonged to the old MAC).
5. If the image referenced in `container.json` isn't present in containerd, **re-pull** it. Then refresh `imageDigest` / `imagePulledAt` to whatever's in containerd at restore time (which may differ from the manifest's digest if the registry has moved on — that's intentional: restore picks up the current image, mirroring how a normal start would behave).
6. Build a placeholder OCI spec and `Containers.Create` the new containerd container record. The snapshot is **not** prepared at restore time — it will be re-prepared from the current library image on the first start, exactly like any other stopped container.

The restored container is **independent** of the source: new MAC, new DHCP lease, fresh rootfs snapshot on first start. Local mount data carried in the archive lives under `files/<mountName>/` as expected.

### Archive validation

A backup archive is untrusted input — anyone who can write to a backup destination (an SMB share, a removable drive) can edit it — yet restore persists its `container.json` and every later start builds an OCI spec from it. Both restore paths therefore run the archived `mounts` and `devices` through the same validators as create/PATCH (`validateAndNormalizeMounts`, `validateAndNormalizeDevices`) before the restored config is persisted; any failure rejects the restore with `BACKUP_INVALID` (**422** on restore-as-new; the restore-in-place job ends in its `error` event — the live directory is untouched) with a message naming the failing rule, and removes the extracted files. That stops, e.g., a `gpu` device pointing at `/dev/mem` or a mount named `../..`. Storage `sourceId`s are checked for shape only, not that they resolve on this host — a restore onto a host without that storage mount is legitimate and surfaces at start (`CONTAINER_MOUNT_SOURCE_MISSING`). Independently of restore, start re-checks that every `gpu` device is a render node, and deleting a mount's backing store refuses names that fail mount-name validation.

### Notes on what survives restore

- **Local mount data** (`files/<mountName>/`) — captured in the archive, restored verbatim under the new name. File ownership inside the archive is preserved by `tar` (preserves UID/GID), which matters for `runAsRoot` containers with idmapped Local mounts.
- **Run logs** (`runs/`) — captured in the archive. The newest 10 runs travel with the backup; the run picker on the restored container will show them as historical entries.
- **Section assignment** — **not** captured. Section assignments are stored in `wisp-config.json` (`assignments`), not in the container directory. A restored container starts unassigned (Main bucket); the user can move it to a section after restore.
- **Storage-sourced mounts** (`mount.sourceId` referencing an entry in `settings.mounts`) — captured verbatim in `container.json`. Storage mount definitions live in `wisp-config.json` and are not part of the backup. If the destination host doesn't have the same `settings.mounts[X]` configured, the mount config is preserved but `assertBindSourcesReady` will reject the first start with **503** `CONTAINER_MOUNT_SOURCE_MISSING` or `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED`. The user fixes this by editing the mount row to point at a different source (or removing it) on the new host.
- **Secret env vars** — `container.json` stores secret values **in plaintext at rest** (the OCI process needs them at runtime); the backup archive carries them as-is. Treat the backup file the same as any other copy of a container's directory: it can leak credentials if it lands in untrusted hands. There is no separate encryption step for container backups in v1.
- **App-container `appConfig`** — captured as-is. Fields that defaulted from the original container name at create time (e.g. jellyfin's `publishedUrl: http://<oldName>.local:8096`, tinySamba's `server.netbiosName`) will still reference the old name; the user can edit them in the app's config UI after restore if they care.
- **Containerd container record** is recreated under the new id with `wisp.managed=true`; the old record (if it still exists on the source host) is unaffected.

### Deleting

`DELETE /api/container-backups` with `{ destinationId, name, timestamp }` — route resolves the destination root from `destinationId` and constructs the path; manager `rm -rf`s the timestamp directory after defense-in-depth allowed-root validation. Same timestamp rule and root/sub-root refusal as [VM backup delete](#deleting-a-backup).

### CLI inspection

A backup can be inspected without involving Wisp:

```bash
cat <dest>/containers/<name>/<timestamp>/manifest.json
tar -tzf <dest>/containers/<name>/<timestamp>/data.tar.gz | head
```

## Mount operations (host mounts API)

| Operation | Endpoint | Description |
|-----------|----------|-------------|
| Status | `GET /api/host/mounts/status` | Mount status for all configured mounts |
| Check | `POST /api/host/mounts/check` | Test SMB connection (does not mount) |
| Mount | `POST /api/host/mounts/:id/mount` | Mount |
| Unmount | `POST /api/host/mounts/:id/unmount` | Unmount |

The `wisp-mount` helper script handles the actual mount/unmount operations and is invoked via `sudo` for the necessary filesystem permissions.
