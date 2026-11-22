# Storage

Wisp manages two kinds of host-side storage mounts:

- **Network mounts (SMB/CIFS)** — shares defined by the user, mounted at backend startup and on demand.
- **Removable drives** — USB / SATA hotplug devices "adopted" by UUID and auto-mounted on insertion.

Both kinds share the same settings shape (`settings.mounts`), the same privileged helper (`wisp-mount`), and the same lifecycle (reconcile on startup; hard-converge orphan mounts under `/mnt/wisp/`).

## Data model

All mounts live in `settings.mounts` (array). Each entry carries a `type` discriminator.

### Common fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (UUID) |
| `type` | `"smb"` or `"disk"` |
| `label` | Display name |
| `mountPath` | Absolute mount point. **Must resolve under `/mnt/wisp/`** (no `..`, no symlink escape), and is **stored in canonical form** (settled 2026-11-22): a path typed with a trailing or doubled `/` is stored resolved, which is the form the mount table lists and `wisp-mount` takes. Enforced on add and update, and by the start's read of the settings; `wisp-mount` re-asserts it (see [Privileged helper](#privileged-helper)) so a regression can't shadow `/etc`, `/usr`, `/home`, etc. |
| `autoMount` | When true (default), Wisp mounts on startup (SMB) or on device insertion (disk) |

### SMB-only fields (`type: "smb"`)

| Field | Description |
|-------|-------------|
| `share` | The share, stored as `//host/share` or `//host/share/folder` (e.g. `//192.168.1.100/backups`). A share typed the Windows way (`\\host\share`) or with a trailing `/` is brought to that form when it is saved; one that still does not fit (no host, no share name, a comma) is refused with 422 `MOUNT_INVALID`, naming the form (settled 2026-11-22: the form is checked where it is typed, not when the helper refuses it at mount time) |
| `username` | SMB auth user (optional) |
| `password` | SMB auth password. Write-only — never returned in API responses; the response carries a `hasPassword: boolean` field instead so the UI can render an "on file" affordance without holding any secret. To leave the stored password unchanged on update, omit `password` (or send an empty string) — the backend treats both as "preserve". |
| `hasPassword` | (response only) `true` when an SMB password is on file. Never accepted on input. |

### Disk-only fields (`type: "disk"`)

| Field | Description |
|-------|-------------|
| `uuid` | Filesystem UUID (looked up as `/dev/disk/by-uuid/<uuid>`) |
| `fsType` | `ext4`, `btrfs`, `vfat`, `exfat`, or `ntfs3` |
| `readOnly` | When true, mount read-only. Forced to true for `ntfs3`. |

See [CONFIGURATION.md](CONFIGURATION.md) for the full schema and validation rules.

## Detection (disks)

`backend/src/lib/storage/linux/diskMonitor.js` enumerates block devices with filesystems:

