# API — Host, settings and discovery

Host inventory and statistics, OS and Wisp updates, power, network bridges, host storage, application settings, LAN discovery. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Host

### GET /api/host · `read`

Host system information.

- **200:**

```json
{
  "hostname": "string",
  "nodeVersion": "string",
  "libvirtVersion": "string | null",
  "qemuVersion": "string | null",
  "wispVersion": "string",
  "uptimeSeconds": 12345,
  "primaryAddress": "string | null",
  "kernel": "string",
  "osRelease": {
    "prettyName": "string | null",
    "id": "string | null",
    "versionId": "string | null"
  }
}
```

On macOS, `GET /api/host` also runs `system_profiler -json SPSoftwareDataType` and, when it succeeds, fills `osRelease` (`prettyName` from `os_version` with the last trailing parenthetical removed — typically the build number; `id` `macos`, `versionId` from the semver in the raw string), and may refresh `kernel` (`kernel_version`) and `hostname` (`local_host_name`). If profiler fails, `osRelease` stays `null` (no `/etc/os-release`). `libvirtVersion` and `qemuVersion` are typically `null` when libvirt is not connected.

### GET /api/host/bridges · `read`

List network bridge interfaces available on the host. The list is ordered so that non-`virbr*` bridges (e.g. `br0`) appear first when `WISP_DEFAULT_BRIDGE` is unset; when set, that bridge is first.

- **200:** `["br0", "virbr0"]`

### GET /api/host/network-bridges · `read`

List Wisp-managed VLAN bridge definitions and eligible parent bridges.

- **200:**

```json
{
  "managed": [
    {
      "name": "br0-vlan10",
      "baseBridge": "br0",
      "vlanId": 10,
      "vlanInterface": "br0.10",
      "file": "/etc/netplan/91-wisp-vlan__br0__10__br0-vlan10.yaml",
      "present": true
    }
  ],
  "eligibleParents": ["br0"]
}
```

`eligibleParents` contains only non-VLAN parent bridges with at least one non-VLAN member interface. VLAN-tagged bridges (for example `br0.10`, `br0-vlan10`) are excluded to prevent VLAN-on-VLAN chaining.

### POST /api/host/network-bridges · `admin`

Create a managed VLAN bridge using netplan through the privileged `wisp-bridge` helper.

- **Body:** `{ "baseBridge": "br0", "vlanId": 10 }`
- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ "name": "br0-vlan10", "baseBridge": "br0", "vlanId": 10, "vlanInterface": "br0.10", "present": true }`
- **409:** `NETWORK_BRIDGE_EXISTS` — bridge already exists
- **422:** `INVALID_NETWORK_BRIDGE_NAME`, `INVALID_NETWORK_BRIDGE_PARENT`, an invalid VLAN ID
- **503:** `NETWORK_BRIDGE_UNAVAILABLE` — not supported on this platform
- **Job errors:** helper missing, privilege failure, or `netplan apply` failed

### DELETE /api/host/network-bridges/:name · `admin`

Delete a managed VLAN bridge by name (removes Wisp netplan file, tears down live bridge/vlan interfaces, and reapplies netplan).

- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ name }`
- **404:** `NETWORK_BRIDGE_NOT_FOUND` — managed bridge not found
- **409:** `NETWORK_BRIDGE_IN_USE` — bridge is referenced by VM/container config
- **Job errors:** helper missing, privilege failure, or `netplan apply` failed

### GET /api/host/firmware · `read`

List available UEFI firmware paths.

- **200:** `["/usr/share/OVMF/OVMF_CODE_4M.fd", ...]`

### GET /api/host/gpus · `read`

List GPUs available for container passthrough (Intel/AMD render nodes). One-shot snapshot — the list rarely changes, no SSE.

- **200:**

```json
{
  "gpus": [
    {
      "device": "/dev/dri/renderD128",
      "vendor": "0x8086",
      "vendorName": "Intel",
      "pciSlot": "0000:00:02.0",
      "model": "Alder Lake-P GT2 [Iris Xe Graphics]"
    }
  ]
}
```

