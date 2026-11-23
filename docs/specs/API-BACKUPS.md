# API — Backups

VM and container backups: lists, restore, delete. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Backups

### POST /api/vms/:name/backup · `admin`

Start a backup job (kind `vm-backup`), on `GET /api/jobs/:jobId/progress`. It holds the VM's [operation lock](BACKUPS.md#per-vm-operation-lock) for the whole job; the attempt is recorded before `done` or the job's `error` — a record `{ at, ok, origin, destinationIds, timestamp? }`, a failure's with its error body (`error`, the code, and `detail`), pushed on the [`backups` topic](API.md#backups-topic-payload) ([BACKUPS.md → Backup attempt status](BACKUPS.md#backup-attempt-status)).

- **Body:** `{ destinationIds?: ["local", "<mountId>"] }` (defaults to `["local"]`)
- **`destinationIds`:** Only `local` and, if configured in settings, the single `backupMountId` value are accepted. Any other id returns **422** `BACKUP_DEST_UNKNOWN`.
- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes)'s [ack](API.md#background-jobs) (kind `vm-backup`); `title` is e.g. `Backup <vmName>`; `done` result: `{ timestamp }` — the (last destination's) backup folder name (e.g. `2026-05-08T06-30-00`)
- **404:** `VM_NOT_FOUND`
- **409:** `VM_MUST_BE_OFFLINE` — the VM is not stopped (checked under the lock before the job is created); `VM_BUSY` — another operation on this VM (start, backup, delete, an edit) is running
- **422:** `BACKUP_DEST_UNKNOWN` / `BACKUP_DEST_NONE` — unknown destination id, or nothing resolved
- **503:** `BACKUP_MOUNT_FAILED` — SMB mount failed

- **Progress events:** `{ step, percent?, currentFile? }` — `step` values include `domain`, `disk`, `nvram`, `cloudinit`, `manifest`. `percent` spans the whole job: with several destinations each owns an equal slice and `currentFile` is prefixed with the destination label.
- **Per-destination completion:** `{ step: "destination-done", destinationId: string, percent: number, currentFile: string }` — not terminal; later destinations follow.

### GET /api/backups · `read`

List all backups across configured destinations. The backup is identified by the tuple `(destinationId, vmName, timestamp)`; the on-disk path is a server-side detail and not exposed.

- **Query:** `?vmName=ubuntu-server` (optional filter; a name that breaks the name rules, or another key, is **400** `VALIDATION_FAILED`)
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

`destinationId` is `'local'` or the configured `backupMountId`. Pass it back unchanged on restore/delete. `origin` is `"manual"` or `"scheduled"`, as the manifest records it — every VM backup is `"manual"` (there is no VM scheduler). A backup whose manifest has no `origin` is shown as manual, and retention never prunes it.

### POST /api/backups/restore · `admin`

