# Storage

Wisp manages two kinds of host-side storage mounts:

- **Network mounts (SMB/CIFS)** — shares defined by the user, mounted at backend startup and on demand.
- **Removable drives** — USB / SATA hotplug devices "adopted" by UUID and auto-mounted on insertion.

Both kinds share the same settings shape (`settings.mounts`), the same privileged helper (`wisp-mount`), and the same lifecycle.

## Data model

All mounts live in `settings.mounts` (array). Each entry carries a `type` discriminator. This is the mount object's home; [CONFIGURATION.md](CONFIGURATION.md) holds the rest of the settings file.

### Common fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (UUID) |
| `type` | `"smb"` or `"disk"` |
| `label` | Display name |
| `mountPath` | Absolute mount point. **Must resolve under `/mnt/wisp/`** (no `..`, no symlink escape), and is **stored in canonical form** (settled 2026-11-22): a path typed with a trailing or doubled `/` is stored resolved, which is the form the mount table lists and `wisp-mount` takes. Enforced on add and update, and by the start's read of the settings; `wisp-mount` checks it again. |
| `autoMount` | When true (default), Wisp mounts on startup (SMB) or on device insertion (disk) |

### SMB-only fields (`type: "smb"`)

| Field | Description |
|-------|-------------|
| `share` | The share, stored as `//host/share` or `//host/share/folder` (settled 2026-11-22). A share typed the Windows way (`\\host\share`) or with a trailing `/` is brought to that form when it is saved; one that still does not fit (no host, no share name, a comma) is refused with 422 `MOUNT_INVALID`, naming the form. |
| `username` | SMB auth user (optional) |
| `password` | SMB auth password. Write-only: never returned. To leave the stored password unchanged on update, omit `password` or send an empty string. |
| `hasPassword` | (response only) `true` when an SMB password is on file. Never accepted on input. |

### Disk-only fields (`type: "disk"`)

| Field | Description |
|-------|-------------|
| `uuid` | Filesystem UUID (looked up as `/dev/disk/by-uuid/<uuid>`) |
| `fsType` | `ext4`, `btrfs`, `vfat`, `exfat`, or `ntfs3` |
| `readOnly` | When true, mount read-only. Forced to true for `ntfs3`. |

## Detected drives

`GET /api/host/disks` returns the block devices that carry a filesystem, and `GET /api/host/disks/stream` (SSE) follows insertions, removals and reformats (a UUID change).

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

- `mountedAt` is the device's mount point under `/mnt/wisp` when it has one, else its first (settled 2026-11-12).
- `crypto_LUKS`, `linux_raid_member`, `LVM2_member`, `zfs_member` and `swap` are not listed.
- Devices are read from `/dev/disk/by-uuid/`, sysfs and udev's data files. No `udisks2` or `libudev` dependency.

## Adopted drives

A detected drive becomes adopted when a mount entry with its UUID is saved (`POST /api/host/mounts`, `type: "disk"`). The Detected list holds only drives whose UUID is not in `settings.mounts`, so an adopted drive leaves it. Adopting pre-fills the form from the device: its label, its filesystem, read-only for `ntfs3`, auto-mount on, and the mount path `/mnt/wisp/disk-<first 8 characters of the UUID>`.

- With `autoMount` and the drive present, the save mounts it at once.
- An adopted drive mounts by itself each time it is inserted.
- A drive pulled while mounted is lazily unmounted.
- SMB mounts change only by a user's mount or unmount, the startup reconciliation and the retry below.

## Privileged helper

`wisp-mount` is the single privileged invocation point, written in the helpers' dialect ([CODING-RULES §12](../CODING-RULES.md), Shell). **It takes arguments, not a config file** (settled 2026-11-22), so nothing a share or a disk carries can add a mount option.

| Call | Purpose |
|------|---------|
| `smb-mount <share> <path> <credentials-file\|guest> <owner-only\|shared>` | `mount -t cifs`; `owner-only` for the backup mount |
| `smb-check <share> <path> <credentials-file\|guest>` | SMB test — mount then unmount, no persistent state |
| `disk-mount <uuid> <path> <fstype> <ro\|rw>` | `mount -t <fstype> /dev/disk/by-uuid/<uuid>` |
| `unmount <path>` | `umount`; a path that is not mounted is exit 2 (not there) |
| `unmount-lazy <path>` | `umount -l` (used on surprise device removal) |
| `rmdir <path>` | Remove the empty mount-point directory (delete flow only); a missing one is exit 2, one not empty or still mounted fails |

**What each argument may be.** A share is `//host/path` with no comma and no control character. A UUID is hex digits and dashes, and must name a block device under `/dev/disk/by-uuid/`. A filesystem type is one of `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3`. The owner of a mount (`uid`, `gid`) is not an argument: it is the user sudo ran the helper for.

**Path confinement.** Every path the helper acts on must be canonical and sit strictly under `/mnt/wisp/` (never `/mnt/wisp` itself), with no symbolic link below it; anything else exits `64`. `/mnt/wisp` is writable by the deploy user, so the checks assume a directory tree they do not control. `unmount*` and `rmdir` never `stat` the last component, because a `stat` on a dead CIFS share blocks until the server times out; `unmount*` acts only when the path is listed as a mount point in `/proc/self/mounts`.