NVIDIA GPUs (vendor `0x10de`) are filtered out of the response — exposing them via container passthrough requires CDI / nvidia-container-toolkit, which is not implemented in v1. Hosts with no `/dev/dri/renderD*` (no GPU, or only NVIDIA) return `{ "gpus": [] }`. The UI uses the empty result to disable the GPU picker with an explanation.

### GET /api/host/usb · `read`

List all USB devices on the host (snapshot from sysfs; same data as the initial SSE message on `/api/host/usb/stream`).

- **200:**

```json
[
  {
    "bus": "001",
    "device": "003",
    "vendorId": "046d",
    "productId": "c077",
    "name": "Logitech USB Mouse"
  }
]
```

### GET /api/host/usb/stream · `read`

Server-Sent Events stream of the host USB device list.

- Sends an immediate `data:` line with a JSON array of devices (same shape as `GET /api/host/usb`).
- Sends another `data:` line whenever the set of devices changes (hotplug), after debouncing.
- **200:** `text/event-stream` (persistent connection)

### GET /api/host/disks · `read`

List host block devices (removable + fixed) with mount state. Snapshot from `lsblk` cache; same data as the initial SSE message on `/api/host/disks/stream`.

- **200:**

```json
[
  {
    "uuid": "1c2a8d3e-9f7b-4eaa-9a2e-29ee32f1c1d0",
    "devPath": "/dev/sdb1",
    "fsType": "ext4",
    "label": "BACKUP",
    "sizeBytes": 1000204886016,
    "removable": false,
    "vendor": "ATA",
    "model": "Samsung SSD 870",
    "mountedAt": "/mnt/wisp/backup"
  }
]
```

### GET /api/host/disks/stream · `read`

Server-Sent Events stream of the host block-device list.

- Sends an immediate `data:` line with a JSON array of devices (same shape as `GET /api/host/disks`).
- Sends another `data:` line whenever the diskMonitor detects a change (insertion / removal / partition rescan).
- **200:** `text/event-stream` (persistent connection)

### POST /api/host/updates/check · `admin`

Check for OS package updates. On Debian/Ubuntu uses `apt-get -s upgrade` dry-run (excludes phased-only packages); on Arch uses `pacman -Qu`. Requires `/usr/local/bin/wisp-os-update` (installed by server setup). One shared run: a check or package refresh started while one runs joins it (the same `jobId`).

- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ count: number }`; the package list is then in the cache (`GET /api/host/updates/packages`)
- **409:** `UPDATE_BUSY` — an OS upgrade is running
- **Job errors:** `UPDATE_BUSY` — the package manager is locked; `UPDATE_CHECK_UNAVAILABLE` — update script not configured, or a step stopped (see [HOST-MONITORING.md](HOST-MONITORING.md))

### GET /api/host/updates/packages · `read`

Return the structured list of upgradable packages plus an estimated total download size. On Debian/Ubuntu uses `apt-get -s upgrade` to harvest `Inst …` lines and the `Need to get …` summary; on Arch uses `pacman -Qu` (download size cannot be computed non-interactively, so `downloadBytes` is `0`). Refreshes the cached `pendingUpdates` count and `updatesLastChecked` timestamp as a side-effect.

- **200:** `{ packages: [{ name: string, from: string|null, to: string }], downloadBytes: number }` — from the cache
- **202:** `{ jobId, title }` — with `?refresh=1`, or no cache yet: the [check job](#post-apihostupdatescheck--admin) (started or joined); read the list again once it is done
- **409:** `UPDATE_BUSY` — a refresh, or no cache yet, while an OS upgrade runs
- **503:** `{ error, detail }` — update script not configured

### POST /api/host/updates/upgrade · `admin`

Install OS package updates. Each line apt or pacman prints is a progress event (`{ step: "upgrading", detail }`).

- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ ok: true }`
- **409:** `UPDATE_BUSY` — a check or upgrade is already running
- **Job errors:** `UPDATE_BUSY` — the package manager is locked; `UPDATE_CHECK_UNAVAILABLE` — update script not configured, the upgrade failed, or it printed nothing for its inactivity bound

