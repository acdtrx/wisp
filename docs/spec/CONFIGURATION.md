# Configuration

Wisp uses **`config/`** at the project (install) root for persistent data: optional process overrides (`config/runtime.env`), application settings (`config/wisp-config.json`), and the login secret (`config/wisp-password`). The backend and frontend load `config/runtime.env` when present; **ports and other settings have built-in defaults** if the file is missing.

## Deployment (install.sh)

On a new server, run `./scripts/install.sh` from the unpacked release (slim zip from `scripts/package.sh`) or from a full git checkout. The script prompts for install directory (default `/opt/wisp`), server name, and initial password; runs `scripts/linux/setup/copy.sh` (replaces `frontend/`, `backend/`, `scripts/`, `systemd/` from the source tree and refreshes `config/*.example`); runs `scripts/setup-server.sh` with sudo; runs `scripts/linux/setup/config.sh` and `scripts/linux/setup/password.sh`; runs `scripts/wispctl.sh build`; and `scripts/linux/setup/permissions.sh`. Optionally installs and starts systemd units (`wisp-backend`, `wisp-frontend`) on first install; if those units are already present, prompts to **restart** them instead (default yes), for upgrades without reinstalling units. Run as a normal user; sudo is used for install directory creation (when needed) and for `setup-server.sh`.

## Optional `config/runtime.env`

If this file exists, the backend and frontend parse `KEY=value` lines (comments and blank lines ignored) **only for keys not already set** in the process environment. Systemd uses `EnvironmentFile=-<install>/config/runtime.env` (leading `-` means the file may be absent).

| Variable | Default | Description |
|----------|---------|-------------|
| `WISP_BACKEND_PORT` | `3001` | Backend API port. |
| `WISP_FRONTEND_PORT` | `8080` | Frontend static server port. |
| `WISP_DEFAULT_BRIDGE` | (unset) | Override default bridge for new VM NICs; backend auto-detects if unset. |
| `GITHUB_TOKEN` | (unset) | Optional; some download flows in the backend. |
| `WISP_POWER_SCRIPT` | (unset) | Path to `wisp-power` helper. If unset, backend uses first existing path: `/usr/local/bin/wisp-power` (after `setup-server.sh`), then bundled `<install>/backend/scripts/wisp-power`. |
| `WISP_DMIDECODE_SCRIPT` | (unset) | Path to RAM info helper. If unset, backend uses first existing path: `/usr/local/bin/wisp-dmidecode` (after `setup-server.sh`), then bundled `<install>/backend/scripts/wisp-dmidecode`. |
| `WISP_SMARTCTL_SCRIPT` | (unset) | Path to `wisp-smartctl` helper for disk SMART. If unset: `/usr/local/bin/wisp-smartctl`, then bundled `backend/scripts/wisp-smartctl`. Same sudoers pattern as `wisp-dmidecode`. |
| `WISP_NETNS_SCRIPT` | (unset) | Path to `wisp-netns` helper (`add`/`delete` + `ip netns`). If unset: `/usr/local/bin/wisp-netns`, then bundled `backend/scripts/wisp-netns`. Deploy user needs `sudo -n` via install-helpers. |
| `WISP_CNI_SCRIPT` | (unset) | Path to `wisp-cni` helper (runs a CNI plugin with config file). If unset: `/usr/local/bin/wisp-cni`, then bundled `backend/scripts/wisp-cni`. Same sudoers pattern as `wisp-netns`. |
| `WISP_CONFIG_PATH` | (unset) | Override path for `wisp-config.json`; default `<project>/config/wisp-config.json`. |
| `NODE_ENV` | (unset) | `development` enables CORS for `localhost:5173`. |

Shipped template: `config/runtime.env.example` (copy to `runtime.env` if you need overrides).

OS updates, SMB shares, and removable-drive mounts use **`/usr/local/bin/wisp-os-update`** and **`/usr/local/bin/wisp-mount`** when installed by `setup-server.sh` (no env vars required).

