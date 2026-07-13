# Backups

The backup system creates full VM snapshots to local or network (SMB) storage, and supports restoring backups as new VMs.

## Backup Preconditions

- The VM **must be stopped** before creating a backup
- At least one backup destination must be configured and accessible

## Backup Contents

A backup directory contains:

| File | Description |
|------|-------------|
| `manifest.json` | Backup metadata: VM name, timestamp, **`vmBasePath`** (absolute path to the VM’s directory at backup time, used when restoring under a new name or after `vmsPath` changes), disk file list, total size |
| `domain.xml` | The original libvirt domain XML at time of backup |
| `disk0.qcow2.gz` | Gzipped primary disk image |
| `disk1.qcow2.gz` | Gzipped secondary disk image (if present) |
| `VARS.fd` | UEFI NVRAM file (if UEFI firmware). Copied via the **`wisp-nvram`** privileged helper because libvirt creates the source as `libvirt-qemu:kvm` mode `600`. |
| `cloud-init.iso.gz` | Gzipped cloud-init seed ISO (if cloud-init was enabled) |
| `cloud-init.json` | Cloud-init configuration (if cloud-init was enabled) |

Disk images and the cloud-init ISO are gzipped to reduce backup size. NVRAM and config files are stored uncompressed.

## Backup Directory Structure