### GET /api/updates/status · `read`

Cached state of the Wisp self-update checker (hourly poll of GitHub Releases). See [UPDATES.md](UPDATES.md). The configured channel is not echoed here — the client reads `updateChannel` from `GET /api/settings`.

- **200:** `{ current, latest, available, notes, publishedAt, lastChecked, lastError, repo }`

### POST /api/updates/check · `admin`

Force an immediate self-update check. Which release is considered follows `updateChannel` from `wisp-config.json`, read at check time — see [UPDATES.md → Update channels](UPDATES.md#update-channels).

- **204:** checked; the new status (the `GET /api/updates/status` shape) follows on `{ kind: "wisp-update" }`, which every check announces — this one, a failed one and the hourly poll
- **503:** `{ error, detail }` — GitHub unreachable, rate-limited, or response malformed; the failure is recorded in the status (`lastError`) and announced too

### POST /api/updates/install · `admin`

A [job](API.md#job-routes): downloads + verifies + extracts the new release tarball (progress `{ step, percent? }`), writes the staging path to `/var/lib/wisp/updates/target`, reports `{ step: "restarting" }`, triggers `wisp-updater.service` via `sudo -n systemctl start --no-block` and ends with `done`: `{ targetVersion }`. The job's stream may end before `done` as the backend stops. The updater is a separate `Type=oneshot` systemd unit — it stops the backend as part of its first real step; the UI detects completion by polling `GET /api/host` for `wispVersion === targetVersion`. Updater progress is in journald (`journalctl -u wisp-updater.service`). `?force=1` overrides the active-jobs guard.

- **202:** `{ jobId, title }`
- **409:** `{ error, detail }` — no update available; other background jobs are running and `force=1` was not supplied; or an install is already in flight (`Update already in progress`, not bypassed by `force`)
- **Job errors:** download / verify / extract / unit-trigger failure

### GET /api/host/hardware · `read`

Static/semi-static hardware details for the Host Overview tab. On Linux: `/proc`, `/sys`, system `pci.ids` (when installed), and optional privileged helpers `wisp-dmidecode` (RAM) and `wisp-smartctl` (disk SMART summary). On macOS (dev): `/usr/sbin/system_profiler -json` (several `SP*` data types) plus `fs.statfsSync` and `os.networkInterfaces`; synthetic PCI addresses for sorting; if profiler fails, OS-only fallback. See [HOST-MONITORING.md](HOST-MONITORING.md).

- **200:**

```json
{
  "cpu": {
    "model": "string",
    "cores": 8,
    "threads": 16,
    "mhz": 2400,
    "cacheKb": 25600,
    "coreTypes": { "performance": [0, 1, 2, 3], "efficiency": [4, 5, 6, 7] } | null
  },
  "disks": [
    {
      "name": "sda",
      "model": "string",
      "sizeBytes": 512000000000,
      "rotational": true,
      "pciAddress": "0000:01:00.0",
      "smart": {
        "supported": true,
        "overall": "healthy",
        "temperatureC": 34,
        "powerOnHours": 2387,
        "criticalWarning": null,
        "percentageUsed": 2,
        "availableSpare": 100,
        "availableSpareThreshold": 10,
        "reallocatedSectors": null,
        "pendingSectors": null,
        "offlineUncorrectableSectors": null,
        "ssdLifePercentRemaining": null,
        "lastUpdated": "2026-03-25T12:34:56.000Z",
        "error": null
      }
    }
  ],
  "filesystems": [{ "mount": "/", "device": "/dev/sda1", "totalBytes": 0, "usedBytes": 0, "availBytes": 0 }],
  "network": [{ "name": "eth0", "mac": "aa:bb:cc:...", "speedMbps": 1000, "state": "up" }],
  "memory": [{ "type": "DDR4", "sizeBytes": 17179869184, "speedMts": 3200, "slot": "DIMM_A1", "formFactor": "DIMM", "manufacturer": "Samsung", "voltage": "1.2 V" }],
  "pciDevices": [
    {
      "address": "0000:00:02.0",
      "classId": "0300",
      "classCode": "030000",
      "className": "VGA compatible controller",
      "vendor": "Intel Corporation",
      "vendorId": "8086",
      "device": "UHD Graphics 630",
      "deviceId": "3e92",
      "driver": "i915"
    }
  ],
  "system": {
    "boardVendor": "string | null",
    "boardName": "string | null",
    "boardVersion": "string | null",
    "systemVendor": "string | null",
    "systemProduct": "string | null",
    "systemVersion": "string | null",
    "biosVendor": "string | null",
    "biosVersion": "string | null",
    "biosDate": "string | null"
  }
}
```

`cpu` is null only when the host reports no logical CPUs (unusual). On macOS Tier A, `cpu.coreTypes`, `mhz`, and `cacheKb` are always `null`. `cpu.coreTypes` is `null` on Linux when hybrid core groups are unavailable; when present, `performance` and `efficiency` list logical CPU IDs from Linux sysfs (`/sys/devices/cpu_core/cpus` and `/sys/devices/cpu_atom/cpus`). `memory` is from dmidecode via `wisp-dmidecode` (installed to `/usr/local/bin` and sudoers by `setup-server.sh`, or override `WISP_DMIDECODE_SCRIPT`); empty array if the helper is missing, sudo denies, or DMI has no modules. Each element may include `formFactor`, `manufacturer`, and `voltage` (string, human-readable; `voltage` prefers Configured Voltage, else min–max from SMBIOS); fields are JSON `null` when absent.

Each `disks[]` entry includes `rotational` (`true` = HDD, `false` = SSD-style, `null` if unknown) from `/sys/block/<name>/queue/rotational`, and `pciAddress` (PCI BDF or `null`) derived from the block device’s sysfs path so the UI can associate drives with PCI controllers. Linux disks also include `smart` summary fields from `wisp-smartctl` (`smartctl --json -a`): `supported`, `overall` (`healthy` / `warning` / `failing` / `unknown`, or `sleeping` — the disk is spun down and was not woken, so every other field is `null` and `error` is `null`), `temperatureC`, `powerOnHours` (cumulative power-on time, not I/O hours), `criticalWarning`, `lastUpdated`, and `error` (non-null when SMART is unavailable or read fails for that disk). When present: NVMe `percentageUsed` (0–255 per NVM Express; may exceed 100), `availableSpare`, `availableSpareThreshold`; ATA `reallocatedSectors`, `pendingSectors`, `offlineUncorrectableSectors` (from SMART attributes 5 / 197 / 198); `ssdLifePercentRemaining` (0–100, vendor-dependent, from attributes 231 / 202 / 233 when the normalized `value` is in range).

`pciDevices` lists PCI functions from sysfs; names come from the system PCI ID database (`pci.ids`). `classId` is the first four hex digits of `classCode` (24-bit class code). `system` is `null` when `/sys/class/dmi/id` is unavailable (some containers/VMs); otherwise fields are present and may be JSON `null` when not filled by firmware.

**Implementation:** `GET /api/host/hardware` uses a Fastify response schema (`backend/src/routes/host.js`). New fields must be listed in that schema (for example `cpu.coreTypes` or fields in `memory.items.properties`) or response serialization strips them.

### POST /api/host/power/shutdown · `admin`

Shut down the host. Requires `wisp-power` at `/usr/local/bin` (after `setup-server.sh`) or `WISP_POWER_SCRIPT`, plus matching sudoers.

- **204:** the shutdown was started
- **503:** `{ error, detail }` — power script not configured or privilege error

### POST /api/host/power/restart · `admin`

Reboot the host. Same requirements as shutdown (`wisp-power reboot`).

- **204:** the reboot was started
- **503:** `{ error, detail }` — power script not configured or privilege error

---

## Discovery

Wisp instances discovered on the LAN (see [DISCOVERY.md](DISCOVERY.md)) are pushed on the `discovery` topic of `GET /api/events`: the current peer list on connect, then the full list on every change (peer appeared, peer left, avahi restart). No polling timer.

- **Payload:** bare array, sorted by `name`:

```json
[
  { "name": "Other Box", "url": "http://otherbox.local:8080", "version": "1.3.0", "host": "otherbox.local" }
]
```

The instance's own announcement is filtered out server-side. On macOS dev (no Avahi) the topic stays `[]`.

---

## Settings

### GET /api/settings · `read`

Get application settings.

- **200:**

```json
{
  "serverName": "My Server",
  "vmsPath": "/var/lib/wisp/vms",
  "imagePath": "/var/lib/wisp/images",
  "containersPath": "/var/lib/wisp/containers",
  "backupLocalPath": "/var/lib/wisp/backups",
  "mounts": [],
  "backupMountId": null,
  "backupSchedule": { "enabled": false, "time": "03:00", "destinationIds": ["local"], "retainDays": 7, "retainWeeks": 4 },
  "discoveryEnabled": true,
  "advertisedUrl": null,
  "updateChannel": "stable",
  "oidc": { "enabled": false, "issuer": "", "clientId": "", "hasClientSecret": false }
}
```

The shipped `wisp-config.json.example` has empty `mounts`. Mounts are added via **Host → Host Mgmt → Storage** (row-scoped **POST**/**PATCH**/**DELETE** on `/api/host/mounts`). SMB passwords are never returned — each SMB mount carries `hasPassword` (boolean) instead, same as `GET /api/host/mounts`. The **OIDC client secret is never returned** — GET exposes `oidc.hasClientSecret` (boolean) only.

### PATCH /api/settings · `admin`

Update settings. Partial update — only include fields to change.

- **Body:** Partial settings object (`serverName`, `vmsPath`, `imagePath`, `backupLocalPath`, `containersPath`, `backupMountId`, `backupSchedule`, `discoveryEnabled`, `advertisedUrl`, `updateChannel`)
- **204:** saved; the new settings reach every client as `{ kind: "settings" }` on the [`changes`](API.md#changes-topic-payload) topic ([Command responses](API.md))
- **Validation:** Every field sent must be valid — nothing is coerced to a default. Paths must be absolute (start with `/`), `backupMountId` must name a configured mount (or be `null`/empty to clear), `updateChannel` must be `"stable"` or `"beta"` — else **422** `{ error, detail }` with code `INVALID_SETTINGS`. `advertisedUrl` must be a valid `http`/`https` URL of at most 251 bytes (mDNS TXT record limit), or `null`/empty to clear — else **422** with code `INVALID_URL`. Changing or clearing `backupMountId` drops the previous mount from `backupSchedule.destinationIds` in the same write (`["local"]` when nothing else remains).
- **`backupSchedule`:** Object `{ enabled?, time?, destinationIds?, retainDays?, retainWeeks? }`, merged per-field. Any field the client actually sends must be valid — `time` matching `HH:MM` (24-hour), `retainDays` 1–365, `retainWeeks` 0–52, `destinationIds` a non-empty subset of `'local'` + the configured `backupMountId` (validated against the merged result, so swapping the mount and updating the schedule in one PATCH works) — else **422** with code `INVALID_BACKUP_SCHEDULE`. See [BACKUPS.md → Scheduled backups](BACKUPS.md#scheduled-backups).
- **`oidc`:** Refused for every caller with **403** `{ error: "OIDC settings require a browser session", detail }` (code `OIDC_SESSION_ONLY`) — use `PATCH /api/settings/oidc`, which API tokens cannot reach.
- **Side effect:** A successful PATCH that changes `serverName`, `discoveryEnabled`, or `advertisedUrl` re-announces the instance's `_wisp._tcp` mDNS service (see [DISCOVERY.md](DISCOVERY.md)).
- **`updateChannel`:** `"stable"` | `"beta"` — which releases self-update offers this host. No side effect: the next update check (hourly, or `POST /api/updates/check`) reads it. See [UPDATES.md → Update channels](UPDATES.md#update-channels).
- **`containersPath`:** Optional; container storage root (same default as `config.js`; exposed for scripts — App Config UI does not edit it yet).
- **Mount CRUD:** Not available via PATCH /api/settings. Use `/api/host/mounts` endpoints below.

### PATCH /api/settings/oidc · `session`

Update the OIDC / SSO configuration. Session-only: an API token of either scope gets **403 Session required** — a token able to repoint the issuer could log itself in as a browser session (see [AUTH.md](AUTH.md) § Denied surfaces).

- **Body:** `{ enabled?, issuer?, clientId?, clientSecret? }`, merged per field.
- **204:** saved; announced like `PATCH /api/settings`.
- **`clientSecret`:** Write-only. Omit or send empty to keep the saved secret — only while `issuer` and `clientId` are unchanged. Changing either without a new `clientSecret` returns **422** `INVALID_OIDC` (the saved secret is never sent to a different provider); clearing either drops the saved secret.
- **Validation:** When `enabled: true`, the merged config must have a valid `http`/`https` `issuer`, a `clientId`, and a `clientSecret` on file, else **422** `{ error, detail }` with code `INVALID_OIDC`. Persisted to `wisp-config.json` (written `0600`).

### GET /api/host/mounts · `read`

List configured mounts (SMB + disk). SMB passwords are never returned; SMB entries carry `hasPassword` (boolean).

- **200:** Array of mount objects — see [CONFIGURATION.md](CONFIGURATION.md) for field shape.

### POST /api/host/mounts · `admin`

Append one mount. **Body:** `{ type: "smb" | "disk", label?, mountPath, autoMount?, ...type-specific }`. **`id`** optional (server generates a UUID if omitted). Paths must be absolute. For `type: "smb"`, `share` is required. For `type: "disk"`, `uuid` is required; `fsType` must be one of `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3`.

- **201:** `{ id }` — the new mount's id; the mount arrives on the stream (`settings` and `host-mounts`)
- **409:** `MOUNT_DUPLICATE` — id already exists
- **422:** `MOUNT_INVALID` — missing/invalid fields

### PATCH /api/host/mounts/:id · `admin`

Update one mount by **`id`**. **Body:** partial fields (`label`, `mountPath`, `autoMount`, and type-specific: `share`/`username`/`password` for SMB, `fsType`/`readOnly` for disk). An omitted or empty `password` preserves the stored password. `type` and `uuid` cannot be changed after creation.

- **204:** saved; announced like `POST /api/host/mounts` | **404:** mount not found

### DELETE /api/host/mounts/:id · `admin`

Remove one mount from settings, unmounting it first. If it was **`backupMountId`**, that field is cleared.

- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ mounts }` — the mounts after removal | **404:** mount not found | **409:** in use by a container

### GET /api/host/mounts/status · `read`

Mount status for all configured mounts.

- **200:** `[{ id, label, mountPath, mounted: boolean }]`

### POST /api/host/mounts/check · `admin`

Test an SMB connection for a saved mount or ad hoc credentials.

- **Body:** `{ id?: string, share?: string, username?: string, password?: string }`
- If `id` is provided, the referenced mount (must be `type: "smb"`) supplies `share`/`username`/`password`, and any of those fields present in the body overrides the stored value — the edit form sends its unsaved share/username and omits `password` when the field is empty, so the test uses the stored password. Without `id`, the provided `share`/`username`/`password` are used as-is.
- **200:** `{ ok: true }`
- **404:** SMB mount not found (when using `id`)

### POST /api/host/mounts/:id/mount · `admin`

Mount an SMB share by settings id. Disk mounts are mounted automatically on device insertion and this endpoint currently returns **422** for `type: "disk"` — dedicated support lands with the disk monitor work.

- **204:** mounted; the status arrives on `host-mounts`
- **503:** Mount unavailable (platform/helper error)

### POST /api/host/mounts/:id/unmount · `admin`

Unmount a mount by settings id.

- **202:** `{ jobId, title }` — a [job](API.md#job-routes); `done`: `{ id }` | **404:** mount not found | **409:** not mounted