## Application Config (`config/wisp-config.json`)

JSON file managed by the Settings UI. Default path: `config/wisp-config.json` (or `WISP_CONFIG_PATH`). Created from `config/wisp-config.json.example` on first install.

### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverName` | `string \| null` | `null` | Display name in the top bar. Falls back to `My Server` when null. |
| `vmsPath` | `string` | `/var/lib/wisp/vms` | VM storage root (absolute). |
| `imagePath` | `string` | `/var/lib/wisp/images` | Image library path. |
| `backupLocalPath` | `string` | `/var/lib/wisp/backups` | Local backup directory. |
| `containersPath` | `string` | `/var/lib/wisp/containers` | Container storage root (absolute). |
| `mounts` | `array` | `[]` | Configured mounts (see object shape below). Includes SMB shares and adopted removable drives. |
| `backupMountId` | `string \| null` | `null` | Optional `id` of a `mounts` entry to expose as a backup destination in the UI. |

### Mount object (`mounts[]`)

Common fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique id |
| `type` | `string` | `"smb"` or `"disk"`. Discriminates the remaining fields. |
| `label` | `string` | Display name |
| `mountPath` | `string` | Absolute mount point (must start with `/`) |
| `autoMount` | `boolean` | When `true` (default), Wisp mounts on startup (SMB) or on device insertion (disk). |

SMB-only (`type: "smb"`):

| Field | Type | Description |
|-------|------|-------------|
| `share` | `string` | SMB URL (e.g. `//server/share`) |
| `username` | `string` | SMB user |
| `password` | `string` | SMB password (API masks as `***`) |

Disk-only (`type: "disk"`):

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | `string` | Filesystem UUID (resolved to `/dev/disk/by-uuid/<uuid>`) |
| `fsType` | `string` | One of `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3` |
| `readOnly` | `boolean` | Force read-only mount (mandatory for `ntfs3`) |

### Config priority

Config file fields override hard-coded defaults when valid. If the file is missing or invalid, defaults apply.

### Config file permissions

Restrict the file if it contains SMB passwords (e.g. `chmod 600`).

## Password Storage

Login uses **`config/wisp-password`** (mode `0600`): scrypt hash written by `install.sh` / `wispctl password` / change-password in the UI. JWT signing requires this file; run `wispctl password` if the backend reports no password configured.

## Filesystem Paths

### Directories created by setup

| Path | Owner | Mode | Purpose |
|------|-------|------|---------|
| `/var/lib/wisp/images/` | `<deploy-user>:libvirt` | `0775` | Image library |
| `/var/lib/wisp/vms/` | `<deploy-user>:libvirt` | `0775` | VM storage |
| `/var/lib/wisp/backups/` | `<deploy-user>:libvirt` | `0775` | Local backups |
| `/var/lib/wisp/containers/` | `<deploy-user>:libvirt` | `0775` | Container storage (when created by setup) |
| `/mnt/wisp/smb/` | `<deploy-user>:libvirt` | `0775` | SMB mount parent |

### Per-VM directory layout

```
<vmsPath>/<vm-name>/
├── disk0.qcow2
├── disk1.qcow2
├── cloud-init.iso
├── cloud-init.json
└── VARS.fd
```

### Backup directory layout

```
<backupPath>/<vm-name>/<timestamp>/
├── manifest.json
├── domain.xml
├── disk0.qcow2.gz
├── VARS.fd
├── cloud-init.iso.gz
└── cloud-init.json
```

## Systemd unit placeholders

Templates in `systemd/` use:

| Placeholder | Value |
|-------------|--------|
| `WISP_USER` | Deploy user |
| `WISP_PATH` | Install directory |

Installed units are **`wisp-backend.service`** and **`wisp-frontend.service`**. Optional `EnvironmentFile=-WISP_PATH/config/runtime.env`.
