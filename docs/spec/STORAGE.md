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
| `mountPath` | Absolute mount point (must start with `/`) |
| `autoMount` | When true (default), Wisp mounts on startup (SMB) or on device insertion (disk) |

### SMB-only fields (`type: "smb"`)

| Field | Description |
|-------|-------------|
| `share` | SMB URL (e.g. `//192.168.1.100/backups`) |
| `username` | SMB auth user (optional) |
| `password` | SMB auth password (masked as `***` in API responses) |

### Disk-only fields (`type: "disk"`)

| Field | Description |
|-------|-------------|
| `uuid` | Filesystem UUID (looked up as `/dev/disk/by-uuid/<uuid>`) |
| `fsType` | `ext4`, `btrfs`, `vfat`, `exfat`, or `ntfs3` |
| `readOnly` | When true, mount read-only. Forced to true for `ntfs3`. |

See [CONFIGURATION.md](CONFIGURATION.md) for the full schema and validation rules.

## Detection (disks)

`backend/src/lib/linux/host/diskMonitor.js` enumerates block devices with filesystems:

1. List `/dev/disk/by-uuid/` — symlinks to underlying `/dev/sdXN` or `/dev/nvmeXnYpZ`.
2. For each UUID, read `/sys/class/block/<name>/dev` to get `major:minor`, then parse `/run/udev/data/b<maj>:<min>` for `ID_FS_TYPE`, `ID_FS_LABEL`, etc.
3. Read `/sys/class/block/<parent>/removable`, `/sys/class/block/<name>/size`, `/sys/class/block/<parent>/device/vendor`, `.../model`.
4. Cross-reference `/proc/mounts` for `mountedAt`.
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

`backend/scripts/wisp-mount` (installed at `/usr/local/bin/wisp-mount` by `scripts/linux/setup/install-helpers.sh`) is the single privileged invocation point. The backend writes a temp config file (mode `0600`) per operation, runs the helper via `sudo -n`, then the helper removes the config after use.

| Subcommand | Purpose |
|------------|---------|
| `smb mount <configPath>` | `mount -t cifs` (config supplies share, mountPath, username, password, uid, gid) |
| `smb check <configPath>` | SMB test — mount then unmount, no persistent state |
| `disk mount <configPath>` | `mount -t <fsType> /dev/disk/by-uuid/<uuid>` (config supplies uuid, mountPath, fsType, readOnly, uid, gid) |
| `unmount <path>` | `umount` |
| `unmount-lazy <path>` | `umount -l` (used on surprise device removal) |

Mount options are chosen by filesystem:

- `ext4` / `btrfs`: `defaults[,ro]` (filesystem stores POSIX perms)
- `vfat` / `exfat` / `ntfs3`: `uid=$uid,gid=$gid,umask=0007[,ro]` (ownership must be passed at mount time)
- `ntfs3`: forced `ro` (write support in `ntfs3` is still maturing; explicit opt-in could be added later)
- SMB: `rw,uid=$uid,gid=$gid[,username=...,password=...]`

## Startup reconciliation (`ensureMounts`)

`backend/src/lib/mountsAutoMount.js` runs once at backend start, before the HTTP server listens:

1. Load `settings.mounts`.
2. Read `/proc/mounts`; any mount under `/mnt/wisp/` that is **not** in `settings.mounts` is lazy-unmounted (hard-converge). This cleans up orphans left by a prior run or by user edits while Wisp was down.
3. For each configured SMB entry with `autoMount !== false`: mount it if not already mounted.
4. For each configured **disk** entry with `autoMount !== false`: if the UUID is currently present (from the disk monitor snapshot) and not yet mounted, mount it. Absent UUIDs are skipped — they'll mount on insertion.

The reconciler is awaited before the HTTP listener starts, so Host Mgmt API traffic sees a consistent state.

## Hotplug (`installMountHotplugHandlers`)

After reconciliation, Wisp subscribes to `diskMonitor.onChange`. The handler diffs the previous UUID set against the current:

- **UUID appeared** and matches an adopted disk with `autoMount`: `mountDisk()` → `diskMonitor.refresh()` so the SSE stream pushes the new `mountedAt`.
- **UUID disappeared** and matches an adopted disk that was mounted: `unmountDisk({ lazy: true })`. Kernel cleans up after user error (pulled without safely-remove).

SMB mount toggles come only from explicit user action (`POST /api/host/mounts/:id/mount` / `…/unmount`) or the startup reconcile; SMB has no equivalent of physical hotplug.

## API

See [API.md](API.md) §**Storage / Mounts** for the full `/api/host/mounts/*` and `/api/host/disks/*` endpoints.

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

- `cifs-utils` (apt) / `cifs-utils` (pacman) — SMB mount helper (installed automatically by `install-helpers.sh` when registering `wisp-mount`).
- `exfat` kernel module — since Linux 5.7 (universal on all Wisp-target distros).
- `ntfs3` kernel module — since Linux 5.15 (Ubuntu 22.04+, Debian 12+, Arch current, Fedora current).
- No `ntfs-3g` dependency; do not install it.

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `MOUNT_NOT_FOUND` | 404 | No mount with the given `id` |
| `MOUNT_INVALID` | 422 | Missing/invalid fields in body |
| `MOUNT_DUPLICATE` | 409 | `id` already exists |
| `SMB_INVALID` | 503 | SMB helper rejected input (e.g. unreachable server) |
| `SMB_MOUNT_UNAVAILABLE` | 503 | `wisp-mount` not installed or not runnable |
| `DISK_MOUNT_INVALID` | 422 | Missing/invalid fields for disk mount |
| `DISK_MOUNT_UNAVAILABLE` | 503 | `wisp-mount` not installed, UUID not present, or helper error |

See [ERROR-HANDLING.md](ERROR-HANDLING.md) for the global error-code table.