```
<destination>/vms/<vm-name>/<timestamp>/
├── manifest.json
├── domain.xml
├── disk0.qcow2.gz
├── VARS.fd
├── cloud-init.iso.gz
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
2. Backend resolves paths from `backupLocalPath` and, when requested, the mount referenced by `backupMountId` (with mount check / auto-mount for SMB)
3. A background job is created (returns `jobId`)
4. For each destination path:
   - Create backup directory `<dest>/vms/<vmName>/<timestamp>/`
   - Save domain XML
   - Gzip and copy each disk image
   - Copy NVRAM file (if present)
   - Gzip and copy cloud-init ISO (if present)
   - Copy cloud-init config (if present)
   - Write manifest.json
5. Progress is reported via SSE: `{ step, percent, currentFile }`

## Listing Backups

`GET /api/backups` scans configured destinations that are currently usable: always the local backup path; the extra destination only if `backupMountId` is set **and** the corresponding mount is currently mounted. For each found backup, returns: VM name, timestamp, total size in bytes, plus `destinationId` (`'local'` or the mount UUID) and `destinationLabel` for display.

Optional `?vmName=` filter restricts results to a specific VM.

A configured network backup path that is not mounted is omitted from the scan (same as before for unmounted SMB).

## Restoring a Backup

`POST /api/backups/restore` with `{ destinationId, vmName, timestamp, newVmName }` — `(destinationId, vmName, timestamp)` are typically copied from a list row:

1. Read `domain.xml` and, when present, `manifest.json` from the backup
2. Decompress and copy disk images to the new VM's directory (`<vmsPath>/<newVmName>/`)
3. Copy NVRAM and cloud-init files
4. Rewrite domain XML: new name, new UUID, new MAC addresses, and **path updates** so every file reference under the original VM directory (including block disks, CD-ROM paths such as cloud-init, UEFI NVRAM, and optional loader paths under that directory) points at `<vmsPath>/<newVmName>/`. This uses **`manifest.vmBasePath`** when available (older backups fall back to the backed-up VM name or inferred paths). Disk images that lived outside the VM directory (e.g. image library) are still remapped using the same per-disk logic as before.
5. Define the new domain with `DomainDefineXML`

The restored VM gets a new name, new UUID, and new MAC addresses — it is a fully independent copy.

### `vmBasePath` portability

`manifest.vmBasePath` is recorded as an **absolute path** at backup time (e.g. `/var/lib/wisp/vms/<oldName>`). Restore uses it as the prefix to rewrite when emitting the new domain XML. This is resilient to the VM being renamed since the backup was taken (the manifest still points at the old path, which is what disk `<source file>` entries in the backup XML refer to), and also tolerates `vmsPath` changes (the rewrite produces paths under whatever `vmsPath` is configured **at restore time**).

Where it can fail: if a backup was produced under one `vmsPath` and you later move the entire `vms/` tree to a different absolute path **and** edit `wisp-config.json` accordingly, the manifest's recorded `vmBasePath` no longer matches anything Wisp recognises. In that uncommon case the restore falls back to inferring from the original VM name — and if that also doesn't match, the operator must edit `manifest.vmBasePath` to the path that was current when the backup was taken before retrying. We accept this rare manual step rather than carrying historical `vmsPath` history in the manifest.

## Deleting a Backup

`DELETE /api/backups` with `{ destinationId, vmName, timestamp }`:

- The route resolves `destinationId` to a configured destination root (rejecting unknown ids), validates `vmName` and `timestamp` against the same character class as backup creation, then constructs the absolute path server-side. The client never sends a path.
- The entire backup directory is removed.

## Progress Tracking

Backup creation and restore operations run as background jobs with SSE-based progress streaming:

- **Job store** manages job state (pending, running, complete, failed)
- **SSE stream** at `/api/vms/backup-progress/:jobId` (VMs) or `/api/containers/backup-progress/:jobId` (containers) pushes events
- Events include: step name, percent complete, current file being processed
- Completion event indicates success or failure

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

The pause happens as late as possible (after destination validation and dir creation) so the frozen window covers only measure + tar. If the archive fails, the partial backup dir is removed. The job spawns `tar -cf - <containerDir>`, pipes its stdout through Node's `createGzip()` and a bytes-counter `Transform` (driving percent against the pre-walked source size), then writes to `data.tar.gz`. After the archive is finalized, the manifest is written.

Progress steps are `pausing → measuring → archiving → resuming → done` (the pause/resume steps are skipped for cold archives). Events are emitted via the shared `backupJobStore` — same SSE consumer (`backgroundJobsStore` on the frontend, top-bar progress + modal mirror) as VM backups, just routed via `/api/containers/backup-progress/:jobId` and `JOB_KIND.CONTAINER_BACKUP`.

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

**Run:** containers are processed **sequentially** (at most one container frozen at a time), each as a `CONTAINER_BACKUP` job in the shared `backupJobStore` — visible in `GET /api/background-jobs`, streamable via the normal progress SSE, and picked up by the frontend's page-load job rehydration (an already-open tab doesn't learn of a scheduler-started job until reload). A container with a manual backup already running is skipped. Destination resolution failure (e.g. unreachable SMB share) aborts the run with a warning — containers are never left paused because a destination was missing. Per-container failures are logged and the run continues.

**Retention (GFS-lite, scheduled backups only):** after each successful backup, per container and per destination (`lib/backupRetention.js`):

- keep the **newest scheduled backup per calendar day** for the last `retainDays` days (today inclusive);
- among older scheduled backups, keep the **newest per ISO week** for the `retainWeeks` most recent weeks that have backups (presence-based, so a gap in the schedule never causes the only remaining old backups to be deleted);
- delete every other **scheduled** backup. **Manual backups — and backups predating the manifest `origin` field — are never auto-pruned.**

### Listing

`GET /api/container-backups[?containerName=]` scans each currently-usable destination's `containers/` subdirectory and reads each `manifest.json`. Entries without `type === "container"` are skipped (defensive). Rows carry `origin` (`"manual"` / `"scheduled"`). The VM list scanner (`GET /api/backups`) explicitly skips a top-level `containers/` directory under each root for the symmetric reason — keeps the two namespaces independent.

### Restoring

`POST /api/container-backups/restore` with `{ destinationId, name, timestamp, newName }`:

1. Validate `newName` (same rules as create — `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`, 1–63 chars). Reject if a container with that name already exists either on disk or in containerd.
2. Extract `data.tar.gz` into a temporary `.restore-<rand>` directory under `<containersPath>`. Verify the archive contains exactly one top-level directory (the original name).
3. Move that extracted directory to `<containersPath>/<newName>/` (atomic rename on the same filesystem).
4. Rewrite `container.json` with `name: <newName>` and a fresh **MAC address** (the old MAC stayed with the source container's DHCP lease — the restored copy gets a new lease). Drop any persisted `network.ip` (it belonged to the old MAC).
5. If the image referenced in `container.json` isn't present in containerd, **re-pull** it. Then refresh `imageDigest` / `imagePulledAt` to whatever's in containerd at restore time (which may differ from the manifest's digest if the registry has moved on — that's intentional: restore picks up the current image, mirroring how a normal start would behave).
6. Build a placeholder OCI spec and `Containers.Create` the new containerd container record. The snapshot is **not** prepared at restore time — it will be re-prepared from the current library image on the first start, exactly like any other stopped container.

The restored container is **independent** of the source: new MAC, new DHCP lease, fresh rootfs snapshot on first start. Local mount data carried in the archive lives under `files/<mountName>/` as expected.

### Notes on what survives restore

- **Local mount data** (`files/<mountName>/`) — captured in the archive, restored verbatim under the new name. File ownership inside the archive is preserved by `tar` (preserves UID/GID), which matters for `runAsRoot` containers with idmapped Local mounts.
- **Run logs** (`runs/`) — captured in the archive. The newest 10 runs travel with the backup; the run picker on the restored container will show them as historical entries.
- **Section assignment** — **not** captured. Section assignments are stored in `wisp-config.json` (`assignments`), not in the container directory. A restored container starts unassigned (Main bucket); the user can move it to a section after restore.
- **Storage-sourced mounts** (`mount.sourceId` referencing an entry in `settings.mounts`) — captured verbatim in `container.json`. Storage mount definitions live in `wisp-config.json` and are not part of the backup. If the destination host doesn't have the same `settings.mounts[X]` configured, the mount config is preserved but `assertBindSourcesReady` will reject the first start with **503** `CONTAINER_MOUNT_SOURCE_MISSING` or `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED`. The user fixes this by editing the mount row to point at a different source (or removing it) on the new host.
- **Secret env vars** — `container.json` stores secret values **in plaintext at rest** (the OCI process needs them at runtime); the backup archive carries them as-is. Treat the backup file the same as any other copy of a container's directory: it can leak credentials if it lands in untrusted hands. There is no separate encryption step for container backups in v1.
- **App-container `appConfig`** — captured as-is. Fields that defaulted from the original container name at create time (e.g. jellyfin's `publishedUrl: http://<oldName>.local:8096`, tinySamba's `server.netbiosName`) will still reference the old name; the user can edit them in the app's config UI after restore if they care.
- **Containerd container record** is recreated under the new id with `wisp.managed=true`; the old record (if it still exists on the source host) is unaffected.

### Deleting

`DELETE /api/container-backups` with `{ destinationId, name, timestamp }` — route resolves the destination root from `destinationId` and constructs the path; manager `rm -rf`s the timestamp directory after defense-in-depth allowed-root validation.

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
