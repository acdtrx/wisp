# Settings

Settings are split across the Host panel: **App Config** tab (application-wide configuration and password change) and **Host Mgmt** tab (OS updates, network bridge management, **Storage** for SMB/CIFS shares and adopted removable drives, and **Backup** for local path plus optional mount used for VM backups). Host information is in the **Overview** tab.

## Settings Fields

| Field | Type | Constraints | Description |
|-------|------|------------|-------------|
| Server name | string or null | — | Display name shown in the top bar. When null or empty in the config file, the API returns **`My Server`**. |
| VM storage path | string | Must start with `/` | Absolute path where per-VM directories are created. |
| Image library path | string | Must start with `/` | Absolute path for the image library. |
| Container storage path | string | Must start with `/` | Absolute root for container bundles (persisted in `wisp-config.json`; not edited in the App Config UI today). |
| Backup local path | string | Must start with `/` | Absolute path for local backups. |
| Refresh interval | integer | 1–60 seconds | Interval (in seconds) at which the VM list SSE stream sends updates. |

Settings are persisted in `config/wisp-config.json`. The config file is updated with a mutex to prevent concurrent writes.

## Storage (`mounts`)

Configured in **Host → Host Mgmt → Storage**. Each entry has a `type` discriminator (`smb` or `disk`) and common fields (id, label, mount path, autoMount).

SMB/CIFS mount fields:

| Field | Description |
|-------|-------------|
| ID | Unique identifier (auto-generated or user-set) |
| Label | Display name (e.g. "NAS share") |
| Share | SMB share URL (e.g. `//192.168.1.100/backups`) |
| Mount path | Local mount point (e.g. `/mnt/wisp/smb`) |
| Username | SMB authentication username |
| Password | SMB authentication password |
| Auto-mount | When true, mount at backend startup |

Disk mount fields (adopted removable drive):

| Field | Description |
|-------|-------------|
| ID | Unique identifier |
| Label | Display name |
| UUID | Filesystem UUID (stable across ports) |
| Mount path | Local mount point (e.g. `/mnt/wisp/backup-drive`) |
| Filesystem | `ext4`, `btrfs`, `vfat`, `exfat`, or `ntfs3` |
| Read-only | When true, mount read-only (mandatory for `ntfs3`) |
| Auto-mount | When true, mount on device insertion |

### Password masking

When reading settings, SMB passwords are returned as `***`. When saving, if the password value is `***`, the original password is preserved (not overwritten).

### Mount operations

**Host → Host Mgmt → Storage**: add/edit/remove mounts via row-scoped **POST** / **PATCH** / **DELETE** on `/api/host/mounts`; **Mount**, **Unmount**, and **Check** (SMB only) per mount; status (mounted or not). See [API.md](API.md).

## Backup (`backupLocalPath`, `backupMountId`)

Configured in **Host → Host Mgmt → Backup**.

| Setting | Description |
|---------|-------------|
| `backupLocalPath` | Local directory for VM backups (always available as a destination in the VM backup modal). |
| `backupMountId` | Optional. If set to a mount `id` from `mounts`, that mount appears as a second destination in the VM Overview backup modal. Use `(none)` when no extra destination should be offered for backups. |

Backups still require the VM to be stopped. The VM modal lists **Local** plus at most one extra destination when `backupMountId` is set.

## Password Change

The Host → App Config tab includes a password change form:

1. User enters current password and new password
2. Backend verifies current password
3. On success, writes new password to `config/wisp-password` (mode `0600`)
4. Changing the password invalidates all existing JWT tokens (the signing secret is derived from the password)

## Host Information

The Host → Overview tab displays system info retrieved from `GET /api/host` (Software section), along with CPU, memory, storage, and network details from the hardware and stats APIs:

| Field | Source |
|-------|--------|
| Wisp version | `package.json` version |
| Node.js version | `process.version` |
| libvirt version | DBus property on connect interface |
| QEMU version | libvirt host info |
| Hostname | `os.hostname()` |
| Uptime | `os.uptime()` |
| Kernel | `os.release()` |
| OS release | Parsed from `/etc/os-release` |

## OS Updates

OS update check and upgrade are in **Host → Host Mgmt** tab. When `/usr/local/bin/wisp-os-update` is installed (via `setup-server.sh`), the app can:

1. **Check for updates** — runs `wisp-os-update check`, returns the count of upgradable packages; result is also cached for the SSE `pendingUpdates` badge
2. **Install updates** — runs `wisp-os-update upgrade`, performs a full non-interactive upgrade

Supports Debian/Ubuntu (apt) and Arch Linux (pacman); distro is detected at runtime inside the helper script.

A background hourly check runs automatically; when updates are available, a badge is shown on the Host entry (left panel) and on the Host Mgmt tab. The timestamp of the last successful check is exposed as `updatesLastChecked` in the stats SSE and displayed in the UI as a relative time. The script is invoked via `sudo` (sudoers from setup). If `/usr/local/bin/wisp-os-update` is missing, the feature returns 503.

## Network Bridges

Host → Host Mgmt includes a **Network Bridges** section for managed VLAN bridge creation/deletion:

1. Managed VLAN bridges are listed in a table (no nested card)
2. Use the header add control (`Plus` + network icon) to append an **inline create row** in the table
3. In that row, select an eligible parent bridge (non-VLAN uplink bridge, e.g. `br0`) and enter VLAN ID (`1..4094`); confirm or cancel with the row action icons
4. Bridge name is auto-generated as `<base>-vlan<id>` (for example `br0-vlan10`)
5. Cancel clears the create row without creating a bridge

The host bridge performs VLAN tagging; VMs and containers attach to the managed bridge as normal untagged interfaces.

Bridge create/delete operations only surface feedback on failure. Errors are shown in the Host Mgmt page-level dismissible error banner; successful operations rely on the updated bridge list.

Safety rules:

- Parent bridge cannot be VLAN-tagged
- Parent bridge must have at least one non-VLAN member interface
- Managed bridge delete is blocked when referenced by VM NICs or container `network.interface`

## Settings Storage

Settings are stored in `config/wisp-config.json` by default (or at `WISP_CONFIG_PATH` if set).

The backend reads config synchronously (for path resolution during startup) and asynchronously (for full settings API). The settings module is the single writer; the config module is for sync consumers.

Updates are applied with a mutex to prevent concurrent modification races.