Restore a backup as a new VM — the only VM restore; there is no VM restore-in-place ([BACKUPS.md → Scope](BACKUPS.md#scope-settled-2026-10-16)).

- **Body:** `{ destinationId: string, vmName: string, timestamp: string, newVmName: string }` — `(destinationId, vmName, timestamp)` are typically copied from a `GET /api/backups` row.
- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) (kind `vm-restore`) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name: string }`. The job's subject is `newVmName`, whose [operation lock](BACKUPS.md#per-vm-operation-lock) it holds for the whole job. The checks below, the archive's validation included, answer at once; the copy's failures are job errors (`BACKUP_RESTORE_FAILED`).
- **404:** `BACKUP_NOT_FOUND` — backup not found
- **409:** `VM_EXISTS` / `VM_DIR_EXISTS` when `newVmName` is taken in libvirt or on disk (same rule as `POST /api/vms`); `VM_BUSY` while another job holds `newVmName`'s lock
- **400:** `VALIDATION_FAILED` — a `vmName` / `newVmName` that breaks the [name rules](ERROR-HANDLING.md#name-validation), a `timestamp` that is not a backup folder's name (a leading letter or digit, then letters, digits, `.`, `_`, `-`, at most 64), an empty `destinationId`, a missing or unknown key
- **422:** `BACKUP_INVALID` for an unknown `destinationId`; `BACKUP_INVALID` when the backup's `domain.xml` or payload fails [validation](BACKUPS.md#archive-validation-vm-backups) (the message names the rule) or a restored disk has a backing file

### DELETE /api/backups · `admin`

Delete a backup.

- **Body:** `{ destinationId: string, vmName: string, timestamp: string }`
- **204:** deleted; announced on the `backups` topic
- **404:** `BACKUP_NOT_FOUND` — backup not found
- **400:** `VALIDATION_FAILED` — the body fails its schema, as for the restore
- **422:** `BACKUP_INVALID` — an unknown `destinationId`, or a target that would resolve to a destination root (see [BACKUPS.md → Deleting a Backup](BACKUPS.md#deleting-a-backup))

### POST /api/containers/:name/backup · `admin`

Start a container backup job (kind `container-backup`), on `GET /api/jobs/:jobId/progress`. Mirrors `POST /api/vms/:name/backup` — same body shape, same destination resolution, same SMB auto-mount behavior. The container does **not** need to be stopped: a running container is paused (cgroup freezer) for the duration of the archive and resumed automatically; stopped/created containers are archived cold. Manual backups record `origin: "manual"` in the manifest. Details in [BACKUPS.md → Container Backups](BACKUPS.md#container-backups).

- **Body:** `{ destinationIds?: ["local", "<mountId>"] }` (defaults to `["local"]`)
- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes)'s [ack](API.md#background-jobs) (kind `container-backup`); `title` is `Backup <name>`; `done` result: `{ timestamp }` — the last destination's backup folder name. The attempt is recorded before `done` or `error`, as for a VM.
- **404:** `CONTAINER_NOT_FOUND` (checked under the lock before the job is created)
- **409:** `CONTAINER_TASK_TRANSIENT` (task is `pausing`/`unknown` — retry shortly), `CONTAINER_BUSY` (a backup or another locked operation on this container is running — the job holds the [operation lock](CONTAINERS.md#per-container-operation-lock) until it settles)
- **422:** `BACKUP_DEST_UNKNOWN` / `BACKUP_DEST_NONE` — unknown destination id, or nothing resolved
- **503:** `BACKUP_MOUNT_FAILED` — SMB mount failed

- **Progress events:** `{ step, percent?, currentFile? }` — `step` values include `pausing`, `measuring`, `archiving`, `resuming`, `manifest` (pause/resume steps only when the container was running). Percent is driven by uncompressed bytes through tar against the pre-walked source size (so it tracks real progress through the archive, not output bytes); it spans the whole job — with several destinations each owns an equal slice and `currentFile` is prefixed with the destination label.
- **Per-destination completion:** `{ step: "destination-done", destinationId: string, percent: number, currentFile: string }` — not terminal; later destinations follow.

### GET /api/container-backups · `read`

List all container backups across currently-usable destinations. Container backups have their own namespace; VM and container backups can never collide on identical names.

- **Query:** `?containerName=foo` (optional filter; as for `vmName`)
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

`origin` is `"manual"` or `"scheduled"`, as the manifest records it. A backup whose manifest has no `origin` is shown as manual, and retention never prunes it.

### POST /api/container-backups/restore · `admin`

Restore a container backup under a new name. The new name must be free both on disk and in containerd. Image is re-pulled if missing locally; MAC address is regenerated; section assignment is **not** carried over (storage assignments live in `wisp-config.json`, not in the backup).

- **Body:** `{ destinationId: string, name: string, timestamp: string, newName: string }`
- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) (kind `container-restore-new`) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name: string, sourceName: string, image: string | null }` — `sourceName` is the original container name from the manifest, useful when the user picked a backup whose folder name no longer matches. The job holds the new name's operation lock.
- **404:** `BACKUP_NOT_FOUND` — backup not found
- **409:** `CONTAINER_EXISTS` if the new name is already in use; `CONTAINER_BUSY` while another operation holds the new name's [operation lock](CONTAINERS.md#per-container-operation-lock)
- **400:** `VALIDATION_FAILED` — a name that breaks the name rules, a malformed `timestamp`, a missing or unknown key
- **422:** `BACKUP_INVALID` (unknown destination, or a missing/malformed manifest)
- **503:** `NO_CONTAINERD` — containerd cannot be reached, so the new name was not checked; no job starts and nothing is written
- **Job errors:** `BACKUP_RESTORE_FAILED` if extraction or containerd record creation fails; `BACKUP_INVALID` for an invalid `container.json` inside the archive

### POST /api/container-backups/restore-in-place · `admin`

Restore a backup **over the live container it was taken from** (same name, same MAC and DHCP lease; the containerd record is kept, or recreated if missing). The container must be stopped. Runs as a background job (kind `container-restore`, title `Restore <name>`) on `GET /api/jobs/:jobId/progress`, holding the container's [operation lock](CONTAINERS.md#per-container-operation-lock) for the whole job, the safety backup included. Progress steps: `safety-*` (the safety backup), `extracting`, `swapping`, `registering`. `safetyBackup` (default `true`) archives the current state to the same destination first (its progress steps are prefixed `safety-` and mapped to 0–45% of the bar), then restores. Semantics in [BACKUPS.md → Restoring a container in place](BACKUPS.md#restoring-a-container-in-place).

- **Body:** `{ destinationId: string, name: string, timestamp: string, safetyBackup?: boolean }`
- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes)'s [ack](API.md#background-jobs) (kind `container-restore`); `done` result: `{ name, image }`. The safety backup runs through the same orchestration as any backup, and its attempt is recorded inside the job.
- **400:** `VALIDATION_FAILED` — the body fails its schema, as for the restore as new
- **404:** `CONTAINER_NOT_FOUND` (workload deleted — restore as new instead; checked under the lock before the job is created)
- **409:** `CONTAINER_MUST_BE_STOPPED`, `CONTAINER_BUSY` (a backup, restore or other locked operation on this container is running; the job holds the [operation lock](CONTAINERS.md#per-container-operation-lock) until it settles)
- **422 / 503:** destination errors as for `POST /api/containers/:name/backup`

### DELETE /api/container-backups · `admin`

Delete a container backup.

- **Body:** `{ destinationId: string, name: string, timestamp: string }`
- **204:** deleted; announced on the `backups` topic
- **400:** `VALIDATION_FAILED` — the body fails its schema, as for the restore
- **422:** `BACKUP_INVALID` (unknown destination, or a target that would resolve to a destination root)