1. List `/dev/disk/by-uuid/` — symlinks to underlying `/dev/sdXN` or `/dev/nvmeXnYpZ`.
2. For each UUID, read `/sys/class/block/<name>/dev` to get `major:minor`, then parse `/run/udev/data/b<maj>:<min>` for `ID_FS_TYPE`, `ID_FS_LABEL`, etc.
3. Read `/sys/class/block/<parent>/removable`, `/sys/class/block/<name>/size`, `/sys/class/block/<parent>/device/vendor`, `.../model`.
4. Cross-reference the [mount table](#mount-table) for `mountedAt`: the device's mount point under `/mnt/wisp` when it has one, else its first (settled 2026-11-12 — a drive Wisp mounted and a desktop also automounted elsewhere still reads as Wisp's).
5. Filter out ignored filesystem types (`crypto_LUKS`, `linux_raid_member`, `LVM2_member`, `zfs_member`, `swap`).

**Hotplug** is picked up via `fs.watch('/dev/disk/by-uuid/')` with a 300 ms debounce. Insertions, removals, and reformat (UUID change) all trigger re-enumeration.

No `udisks2` / `libudev` dependency — parsing `/run/udev/data/b<maj>:<min>` directly is a stable, documented interface (systemd ≥ 186).

Clients subscribe via `GET /api/host/disks/stream` (SSE). `GET /api/host/disks` returns a one-off snapshot.

### Device fields (API payload)

```json
{
  "uuid": "abc-123",
  "devPath": "/dev/sdb1",
  "fsType": "exfat",
  "label": "BACKUP",
  "sizeBytes": 107374182400,
  "removable": true,
  "vendor": "SanDisk",
  "model": "Cruzer",
  "mountedAt": "/mnt/wisp/backup"
}
```

## Adopt flow (disks)

A drive is "detected" when it appears on the stream with a supported filesystem. It becomes "adopted" when the user saves a mount entry referencing its UUID:

1. UI lists all detected drives whose UUID is **not** in `settings.mounts` as "Detected drives".
2. User clicks **Adopt** on a row → UI pre-fills `label`, `mountPath` (`/mnt/wisp/<slug>`), `fsType`, `readOnly` (`true` for `ntfs3`), `autoMount: true`.
3. On **Save**, UI POSTs `/api/host/mounts` with `type: "disk"`. Server persists and, if `autoMount` is true and the drive is currently present, immediately mounts it.
4. Once adopted, the same UUID disappears from the Detected list and appears under "Removable drives" with live mount/present state.

Re-insertion after unplug auto-mounts silently. Removal triggers a lazy unmount (`umount -l`) of the stale mount point.

## Privileged helper

`backend/scripts/wisp-mount` (installed at `/usr/local/bin/wisp-mount` by `scripts/linux/setup/install-helpers.sh`) is the single privileged invocation point, written in the helpers' dialect ([CODING-RULES §12](../CODING-RULES.md), Shell). **It takes arguments, not a config file** (settled 2026-11-22): every value is checked against what it may be, so nothing a share or a disk carries can add a mount option.

| Call | Purpose |
|------|---------|
| `smb-mount <share> <path> <credentials-file\|guest> <owner-only\|shared>` | `mount -t cifs`; `owner-only` for the backup mount |
| `smb-check <share> <path> <credentials-file\|guest>` | SMB test — mount then unmount, no persistent state |
| `disk-mount <uuid> <path> <fstype> <ro\|rw>` | `mount -t <fstype> /dev/disk/by-uuid/<uuid>` |
| `unmount <path>` | `umount`; a path that is not mounted is exit 2 (not there) |
| `unmount-lazy <path>` | `umount -l` (used on surprise device removal) |
| `rmdir <path>` | Remove the empty mount-point directory (delete flow only); a missing one is exit 2, one not empty or still mounted fails |

**What each argument may be.** A share is `//host/path` with no comma and no control character. A UUID is hex digits and dashes, and must name a block device under `/dev/disk/by-uuid/`. A filesystem type is one of `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3`. The owner of a mount (`uid`, `gid`) is not an argument: it is the user sudo ran the helper for.

**Path confinement.** Every path the helper acts on must be canonical and sit strictly under `/mnt/wisp/` (never `/mnt/wisp` itself), with no symbolic link below it; anything else exits `64`. `/mnt/wisp` is writable by the deploy user, so the checks assume a directory tree they do not control. `unmount*` and `rmdir` never `stat` the last component, because a `stat` on a dead CIFS share blocks until the server times out — the case `unmount-lazy` exists for; `unmount*` acts only when the path is listed as a mount point in `/proc/self/mounts`.

For SMB, **credentials never appear on argv** (`/proc/<pid>/cmdline`). The backend writes a mode-`0600` credentials file in `mount.cifs` format (`username=…` / `password=…` / `domain=…` lines), passes its path, and unlinks it once the helper returns. **A share without a password** (settled 2026-11-22): with no username either, the backend passes `guest` and the share is mounted as a guest; with a username, the file always carries a `password=` line, empty when none was given, so `mount.cifs` never asks on a terminal that is not there. Before, such a mount waited for an answer until it was killed.

Mount options are chosen by filesystem, and **every mount is `nosuid,nodev`** (settled 2026-11-22): a disk or a share can carry setuid programs and device files, and Wisp mounts what a user plugs in. `noexec` is not set: containers run what is on these mounts.

- `ext4` / `btrfs`: `nosuid,nodev[,ro]` (filesystem stores POSIX perms)
- `vfat` / `exfat` / `ntfs3`: `nosuid,nodev,uid=…,gid=…,umask=0007[,ro]` (ownership must be passed at mount time)
- `ntfs3`: forced `ro` (write support in `ntfs3` is still maturing; explicit opt-in could be added later)
- SMB: `rw,nosuid,nodev,credentials=<path>` or `guest`, `uid=…,gid=…`, and `file_mode=0600,dir_mode=0700` only with `owner-only`, which the backend asks for the share configured as the backup mount ([BACKUPS.md § Backup file modes](BACKUPS.md#backup-file-modes))

## Mount table

Every "what is mounted where" question — `getMountStatus`, the disk monitor's `mountedAt`, the startup orphan sweep, Host → Storage filesystem usage — reads the kernel mount table through one parser, `backend/src/lib/storage/mountTable.js` (`readMountTable` on the storage facade). It lives in `storage/` because mounts are storage's domain and `storage/` is the cross-cutting module both the managers and the host module may import (CODING-RULES §7); `host/` importing it keeps the dependency one-way.

- **Source:** `/proc/self/mounts`, the same table `wisp-mount` checks before unmounting, so the backend and the helper agree on what "mounted" means. `/proc/self/mountinfo` was considered and not used (settled 2026-10-16): its extra fields (mount ids, bind-mount roots, propagation) answer questions no consumer asks.
- **Escapes:** the kernel octal-escapes space, tab, newline and backslash inside fields (`\040`, `\011`, `\012`, `\134`); the parser decodes them, so a mount path with a space matches its configured `mountPath`.
- **Mounted means an exact mount point** (settled 2026-10-16). `getMountStatus(p)` is true only when an entry's mount point equals `p` (trailing slashes ignored). A mount on a parent directory does not count — with `/mnt` mounted, `/mnt/wisp/share` reads as unmounted until the share itself is mounted, so auto-mount still mounts it and backups / container binds never write into the parent filesystem's empty directory.
- **Stacked mounts** (several mounts on one path) stay separate entries in kernel order, which is mount order; the last one for a path is the visible one. Status: mounted if any entry matches. Orphan sweep: one detach per entry. Filesystem usage: one row per mount point, from the visible mount (the one `statfs` sees). Bind mounts are ordinary entries at each path they appear at.
- **No procfs** (macOS dev): the table is empty — nothing reads as mounted.

## Startup reconciliation (`ensureMounts`)

`backend/src/lib/mountsAutoMount.js` runs once at backend start, before the HTTP server listens:

1. Load `settings.mounts`.
2. Read the [mount table](#mount-table); any mount point strictly under `/mnt/wisp/` that is **not** a configured `mountPath` is lazy-unmounted (hard-converge), in reverse mount order so nested mounts and overmounts go before what they sit on; stacked mounts on one orphan path are each detached. This cleans up orphans left by a prior run or by user edits while Wisp was down. A mount at `/mnt/wisp` itself is never a candidate — it is the host's (e.g. a data disk mounted there), not Wisp's, and the helper refuses it anyway.
3. For each configured SMB entry with `autoMount !== false`: mount it if not already mounted.
4. For each configured **disk** entry with `autoMount !== false`: if the UUID is currently present (from the disk monitor snapshot) and not yet mounted, mount it. Absent UUIDs are skipped — they'll mount on insertion.

The reconciler is awaited before the HTTP listener starts, so Host Mgmt API traffic sees a consistent state.

## Hotplug (`installMountHotplugHandlers`)

After reconciliation, Wisp subscribes to `storage.onChange` (re-exported from `storage/linux/diskMonitor.js`). The handler diffs the previous UUID set against the current:

- **UUID appeared** and matches an adopted disk with `autoMount`: `mountDisk()` → `storage.refresh()` so the SSE stream pushes the new `mountedAt`.
- **UUID disappeared** and matches an adopted disk that was mounted: `unmountDisk({ lazy: true })`. Kernel cleans up after user error (pulled without safely-remove).

SMB mount toggles come only from explicit user action (`POST /api/host/mounts/:id/mount` / `…/unmount`) or the startup reconcile; SMB has no equivalent of physical hotplug.

## Periodic auto-mount retry (`startAutoMountRetry`)

For long-lived backends, an SMB mount that failed at boot (server unreachable, NIC up later) should keep being attempted in the background. `startAutoMountRetry` runs every **5 minutes**: for each configured SMB mount with `autoMount !== false`, it checks `getMountStatus` and calls `mountSMB` if not yet mounted. Disks are skipped — `installMountHotplugHandlers` already reacts to insertion events.

## Consumers

Storage mounts are designed to be referenced by other features. Current consumers:

- **Backup destinations** — `settings.backupMountId` can point at any storage mount; backup flows mount it on demand and write backup archives into it.
- **Container directory mounts** — a container's `mounts[].sourceId` can reference a storage mount id; `mounts[].subPath` scopes to a sub-directory. See [CONTAINERS.md](CONTAINERS.md) §**Mount entry** for the full flow (validation, pre-start checks, zip-upload restriction to Local).

`DELETE /api/host/mounts/:id` refuses with **409** `MOUNT_IN_USE` when any container's `mounts[*].sourceId` still references the id (detail lists the container names). The operator must remove the bind from those containers before the storage mount can be deleted, otherwise the next start would silently bind a missing source. Mirrors `assertBridgeNotInUse` for managed bridges. When Wisp cannot tell whether the mount is in use (the container list cannot be read), the delete is refused with that read's code and "Cannot tell whether … is in use: <cause>"; the same holds for a bridge, a library file and an OCI image (settled 2026-11-22).

## API

See [API-HOST.md](API-HOST.md) §**Storage / Mounts** for the full `/api/host/mounts/*` and `/api/host/disks/*` endpoints.

## UI

Host → Host Mgmt → **Storage** contains three stacked tables inside one SectionCard:

1. **Network mounts (SMB)** — label, share, mount path, user, password (masked), row actions: edit, test-connection, mount/unmount toggle, remove. Add button in the sub-section header.
2. **Removable drives** — label, short-UUID, fstype, mount path, read-only, auto-mount, **present** badge (green if UUID currently detected, red if adopted-but-absent), row actions: edit, mount/unmount toggle (only when present), remove.
3. **Detected drives** — appears only when the SSE stream shows at least one UUID that isn't in `settings.mounts`. Columns: device (vendor+model+devPath+short-UUID), label, fstype, size, "mounted at" (path if OS already mounted it outside `/mnt/wisp/`), **Adopt** button. Adopt pre-fills a new row in "Removable drives" in edit mode.

Mount state colour convention (shared with SMB):

- **Green** on the plug icon = currently mounted
- **Grey** = present but unmounted
- **Red** = adopted but not currently present (drive unplugged)

## Dependencies

- `cifs-utils` — SMB mount helper (installed by setup's packages step).
- `exfat` kernel module — since Linux 5.7 (universal on all Wisp-target distros).
- `ntfs3` kernel module — since Linux 5.15 (Ubuntu 22.04+, Debian 12+).
- No `ntfs-3g` dependency; do not install it.

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `MOUNT_NOT_FOUND` | 404 | No mount with the given `id` |
| `MOUNT_INVALID` | 422 | Missing/invalid fields in body |
| `MOUNT_DUPLICATE` | 409 | `id` already exists |
| `SMB_INVALID` | 422 | Invalid SMB input (share, mountPath, credential fields) |
| `SMB_MOUNT_UNAVAILABLE` | 503 | `wisp-mount` not installed or not runnable, or the share could not be mounted or reached (e.g. unreachable server) |
| `DISK_MOUNT_INVALID` | 422 | Missing/invalid fields for disk mount |
| `DISK_MOUNT_UNAVAILABLE` | 503 | `wisp-mount` not installed, UUID not present, or helper error |

See [ERROR-HANDLING.md](ERROR-HANDLING.md) for the global error-code table.

## Timeouts

(settled 2026-11-12, CODING-RULES §6.)
- `qemu-img info` and `resize`: **20 s** (settled 2026-11-13). A convert has no total bound: it is stopped after **10 min** with no progress output, no growth of the destination and no bytes read (the bytes-read probe settled 2026-11-13).
- `wisp-mount` bounds its own commands (the helpers' `bounded`: stopped at the limit, killed 2 s later), so each ends inside the backend's bound, which sits above the helper's worst case: a disk mount **20 s** of the backend's **40 s**; an SMB mount **20 s** of **50 s**; unmount **60 s** of **75 s** — long enough to flush after a large backup; an SMB check's mount **15 s** and umount **8 s** of **70 s** (the unmount and check bounds settled 2026-11-13; the backend's bounds raised 2026-11-22 to cover every command the helper runs on the way). `rmdir`: **15 s**.
- Unmount and mount delete run as server jobs (settled 2026-11-13): an unmount's 75 s outlasts a short request.