**Credentials never appear on argv.** The backend writes a mode-`0600` credentials file in `mount.cifs` format, passes its path, and unlinks it once the helper returns. **A share without a password** (settled 2026-11-22): with no username either, the backend passes `guest`; with a username, the file always carries a `password=` line, empty when none was given, so `mount.cifs` never asks on a terminal that is not there.

**Every mount is `nosuid,nodev`** (settled 2026-11-22). `noexec` is not set: containers run what is on these mounts.

- `ext4` / `btrfs`: `nosuid,nodev[,ro]`
- `vfat` / `exfat` / `ntfs3`: `nosuid,nodev,uid=…,gid=…,umask=0007[,ro]`
- `ntfs3`: forced `ro` (its write support is still maturing)
- SMB: `rw,nosuid,nodev,credentials=<path>` or `guest`, `uid=…,gid=…`, and `file_mode=0600,dir_mode=0700` only with `owner-only`, which the backend asks for the share configured as the backup mount ([BACKUPS.md § Backup file modes](BACKUPS.md#backup-file-modes))

No `ntfs-3g`: do not install it. The host needs `exfat` in its kernel (since Linux 5.7) and `ntfs3` (since 5.15).

## Mount table

Every "what is mounted where" question (a mount's status, a drive's `mountedAt`, the startup orphan sweep, the Host page's filesystem usage) reads the kernel mount table through one parser, on the storage facade.

- **Source:** `/proc/self/mounts`, the table `wisp-mount` checks before unmounting, so the backend and the helper agree on what "mounted" means (settled 2026-10-16; not `/proc/self/mountinfo`).
- **Escapes:** the kernel octal-escapes space, tab, newline and backslash inside fields; the parser decodes them, so a mount path with a space matches its configured `mountPath`.
- **Mounted means an exact mount point** (settled 2026-10-16). A mount on a parent directory does not count: with `/mnt` mounted, `/mnt/wisp/share` reads as unmounted until the share itself is mounted, so backups and container binds never write into the parent filesystem's empty directory.
- **Stacked mounts** (several mounts on one path) stay separate entries in mount order; the last one for a path is the visible one. Status: mounted if any entry matches. Orphan sweep: one detach per entry. Filesystem usage: one row per mount point, from the visible mount.
- **No procfs** (macOS dev): the table is empty, so nothing reads as mounted.

## Startup reconciliation

Runs once at backend start and is awaited before the HTTP server listens, so the first request sees a consistent state.

- Any mount point strictly under `/mnt/wisp/` that is not a configured `mountPath` is lazily unmounted, in reverse mount order; stacked mounts on one orphan path are each detached. A mount at `/mnt/wisp` itself is never a candidate: it is the host's, not Wisp's.
- Each configured SMB entry with `autoMount` is mounted if it is not.
- Each configured disk entry with `autoMount` whose UUID is present is mounted if it is not; an absent one mounts on insertion.

**Retry.** Every 5 minutes, each configured SMB mount with `autoMount` that is not mounted is tried again, so a share whose server came up after Wisp gets mounted. Disks are not retried: insertion mounts them.

## Consumers

- **Backup destinations** — `settings.backupMountId` can point at any storage mount; a backup mounts it on demand.
- **Container directory mounts** — a container's `mounts[].sourceId` can reference a storage mount id, and `mounts[].subPath` a sub-directory of it ([CONTAINERS.md](CONTAINERS.md), Mount entry).

`DELETE /api/host/mounts/:id` refuses with **409** `MOUNT_IN_USE` while a container's mount references the id (the detail lists the container names). When Wisp cannot tell whether the mount is in use (the container list cannot be read), the delete is refused with that read's code and "Cannot tell whether … is in use: <cause>"; the same holds for a bridge, a library file and an OCI image (settled 2026-11-22).

## API and error codes

Routes: the `/api/host/mounts` routes in [API-HOST.md](API-HOST.md) (under Settings). Codes: [ERROR-HANDLING.md](ERROR-HANDLING.md).

## Timeouts

(settled 2026-11-12, CODING-RULES §6.)
- `qemu-img info` and `resize`: **20 s** (settled 2026-11-13). A convert has no total bound: it is stopped after **10 min** with no progress output, no growth of the destination and no bytes read (the bytes-read probe settled 2026-11-13).
- `wisp-mount` bounds its own commands, so each ends inside the backend's bound, which sits above the helper's worst case: a disk mount **20 s** of the backend's **40 s**; an SMB mount **20 s** of **50 s**; unmount **60 s** of **75 s**; an SMB check's mount **15 s** and umount **8 s** of **70 s** (the unmount and check bounds settled 2026-11-13; the backend's bounds raised 2026-11-22 to cover every command the helper runs on the way). `rmdir`: **15 s**.
- Unmount and mount delete run as server jobs (settled 2026-11-13): an unmount's 75 s outlasts a short request.
