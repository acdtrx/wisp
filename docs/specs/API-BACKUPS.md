# API — Backups

VM and container backups: lists, restore, delete. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Backups

### POST /api/vms/:name/backup · `admin`

Start a backup job. Returns a job ID; monitor progress via SSE.

- **Body:** `{ destinationIds?: ["local", "<mountId>"] }` (defaults to `["local"]`)
- **`destinationIds`:** Only `local` and, if configured in settings, the single `backupMountId` value are accepted (resolved by the shared `lib/backupDestinations.js` helper). Any other id returns **422**.
- **202:** `{ jobId: string, title: string }` — a [job](API.md#job-routes); `title` is e.g. `Backup <vmName>`
- **404:** `VM_NOT_FOUND`
- **409:** `VM_MUST_BE_OFFLINE` — the VM is not stopped (checked before the job is created; the manager re-checks inside the job); `VM_BUSY` — another operation on this VM (start, backup, delete, an edit) is running
- **422:** `BACKUP_DEST_UNKNOWN` / `BACKUP_DEST_NONE` — unknown destination id, or nothing resolved
- **503:** `BACKUP_MOUNT_FAILED` — SMB mount failed

### GET /api/vms/backup-progress/:jobId · `read`

SSE stream for backup progress.

- **Progress events:** `{ step, percent?, currentFile? }` — `step` values include `domain`, `disk`, `nvram`, `cloudinit`, `manifest`. `percent` spans the whole job: with several destinations each owns an equal slice and `currentFile` is prefixed with the destination label.
- **Per-destination completion:** `{ step: "destination-done", destinationId: string, percent: number, currentFile: string }` — not terminal; later destinations follow.
- **Completion (from job store, the only `done`):** `{ step: "done", timestamp: string }` — `timestamp` is the (last destination's) backup folder name (e.g. `2026-05-08T06-30-00`).
- **Failure (terminal):** `{ step: "error", error: string, detail: string }`

### GET /api/backups · `read`

List all backups across configured destinations. The backup is identified by the tuple `(destinationId, vmName, timestamp)`; the on-disk path is a server-side detail and not exposed.

- **Query:** `?vmName=ubuntu-server` (optional filter)
- **200:**

```json
[
  {
    "vmName": "ubuntu-server",
    "timestamp": "2026-05-08T06-30-00",
    "destinationId": "local",
    "destinationLabel": "Local",
    "sizeBytes": 5368709120,
    "origin": "manual"
  }
]
```

`destinationId` is `'local'` or the configured `backupMountId`. Pass it back unchanged on restore/delete. `origin` is `"manual"` or `"scheduled"`, as the manifest records it — every VM backup is `"manual"` (there is no VM scheduler); state migration `0007-repair-config-and-records` wrote `"manual"` into the manifests of backups taken before the field existed ([UPDATES.md § State migrations](UPDATES.md#state-migrations)). A backup that sat on a backup mount unmounted when `0007` ran has no `origin`; the UI shows it as manual, and retention never prunes it.

### POST /api/backups/restore · `admin`

Restore a backup as a new VM — the only VM restore; there is no VM restore-in-place ([BACKUPS.md → Scope](BACKUPS.md#scope-settled-2026-10-16)).

- **Body:** `{ destinationId: string, vmName: string, timestamp: string, newVmName: string }` — `(destinationId, vmName, timestamp)` are typically copied from a `GET /api/backups` row.
- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ name: string }`. The checks below, the archive's validation included, answer at once; the copy's failures are job errors (`BACKUP_RESTORE_FAILED`).
- **404:** backup not found
- **409:** `VM_EXISTS` / `VM_DIR_EXISTS` when `newVmName` is taken in libvirt or on disk (same rule as `POST /api/vms`)
- **422:** unknown `destinationId`, invalid `vmName`/`newVmName`, or invalid `timestamp`; `BACKUP_INVALID` when the backup's `domain.xml` or payload fails [validation](BACKUPS.md#archive-validation-vm-backups) (the message names the rule) or a restored disk has a backing file

### DELETE /api/backups · `admin`

Delete a backup.

- **Body:** `{ destinationId: string, vmName: string, timestamp: string }`
- **204:** deleted; announced on the `backups` topic
- **404:** backup not found
- **422:** invalid input (`INVALID_VM_NAME`, `BACKUP_INVALID` — including a target that would resolve to a destination root; see [BACKUPS.md → Deleting a Backup](BACKUPS.md#deleting-a-backup))

### POST /api/containers/:name/backup · `admin`

Start a container backup job. Mirrors `POST /api/vms/:name/backup` — same body shape, same destination resolution (shared `lib/backupDestinations.js` helper), same SMB auto-mount behavior. The container does **not** need to be stopped: a running container is paused (cgroup freezer) for the duration of the archive and resumed automatically; stopped/created containers are archived cold. Manual backups record `origin: "manual"` in the manifest. Details in [BACKUPS.md → Container Backups](BACKUPS.md#container-backups).

- **Body:** `{ destinationIds?: ["local", "<mountId>"] }` (defaults to `["local"]`)
- **202:** `{ jobId: string, title: string }` — a [job](API.md#job-routes); `title` is `Backup <name>`
- **409:** `CONTAINER_TASK_TRANSIENT` (task is `pausing`/`unknown` — retry shortly), `CONTAINER_BUSY` (a backup or another locked operation on this container is running — the job holds the [operation lock](CONTAINERS.md#per-container-operation-lock) until it settles)
- **422:** `BACKUP_DEST_UNKNOWN` / `BACKUP_DEST_NONE` — unknown destination id, or nothing resolved
- **503:** `BACKUP_MOUNT_FAILED` — SMB mount failed

### GET /api/containers/backup-progress/:jobId · `read`

SSE stream for container backup progress.

- **Progress events:** `{ step, percent?, currentFile? }` — `step` values include `pausing`, `measuring`, `archiving`, `resuming`, `manifest` (pause/resume steps only when the container was running). Percent is driven by uncompressed bytes through tar against the pre-walked source size (so it tracks real progress through the archive, not output bytes); it spans the whole job — with several destinations each owns an equal slice and `currentFile` is prefixed with the destination label.
- **Per-destination completion:** `{ step: "destination-done", destinationId: string, percent: number, currentFile: string }` — not terminal; later destinations follow.
- **Restore-in-place steps** (same stream, kind `container-restore`): `safety-*` (the safety backup), `extracting`, `swapping`, `registering`.
- **Completion (from job store, the only `done`):** `{ step: "done", timestamp: string }` — the last destination's backup folder name
- **Failure:** `{ step: "error", error: string, detail: string }`

### GET /api/container-backups · `read`

List all container backups across currently-usable destinations. Container backups have their own namespace; VM and container backups can never collide on identical names.

- **Query:** `?containerName=foo` (optional filter)
- **200:**

```json
[
  {
    "name": "caddy",
    "timestamp": "2026-05-02T15-30-00",
    "destinationId": "local",
    "destinationLabel": "Local",
    "sizeBytes": 12345678,
    "image": "caddy:latest",
    "origin": "manual"
  }
]
```

`origin` is `"manual"` or `"scheduled"`, as the manifest records it; state migration `0007-repair-config-and-records` wrote `"manual"` into the manifests of backups taken before the field existed ([UPDATES.md § State migrations](UPDATES.md#state-migrations)). A backup that sat on a backup mount unmounted when `0007` ran has no `origin`; the UI shows it as manual, and retention never prunes it.

### POST /api/container-backups/restore · `admin`

Restore a container backup under a new name. The new name must be free both on disk and in containerd. Image is re-pulled if missing locally; MAC address is regenerated; section assignment is **not** carried over (storage assignments live in `wisp-config.json`, not in the backup).

- **Body:** `{ destinationId: string, name: string, timestamp: string, newName: string }`
- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ name: string, sourceName: string, image: string | null }` — `sourceName` is the original container name from the manifest, useful when the user picked a backup whose folder name no longer matches. The job holds the new name's operation lock.
- **404:** backup not found
- **409:** `CONTAINER_EXISTS` if the new name is already in use; `CONTAINER_BUSY` while another operation holds the new name's [operation lock](CONTAINERS.md#per-container-operation-lock)
- **422:** `INVALID_CONTAINER_NAME`, `BACKUP_INVALID` (unknown destination, invalid timestamp, or a missing/malformed manifest)
- **503:** `NO_CONTAINERD` — containerd cannot be reached, so the new name was not checked; no job starts and nothing is written
- **Job errors:** `BACKUP_RESTORE_FAILED` if extraction or containerd record creation fails; `BACKUP_INVALID` for an invalid `container.json` inside the archive

### POST /api/container-backups/restore-in-place · `admin`

Restore a backup **over the live container it was taken from** (same name, same MAC and DHCP lease; the containerd record is kept, or recreated if missing). The container must be stopped. Runs as a background job (kind `container-restore`, title `Restore <name>`); progress via `GET /api/containers/backup-progress/:jobId`. `safetyBackup` (default `true`) archives the current state to the same destination first (its progress steps are prefixed `safety-` and mapped to 0–45% of the bar), then restores. Semantics in [BACKUPS.md → Restoring a container in place](BACKUPS.md#restoring-a-container-in-place).

- **Body:** `{ destinationId: string, name: string, timestamp: string, safetyBackup?: boolean }`
- **202:** `{ jobId: string, title: string }` — a [job](API.md#job-routes)
- **404:** `CONTAINER_NOT_FOUND` (workload deleted — restore as new instead)
- **409:** `CONTAINER_MUST_BE_STOPPED`, `CONTAINER_BUSY` (a backup, restore or other locked operation on this container is running; the job holds the [operation lock](CONTAINERS.md#per-container-operation-lock) until it settles)
- **422 / 503:** destination errors as for `POST /api/containers/:name/backup`

### DELETE /api/container-backups · `admin`

Delete a container backup.

- **Body:** `{ destinationId: string, name: string, timestamp: string }`
- **204:** deleted; announced on the `backups` topic
- **422:** `INVALID_CONTAINER_NAME`, `BACKUP_INVALID` (unknown destination, invalid timestamp, or a target that would resolve to a destination root)
