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
| `VARS.fd` | UEFI NVRAM file (if UEFI firmware) |
| `cloud-init.iso.gz` | Gzipped cloud-init seed ISO (if cloud-init was enabled) |
| `cloud-init.json` | Cloud-init configuration (if cloud-init was enabled) |

Disk images and the cloud-init ISO are gzipped to reduce backup size. NVRAM and config files are stored uncompressed.

## Backup Directory Structure

```
<destination>/<vm-name>/<timestamp>/
├── manifest.json
├── domain.xml
├── disk0.qcow2.gz
├── VARS.fd
├── cloud-init.iso.gz
└── cloud-init.json
```

The timestamp format is used as the directory name (e.g. `20250115-103000`).

## Backup Destinations

### Local

The default backup path is `/var/lib/wisp/backups` (configurable via `backupLocalPath` in `config/wisp-config.json`).

### Optional network mount

SMB/CIFS shares are defined under **`networkMounts`** in settings (**Host → Host Mgmt → Network Storage**). Only one mount may be selected for backups via **`backupNetworkMountId`** (**Host → Host Mgmt → Backup**). When set, that mount’s local path is offered as a second destination in the VM Overview backup modal (alongside Local).

Each network mount entry includes **id**, **label**, **share**, **mountPath**, **username** / **password** as documented in [CONFIGURATION.md](CONFIGURATION.md).

SMB shares must be mounted before use (or the backup job attempts to auto-mount). Mount/unmount/status use the `wisp-smb` helper script (invoked with `sudo`).

### Auto-mount

At backend startup, the system attempts to mount all configured **`networkMounts`** that define a **share**. Failures are logged but do not prevent the backend from starting.

## Creating a Backup

1. Client sends `POST /api/vms/:name/backup` with `destinationIds` (e.g. `["local"]` or `["local", "<backupNetworkMountId>"]`) or explicit `destinationPaths`
2. Backend resolves paths from `backupLocalPath` and, when requested, the mount referenced by `backupNetworkMountId` (with mount check / auto-mount for SMB)
3. A background job is created (returns `jobId`)
4. For each destination path:
   - Create backup directory `<dest>/<vmName>/<timestamp>/`
   - Save domain XML
   - Gzip and copy each disk image
   - Copy NVRAM file (if present)
   - Gzip and copy cloud-init ISO (if present)
   - Copy cloud-init config (if present)
   - Write manifest.json
5. Progress is reported via SSE: `{ step, percent, currentFile }`

## Listing Backups

`GET /api/backups` scans configured destinations that are currently usable: always the local backup path; the network path only if `backupNetworkMountId` is set **and** (for SMB) the share is mounted. For each found backup, returns: VM name, timestamp, full path, total size in bytes, and destination label.

Optional `?vmName=` filter restricts results to a specific VM.

A configured network backup path that is not mounted is omitted from the scan (same as before for unmounted SMB).

## Restoring a Backup

`POST /api/backups/restore` with `{ backupPath, newVmName }`:

1. Read `domain.xml` and, when present, `manifest.json` from the backup
2. Decompress and copy disk images to the new VM's directory (`<vmsPath>/<newVmName>/`)
3. Copy NVRAM and cloud-init files
4. Rewrite domain XML: new name, new UUID, new MAC addresses, and **path updates** so every file reference under the original VM directory (including block disks, CD-ROM paths such as cloud-init, UEFI NVRAM, and optional loader paths under that directory) points at `<vmsPath>/<newVmName>/`. This uses **`manifest.vmBasePath`** when available (older backups fall back to the backed-up VM name or inferred paths). Disk images that lived outside the VM directory (e.g. image library) are still remapped using the same per-disk logic as before.
5. Define the new domain with `DomainDefineXML`

The restored VM gets a new name, new UUID, and new MAC addresses — it is a fully independent copy.

## Deleting a Backup

`DELETE /api/backups` with `{ backupPath }`:

- The path is validated to be under one of the configured backup destination roots (local path and, when set, the selected network mount path — safety check to prevent arbitrary path deletion)
- The entire backup directory is removed

## Progress Tracking

Backup creation and restore operations run as background jobs with SSE-based progress streaming:

- **Job store** manages job state (pending, running, complete, failed)
- **SSE stream** at `/api/vms/backup-progress/:jobId` pushes events
- Events include: step name, percent complete, current file being processed
- Completion event indicates success or failure

## Network mount operations (settings API)

| Operation | Endpoint | Description |
|-----------|----------|-------------|
| Status | `GET /api/settings/network-mounts/status` | Mount status for all configured network mounts |
| Check | `POST /api/settings/network-mounts/check` | Test SMB connection (does not mount) |
| Mount | `POST /api/settings/network-mounts/:id/mount` | Mount a share |
| Unmount | `POST /api/settings/network-mounts/:id/unmount` | Unmount a share |

The `wisp-smb` helper script handles the actual mount/unmount operations and is invoked via `sudo` for the necessary filesystem permissions.
