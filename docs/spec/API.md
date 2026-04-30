# API Reference

All routes are prefixed with `/api/` (REST) or `/ws/` (WebSocket). All endpoints except `POST /api/auth/login` require an authenticated session — the `wisp_session` cookie set by login. State-changing methods (`POST` / `PUT` / `PATCH` / `DELETE`) additionally require the `X-CSRF-Token` header to match the (non-HttpOnly) `wisp_csrf` cookie. Send `credentials: 'include'` on fetch requests so the browser carries the cookies cross-port in dev.

All error responses return `{ error: string, detail: string }`. See [ERROR-HANDLING.md](ERROR-HANDLING.md) for details.

## Authentication

### POST /api/auth/login

Authenticate with password. On success, sets two cookies (`wisp_session` HttpOnly + `wisp_csrf` non-HttpOnly, `SameSite=Lax`, 24h Max-Age) and returns `{ ok: true }`.

- **Auth:** Public (no token required)
- **Rate limit:** 5 attempts per IP per 60 seconds (sweep 60 s, max 10 000 entries)
- **Body:** `{ password: string }`
- **200:** `{ ok: true }` + `Set-Cookie: wisp_session=…; HttpOnly; SameSite=Lax`, `Set-Cookie: wisp_csrf=…; SameSite=Lax`
- **401:** `{ error, detail }` — invalid password
- **429:** `{ error, detail }` — rate limited

### POST /api/auth/logout

Clear the session cookies. Idempotent.

- **204:** No content + `Set-Cookie: wisp_session=; Max-Age=0`, `Set-Cookie: wisp_csrf=; Max-Age=0`

### POST /api/auth/change-password

Change the application password. On success, re-issues fresh `wisp_session` and `wisp_csrf` cookies against the new secret so the caller stays logged in. Existing SSE / WebSocket connections are server-closed because their pre-rotation tokens no longer verify.

- **Body:** `{ currentPassword: string, newPassword: string }`
- **204:** No content + new `Set-Cookie` lines for both cookies
- **401:** `{ error, detail }` — current password incorrect
- **500:** `{ error, detail }` — failed to write new password

---

## Background jobs

In-memory job registry (server process only; no persistence across restart). Used to restore the jobs tray after a full page reload and for server logging. Progress for each job still uses the existing per-job SSE endpoints (`/vms/create-progress`, `/vms/backup-progress`, `/library/download-progress`, `/containers/create-progress`).

### GET /api/background-jobs

- **200:**

```json
{
  "jobs": [
    {
      "jobId": "string",
      "kind": "vm-create | container-create | backup | library-download",
      "title": "string",
      "done": false,
      "createdAt": 1730000000000
    }
  ]
}
```

`done` is true after the job completed or failed (until the in-memory TTL removes it). `title` is computed on the server (same rules as the UI: e.g. `Create <name>`, `Backup <name>`, truncated URLs for library downloads).

---

## Host

### GET /api/host

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

### GET /api/host/bridges

List network bridge interfaces available on the host. The list is ordered so that non-`virbr*` bridges (e.g. `br0`) appear first when `WISP_DEFAULT_BRIDGE` is unset; when set, that bridge is first.

- **200:** `["br0", "virbr0"]`

### GET /api/host/network-bridges

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

### POST /api/host/network-bridges

Create a managed VLAN bridge using netplan through the privileged `wisp-bridge` helper.

- **Body:** `{ "baseBridge": "br0", "vlanId": 10 }`
- **200:** `{ "name": "br0-vlan10", "baseBridge": "br0", "vlanId": 10, "vlanInterface": "br0.10", "present": true }`
- **409:** `{ error, detail }` — bridge already exists
- **422:** `{ error, detail }` — invalid parent bridge or VLAN ID
- **503:** `{ error, detail }` — helper missing, privilege failure, or `netplan apply` failed

### DELETE /api/host/network-bridges/:name

Delete a managed VLAN bridge by name (removes Wisp netplan file, tears down live bridge/vlan interfaces, and reapplies netplan).

- **200:** `{ ok: true }`
- **404:** `{ error, detail }` — managed bridge not found
- **409:** `{ error, detail }` — bridge is referenced by VM/container config
- **503:** `{ error, detail }` — helper missing, privilege failure, or `netplan apply` failed

### GET /api/host/firmware

List available UEFI firmware paths.

- **200:** `["/usr/share/OVMF/OVMF_CODE_4M.fd", ...]`

### GET /api/host/gpus

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

### GET /api/host/usb

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

### GET /api/host/usb/stream

Server-Sent Events stream of the host USB device list. Requires authentication (JWT in `Authorization: Bearer` or `?token=` query).

- Sends an immediate `data:` line with a JSON array of devices (same shape as `GET /api/host/usb`).
- Sends another `data:` line whenever the set of devices changes (hotplug), after debouncing.
- **200:** `text/event-stream` (persistent connection)

### GET /api/host/disks

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

### GET /api/host/disks/stream

Server-Sent Events stream of the host block-device list. Requires authentication (JWT in `Authorization: Bearer` or `?token=` query).

- Sends an immediate `data:` line with a JSON array of devices (same shape as `GET /api/host/disks`).
- Sends another `data:` line whenever the diskMonitor detects a change (insertion / removal / partition rescan).
- **200:** `text/event-stream` (persistent connection)

### POST /api/host/updates/check

Check for OS package updates. On Debian/Ubuntu uses `apt-get -s upgrade` dry-run (excludes phased-only packages); on Arch uses `pacman -Qu`. Requires `/usr/local/bin/wisp-os-update` (installed by server setup).

- **200:** `{ count: number }`
- **503:** `{ error, detail }` — update script not configured

### POST /api/host/updates/upgrade

Install OS package updates.

- **200:** `{ ok: true }`
- **503:** `{ error, detail }` — update script not configured

### GET /api/host/hardware

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

Each `disks[]` entry includes `rotational` (`true` = HDD, `false` = SSD-style, `null` if unknown) from `/sys/block/<name>/queue/rotational`, and `pciAddress` (PCI BDF or `null`) derived from the block device’s sysfs path so the UI can associate drives with PCI controllers. Linux disks also include `smart` summary fields from `wisp-smartctl` (`smartctl --json -a`): `supported`, `overall` (`healthy` / `warning` / `failing` / `unknown`), `temperatureC`, `powerOnHours` (cumulative power-on time, not I/O hours), `criticalWarning`, `lastUpdated`, and `error` (non-null when SMART is unavailable or read fails for that disk). When present: NVMe `percentageUsed` (0–255 per NVM Express; may exceed 100), `availableSpare`, `availableSpareThreshold`; ATA `reallocatedSectors`, `pendingSectors`, `offlineUncorrectableSectors` (from SMART attributes 5 / 197 / 198); `ssdLifePercentRemaining` (0–100, vendor-dependent, from attributes 231 / 202 / 233 when the normalized `value` is in range).

`pciDevices` lists PCI functions from sysfs; names come from the system PCI ID database (`pci.ids`). `classId` is the first four hex digits of `classCode` (24-bit class code). `system` is `null` when `/sys/class/dmi/id` is unavailable (some containers/VMs); otherwise fields are present and may be JSON `null` when not filled by firmware.

**Implementation:** `GET /api/host/hardware` uses a Fastify response schema (`backend/src/routes/host.js`). New fields must be listed in that schema (for example `cpu.coreTypes` or fields in `memory.items.properties`) or response serialization strips them.

### POST /api/host/power/shutdown

Shut down the host. Requires `wisp-power` at `/usr/local/bin` (after `setup-server.sh`) or `WISP_POWER_SCRIPT`, plus matching sudoers.

- **200:** `{ ok: true }`
- **503:** `{ error, detail }` — power script not configured or privilege error

### POST /api/host/power/restart

Reboot the host. Same requirements as shutdown (`wisp-power reboot`).

- **200:** `{ ok: true }`
- **503:** `{ error, detail }` — power script not configured or privilege error

---

## Stats (SSE)

### GET /api/stats

Server-Sent Events stream of host statistics. Pushes every 3 seconds.

- **Content-Type:** `text/event-stream`
- **Event data:**

```json
{
  "cpu": {
    "allocated": 8,
    "total": 16,
    "usagePercent": 34.2,
    "perCore": [12.5, 45.0, 8.3]
  },
  "cpuTemp": 62.5,
  "cpuTempThresholds": { "maxC": 80.0, "critC": 95.0 },
  "thermalZones": [
    { "type": "x86_pkg_temp", "label": "CPU Package", "tempC": 62.5, "maxC": 80.0, "critC": 95.0 },
    { "type": "acpitz", "label": "ACPI", "tempC": 27.8, "maxC": null, "critC": 95.0 }
  ],
  "cpuPowerWatts": 45.2,
  "memory": {
    "allocatedGB": 12.0,
    "totalGB": 64.0,
    "usagePercent": 28.1,
    "usedBytes": 0,
    "buffersBytes": 0,
    "cachedBytes": 0,
    "swapTotalBytes": 0,
    "swapUsedBytes": 0
  },
  "loadAvg": [1.2, 0.8, 0.6],
  "disk": { "readMBs": 1.2, "writeMBs": 0.4 },
  "net": { "rxMBs": 2.1, "txMBs": 0.8 },
  "runningVMs": 3,
  "runningContainers": 2,
  "pendingUpdates": 0,
  "updatesLastChecked": "2026-04-03T12:00:00.000Z",
  "rebootRequired": false,
  "rebootReasons": []
}
```

- `runningContainers` is the count of containers in the running state (0 when containerd is unavailable or on non-Linux dev hosts).
- `cpuTemp` and `cpuPowerWatts` are `null` when unavailable (e.g. non-Intel, VM, or no thermal/powercap sysfs).
- `cpuTemp` is selected from the best CPU-relevant sensor (package/core sensors preferred over generic ACPI/platform sensors).
- `cpuTempThresholds` contains thresholds for the selected primary CPU sensor as `{ maxC, critC }` (or `null` when unavailable).
- `thermalZones` contains readable thermal sensors as `{ type, label, tempC, maxC, critC }`; empty array when unavailable. If both sysfs sources expose the same sensor type, `thermal_zone` is preferred and duplicate `hwmon` entry is omitted.
- `loadAvg` is [1min, 5min, 15min] from /proc/loadavg.
- `pendingUpdates` is the count of upgradable packages from the background hourly check (or 0 if check unavailable).
- `updatesLastChecked` is an ISO 8601 timestamp of the last successful update check (background or manual), or `null` if no check has completed since the backend started.
- `rebootRequired` is `true` when the host has a pending reboot. `rebootReasons` is a list of short tags (Debian/Ubuntu package names, or `kernel <running> → <installed>` on Arch).
- CPU and memory `allocated` values reflect running VMs only.

---

## Virtual Machines

### GET /api/vms

List all VMs with summary info.

- **200:**

```json
[
  {
    "name": "ubuntu-server",
    "uuid": "abc-123",
    "state": "running",
    "stateCode": 1,
    "vcpus": 4,
    "memoryMiB": 4096,
    "osCategory": "linux",
    "iconId": null,
    "localDns": false,
    "staleBinary": false,
    "sectionId": "main"
  }
]
```

- `staleBinary` is `true` when the VM's running qemu process is using a binary that has been replaced on disk (typically after a qemu/libvirt package upgrade); the VM needs to be restarted to pick up the new binary. Always `false` for non-running VMs. Detected by reading `/var/run/libvirt/qemu/<name>.pid` and checking whether `/proc/<pid>/exe` ends with ` (deleted)`.
- `sectionId` is the id of the sidebar section the VM is assigned to. Workloads with no explicit assignment (or with an assignment pointing at a deleted section) report `"main"` — the synthetic Main bucket. See [Sections](#sections).

### GET /api/vms/stream

SSE stream of the full VM list. Event-driven: pushes when libvirt emits a `DomainEvent` (define/undefine/start/stop/etc.) or when a `qemu-system-*` binary is replaced on disk (apt/dnf upgrade). No polling timer — clients receive updates as they happen.

- **Query:** none
- **Content-Type:** `text/event-stream`
- **Event data:** Same array as `GET /api/vms`. An initial event is sent on connect.

### POST /api/vms

Create a new VM. Returns a job ID; monitor progress via SSE.

- **Body:**

```json
{
  "name": "string (required, 1-128 chars; alphanumeric, dot, hyphen, underscore; no .. or path separators)",
  "template": "ubuntu-server | ubuntu-desktop | windows-11 | haos | custom",
  "osType": "linux | windows | other",
  "osVariant": "ubuntu24.04 | ubuntu22.04 | debian12 | archlinux | win11 | win10 | generic",
  "vcpus": 4,
  "memoryMiB": 4096,
  "autostart": false,
  "firmware": "uefi | bios | uefi-secure",
  "machineType": "q35 | i440fx",
  "cpuMode": "host-passthrough | host-model | qemu64",
  "videoDriver": "virtio | qxl | vga",
  "graphicsType": "vnc | spice",
  "bootOrder": ["hd", "cdrom", "network"],
  "bootMenu": false,
  "memBalloon": true,
  "guestAgent": true,
  "localDns": true,
  "vtpm": false,
  "virtioRng": true,
  "nestedVirt": false,
  "nics": [{ "type": "bridge", "source": "br0", "model": "virtio", "mac": "52:54:00:xx:xx:xx", "vlan": null }],
  "disk": {
    "type": "none | new | existing",
    "sizeGB": 32,
    "bus": "virtio | scsi | sata | ide",
    "sourcePath": "/path/to/image.qcow2",
    "resizeGB": 50
  },
  "disk2": {
    "type": "none | new | existing",
    "sizeGB": 32,
    "bus": "virtio | scsi | sata | ide",
    "sourcePath": "/path/to/image.qcow2",
    "resizeGB": 50
  },
  "cdrom1Path": "/path/to/installer.iso",
  "cdrom2Path": "/path/to/drivers.iso",
  "cloudInit": {
    "enabled": true,
    "hostname": "string",
    "username": "string",
    "password": "string",
    "sshKey": "string",
    "growPartition": true,
    "packageUpgrade": true,
    "installQemuGuestAgent": true,
    "installAvahiDaemon": true
  }
}
```

- **`disk.type`:** `none` means no primary block disk (e.g. ISO-only install). Omitted or unset `type` is treated as `new` for backward compatibility. Up to two non-`none` disks are provisioned in order: `disk` then `disk2`, mapped to `sda` / `sdb` in domain XML (`disk0.qcow2` / `disk1.qcow2`). If only `disk2` is set while `disk` is `none`, the first provisioned image is still attached as `sda`.

- **`cloudInit.enabled`:** Optional; default is on. If `false`, cloud-init is skipped during create (no seed ISO, no `sde`, no `cloud-init.json`).

- **201:** `{ jobId: string, title: string }` — `title` is the display label for the background job (e.g. `Create <name>`)
- **422:** `{ error, detail }` — `INVALID_VM_NAME` when name fails `validateVMName`; VM VLAN input is rejected on bridge NICs; use a VLAN-specific bridge (for example `br0-vlan22`) instead

The body schema is **`additionalProperties: false`**. With Fastify's default Ajv (`removeAdditional: true`), unknown keys are silently stripped before the handler runs — they never reach `createVM`. Only schema-level violations (wrong type, missing required field) return HTTP 400.

### GET /api/vms/create-progress/:jobId

SSE stream for VM creation progress (see [ERROR-HANDLING.md](ERROR-HANDLING.md) for job SSE shapes).

- **Progress events:** `{ step, ... }` — `step` includes `validating`, `copying` (may include `percent`), `resizing`, `creating-disk`, `cloudinit`, `defining`, and an internal `done` step with `{ name }` before the job completes.
- **Completion (from job store):** `{ step: "done", name: "<vmName>" }`
- **Failure (terminal):** `{ step: "error", error: string, detail: string }` — then the stream closes.

### GET /api/vms/:name

Full VM configuration parsed from domain XML.

- **200:** Full VM config object (name, uuid, state, vcpus, memoryMiB, disks, nics, firmware, etc.)

Each `disks[]` entry may include **`sizeGiB`** (integer, virtual size in GiB, rounded) for **`device: "disk"`** entries with a file `source`, when `qemu-img info` succeeds. Omitted if the image is missing or size read fails.

### PATCH /api/vms/:name

Update VM configuration.

- **Body:** Partial config object. Allowed fields: `name`, `memoryMiB`, `vcpus`, `cpuMode`, `nestedVirt`, `machineType`, `firmware`, `bootOrder`, `bootMenu`, `osType`, `nics`, `videoDriver`, `graphicsType`, `memBalloon`, `vtpm`, `virtioRng`, `guestAgent`, `iconId`, `localDns`, `autostart`. Schema is **`additionalProperties: false`**; with Fastify's default Ajv `removeAdditional: true`, unknown keys are silently stripped before reaching `updateVMConfig`.
- **200:** `{ ok: true, requiresRestart: boolean }` — indicates whether changes need a VM restart
- **409:** `{ error, detail }` — e.g. `VM_MUST_BE_OFFLINE` when renaming while the VM is running
- **422:** `{ error, detail }` — `INVALID_VM_NAME` on rename to an invalid name; VM VLAN input is rejected on bridge NICs; use a VLAN-specific bridge (for example `br0-vlan22`) instead

`localDns` is supported in PATCH and controls VM mDNS registration behavior.

### DELETE /api/vms/:name

Delete a VM.

- **Query:** `?deleteDisks=true|false` — whether to also delete disk images and VM directory
- **200:** `{ ok: true }`

### GET /api/vms/:name/xml

Raw libvirt domain XML (for debugging/inspection).

- **200:** `{ xml: string }`

### POST /api/vms/:name/start

- **200:** `{ ok: true }`

### POST /api/vms/:name/stop

Graceful shutdown (ACPI).

- **200:** `{ ok: true }`

### POST /api/vms/:name/force-stop

Immediate force stop (destroy).

- **200:** `{ ok: true }`

### POST /api/vms/:name/reboot

- **200:** `{ ok: true }`

### POST /api/vms/:name/suspend

- **200:** `{ ok: true }`

### POST /api/vms/:name/resume

- **200:** `{ ok: true }`

### POST /api/vms/:name/clone

Clone a VM (must be stopped).

- **Body:** `{ newName: string (1-128 chars; alphanumeric, dot, hyphen, underscore; no .. or path separators) }`. Schema is **`additionalProperties: false`**.
- **200:** `{ ok: true }`
- **422:** `INVALID_VM_NAME` if `newName` fails `validateVMName`.

---

## VM Stats (SSE)

### GET /api/vms/:name/stats

SSE stream of per-VM statistics. Pushes every 3 seconds.

- **Event data (running, active: true):**

```json
{
  "state": "running",
  "active": true,
  "cpu": { "percent": 18.5 },
  "disk": { "readMBs": 0.2, "writeMBs": 1.4 },
  "net": { "rxMBs": 0.1, "txMBs": 0.8 },
  "uptime": 15780,
  "guestHostname": "myvm",
  "guestIp": "192.168.1.10",
  "mdnsHostname": "myvm.local",
  "staleBinary": false
}
```

`guestHostname` and `guestIp` are present only when the guest agent is enabled and the backend successfully queried them. `mdnsHostname` is present when Local DNS is enabled for the VM and registration succeeded.

`staleBinary` is `true` when the VM's qemu process is still using a binary that was replaced on disk (typically after a qemu/libvirt upgrade) — the VM needs to be restarted. Detected from `/proc/<pid>/exe` reporting a ` (deleted)` suffix; PID sourced from `/var/run/libvirt/qemu/<name>.pid`. Always `false` in the stopped payload.

- **Event data (stopped):** `{ state: "shutoff", active: false, cpu: null, disk: null, net: null, uptime: null, staleBinary: false }`

---

## Disks

### POST /api/vms/:name/disks

Attach an existing disk image or create and attach a new empty disk. VM must be stopped.

- **Body (attach existing):** `{ slot: "sda" | "sdb", path: string, bus?: "virtio" | "scsi" | "sata" | "ide" }`
- **Body (create new):** `{ slot: "sdb", sizeGB: number, bus?: "virtio" | "scsi" | "sata" | "ide" }` — creates a new qcow2 in the VM directory and attaches it. Provide either `path` or `sizeGB`, not both.
- **200:** `{ ok: true }`
- **422:** Both or neither of `path` and `sizeGB` provided

### DELETE /api/vms/:name/disks/:slot

Detach a disk from a VM slot.

- **200:** `{ ok: true }`

### POST /api/vms/:name/disks/:slot/resize

Resize a disk.

- **Body:** `{ sizeGB: number }`
- **200:** `{ ok: true }`

### POST /api/vms/:name/disks/:slot/bus

Change the disk controller (bus) for a block disk slot. VM must be stopped.

- **Body:** `{ bus: "virtio" | "scsi" | "sata" | "ide" }`
- **200:** `{ ok: true }`
- **422:** Invalid `bus` or slot (e.g. not a block disk)

---

## CDROM (ISO)

### POST /api/vms/:name/cdrom/:slot

Attach an ISO to a CDROM slot. Supports hot-plug (live + config).

- **Params:** slot is `sdc` or `sdd`
- **Body:** `{ path: string }`
- **200:** `{ ok: true }`

### DELETE /api/vms/:name/cdrom/:slot

Eject an ISO from a CDROM slot. Supports hot-unplug.

- **200:** `{ ok: true }`

---

## USB

### GET /api/vms/:name/usb

List USB devices attached to this VM.

- **200:** `[{ vendorId: "046d", productId: "c077" }]`

### POST /api/vms/:name/usb

Attach a USB device to the VM. Hot-plug when running, persistent config when stopped.

- **Body:** `{ vendorId: string (4 hex chars), productId: string (4 hex chars) }`
- **200:** `{ ok: true }`

### DELETE /api/vms/:name/usb/:id

Detach a USB device. `id` format: `vendorId:productId` (e.g. `046d:c077`). Both must be 4 hex digits.

- **200:** `{ ok: true }`
- **422:** `{ error, detail }` — invalid USB ID format or device not found

---

## Snapshots

### GET /api/vms/:name/snapshots

List snapshots for a VM.

- **200:** `[{ name: string, creationTime: number, state: string }]`

### POST /api/vms/:name/snapshots

Create a snapshot.

- **Body:** `{ name: string }` — name: 1–64 chars, `[a-zA-Z0-9 ._-]`
- **200:** `{ ok: true }`
- **422:** `{ error, detail }` — invalid name (length or pattern)

### DELETE /api/vms/:name/snapshots/:id

Delete a snapshot by name.

- **200:** `{ ok: true }`

### POST /api/vms/:name/snapshots/:id/revert

Revert to a snapshot.

- **200:** `{ ok: true }`

---

## Cloud-Init

### GET /api/vms/:name/cloudinit

Get the cloud-init configuration for a VM.

- **200:** Full stored object when `cloud-init.json` exists: `{ enabled: boolean, hostname?, username?, password?: "set" | "", sshKey?, sshKeySource?, growPartition?, packageUpgrade?, installQemuGuestAgent?, installAvahiDaemon? }` (including `enabled: false` after a soft-disable). If there is no config file, `{ enabled: false }` only.

### PUT /api/vms/:name/cloudinit

Update cloud-init settings.

- With **`enabled: true`** (or omitted): save config, regenerate the seed ISO, attach/update `sde`.
- With **`enabled: false`**: detach `sde`, delete `cloud-init.iso`, and save `cloud-init.json` with `enabled: false` and merged fields (soft-disable; settings retained for re-enabling).

- **Body:**

```json
{
  "enabled": true,
  "hostname": "string",
  "username": "string",
  "password": "string",
  "sshKey": "string",
  "sshKeySource": "github:username | manual",
  "growPartition": true,
  "packageUpgrade": true,
  "installQemuGuestAgent": true,
  "installAvahiDaemon": true
}
```

- **200:** `{ ok: true }`

### DELETE /api/vms/:name/cloudinit

Remove cloud-init completely: detach `sde`, delete `cloud-init.iso` and `cloud-init.json`.

- **200:** `{ ok: true }`

### GET /api/github/keys/:username

Fetch SSH public keys for a GitHub user (server-side proxy to avoid CORS).

- **Params:** username must match `^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`
- **200:** `{ keys: ["ssh-rsa ...", ...] }`
- **404:** No keys found
- **502:** GitHub fetch failed

---

## Backups

### POST /api/vms/:name/backup

Start a backup job. Returns a job ID; monitor progress via SSE.

- **Body:** `{ destinationIds?: ["local", "<mountId>"] }` (defaults to `["local"]`)
- **`destinationIds`:** Only `local` and, if configured in settings, the single `backupMountId` value are accepted. Any other id returns **422**.
- **201:** `{ jobId: string, title: string }` — `title` is e.g. `Backup <vmName>`
- **422:** No valid destination
- **503:** SMB mount failed

### GET /api/vms/backup-progress/:jobId

SSE stream for backup progress.

- **Progress events:** `{ step, percent?, currentFile? }` — `step` values include `domain`, `disk`, `nvram`, `cloudinit`, `manifest`, and an internal `done` step with progress fields before completion.
- **Completion (from job store):** `{ step: "done", path: string, timestamp: string }` — `path` is the backup directory; `timestamp` matches the folder name under `<dest>/<vmName>/`.
- **Failure (terminal):** `{ step: "error", error: string, detail: string }`

### GET /api/backups

List all backups across configured destinations.

- **Query:** `?vmName=ubuntu-server` (optional filter)
- **200:**

```json
[
  {
    "vmName": "ubuntu-server",
    "timestamp": "2025-01-15T10:30:00.000Z",
    "path": "/var/lib/wisp/backups/ubuntu-server/20250115-103000",
    "sizeBytes": 5368709120,
    "destinationLabel": "Local"
  }
]
```

### POST /api/backups/restore

Restore a backup as a new VM. `backupPath` must resolve to a path under a configured backup destination (same validation as DELETE).

- **Body:** `{ backupPath: string, newVmName: string }`
- **200:** `{ name: string }`
- **404:** backup not found
- **422:** `{ error, detail }` — path not under a configured destination or invalid path

### DELETE /api/backups

Delete a backup. Path must be under a configured destination root.

- **Body:** `{ backupPath: string }`
- **200:** `{ ok: true }`

---

## Image Library

### GET /api/library

List image files in the library.

- **Query:** `?type=iso|disk` (optional filter)
- **200:**

```json
[
  {
    "name": "ubuntu-24.04-server.iso",
    "type": "iso",
    "size": 2147483648,
    "modified": "2025-01-10T08:00:00.000Z"
  }
]
```

### POST /api/library/upload

Upload a file to the image library. Streaming multipart — not buffered in memory.

- **Body:** Multipart file upload
- **200:** `{ name, type, size, modified }`
- **409:** File already exists
- **422:** Invalid filename

### DELETE /api/library/:filename

Delete a file from the library.

- **200:** `{ ok: true }`
- **404:** File not found
- **409:** File in use — referenced by one or more VMs (detail lists names)

### PATCH /api/library/:filename

Rename a file.

- **Body:** `{ name: string }`
- **200:** `{ name, type, size, modified }`
- **404:** File not found
- **409:** New name already taken, or source file is referenced by one or more VMs

### GET /api/library/check-url

Check if a URL is reachable (HEAD request).

- **Query:** `?url=https://...`
- **200:** `{ ok: boolean, contentLength: number | null, error?: string, status?: number }`

### POST /api/library/download

Start downloading a file from a URL. Returns job ID.

- **Body:** `{ url: string }`
- **201:** `{ jobId: string, title: string }` — `title` matches the truncated URL display rule used in the UI
- **422:** Invalid URL (only HTTP/HTTPS allowed)

### POST /api/library/download-ubuntu-cloud

Download Ubuntu Server LTS cloud image.

- **201:** `{ jobId: string, title: string }`

### POST /api/library/download-arch-cloud

Download latest Arch Linux x86_64 cloud image (qcow2) from the pkgbuild mirror.

- **201:** `{ jobId: string, title: string }`

### POST /api/library/download-haos

Download Home Assistant OS image.

- **201:** `{ jobId: string, title: string }`

### GET /api/library/download-progress/:jobId

SSE stream for download progress.

- **Progress events:** `{ step: "progress", percent, loaded, total }` (URL download) or `{ step: "decompressing" }` (HAOS flow) between progress updates.
- **Completion (from job store):** `{ step: "done", name, type, size, modified }` — same flattened shape as a successful library file row (no nested `result` object).
- **Failure (terminal):** `{ step: "error", error: string, detail: string }`

---

## Settings

### GET /api/settings

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
  "backupMountId": null
}
```

The shipped `wisp-config.json.example` has empty `mounts`. Mounts are added via **Host → Host Mgmt → Storage** (row-scoped **POST**/**PATCH**/**DELETE** on `/api/host/mounts`). SMB passwords are masked as `***` in the response.

### PATCH /api/settings

Update settings. Partial update — only include fields to change.

- **Body:** Partial settings object (`serverName`, `vmsPath`, `imagePath`, `backupLocalPath`, `containersPath`, `backupMountId`)
- **200:** Updated settings object
- **Validation:** Paths must be absolute (start with `/`).
- **`containersPath`:** Optional; container storage root (same default as `config.js`; exposed for scripts — App Config UI does not edit it yet).
- **Mount CRUD:** Not available via PATCH /api/settings. Use `/api/host/mounts` endpoints below.

### GET /api/host/mounts

List configured mounts (SMB + disk). SMB passwords masked as `***`.

- **200:** Array of mount objects — see [CONFIGURATION.md](CONFIGURATION.md) for field shape.

### POST /api/host/mounts

Append one mount. **Body:** `{ type: "smb" | "disk", label?, mountPath, autoMount?, ...type-specific }`. **`id`** optional (server generates a UUID if omitted). Paths must be absolute. For `type: "smb"`, `share` is required. For `type: "disk"`, `uuid` is required; `fsType` must be one of `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3`.

- **200:** Array of mounts after the insert
- **409:** `MOUNT_DUPLICATE` — id already exists
- **422:** `MOUNT_INVALID` — missing/invalid fields

### PATCH /api/host/mounts/:id

Update one mount by **`id`**. **Body:** partial fields (`label`, `mountPath`, `autoMount`, and type-specific: `share`/`username`/`password` for SMB, `fsType`/`readOnly` for disk). Password **`***`** preserves the stored password. `type` and `uuid` cannot be changed after creation.

- **200:** Array of mounts after the update | **404:** mount not found

### DELETE /api/host/mounts/:id

Remove one mount from settings. If it was **`backupMountId`**, that field is cleared.

- **200:** Array of mounts after removal | **404:** mount not found

### GET /api/host/mounts/status

Mount status for all configured mounts.

- **200:** `[{ id, label, mountPath, mounted: boolean }]`

### POST /api/host/mounts/check

Test an SMB connection for a saved mount or ad hoc credentials.

- **Body:** `{ id?: string, share?: string, username?: string, password?: string }`
- If `id` is provided, credentials are looked up from config and the referenced mount must be `type: "smb"`. Otherwise, use provided `share`/`username`/`password`.
- **200:** `{ ok: true }`
- **404:** SMB mount not found (when using `id`)

### POST /api/host/mounts/:id/mount

Mount an SMB share by settings id. Disk mounts are mounted automatically on device insertion and this endpoint currently returns **422** for `type: "disk"` — dedicated support lands with the disk monitor work.

- **200:** `{ ok: true }`
- **503:** Mount unavailable (platform/helper error)

### POST /api/host/mounts/:id/unmount

Unmount a mount by settings id.

- **200:** `{ ok: true }`

---

## Sections

User-defined groupings for the sidebar workload list. The synthetic **Main** section (`id: "main"`, `builtin: true`) is always present in responses but never persisted. Workloads with no explicit assignment — or with an assignment pointing at a deleted section — fall back to Main on the next read.

All section endpoints (GET, POST, PATCH, DELETE, PUT assign) return the same `{ sections, assignments }` envelope so the client can keep its local copy in sync from a single response — no separate fetch needed after a mutation.

### Response envelope

```json
{
  "sections": [
    { "id": "main", "name": "Main", "order": -Infinity, "builtin": true },
    { "id": "9c12…", "name": "Web", "order": 0, "builtin": false }
  ],
  "assignments": {
    "vm:web1": "9c12…",
    "container:nginx": "9c12…"
  }
}
```

`assignments` keys are `"<type>:<workload-name>"` (`<type>` is `vm` or `container`); values are section ids. Missing keys mean Main.

### GET /api/sections

Return the current sections + assignments envelope.

- **200:** Envelope above.

### POST /api/sections

Create a section. Returns the updated envelope.

- **Body:** `{ "name": "string (1–64)" }`
- **200:** Envelope.
- **422 (`SECTION_INVALID`):** Empty / too-long name.
- **409 (`SECTION_DUPLICATE`):** Case-insensitive name collision.

### PATCH /api/sections/:id

Rename a section. The `main` section cannot be renamed.

- **Body:** `{ "name": "string (1–64)" }`
- **200:** Envelope.
- **404 (`SECTION_NOT_FOUND`):** No section with that id.
- **422 (`SECTION_INVALID`):** Empty name or attempted Main rename.
- **409 (`SECTION_DUPLICATE`):** Case-insensitive name collision.

### DELETE /api/sections/:id

Delete a section. Workloads previously assigned to it return to Main on next read. The `main` section cannot be deleted.

- **200:** Envelope (after removal — the assignments map will no longer reference the deleted id).
- **404 (`SECTION_NOT_FOUND`):** No section with that id.

### POST /api/sections/reorder

Replace the persisted ordering of user-defined sections. The body must list every existing section id exactly once (Main is implicit and never appears in the array).

- **Body:** `{ "ids": ["<section-id>", "<section-id>", …] }`
- **200:** Envelope (with `order` reassigned to the array index).
- **422 (`SECTION_INVALID`):** `ids` is not an array, or doesn't list every section exactly once.
- **404 (`SECTION_NOT_FOUND`):** An id in `ids` doesn't match any section.

### PUT /api/sections/assign

Move a workload to a section.

- **Body:** `{ "type": "vm" | "container", "name": "string", "sectionId": "string | null" }`
- `sectionId === null` (or `"main"`) drops the explicit assignment — the workload returns to Main.
- **200:** Envelope.
- **404 (`SECTION_NOT_FOUND`):** Target sectionId doesn't exist.
- **422 (`SECTION_INVALID`):** Bad `type` or empty `name`.

The workload itself isn't validated — assignments are pure metadata, so referencing an unknown VM/container name is a no-op (the entry is ignored on the next list read).

> The VM and container list payloads also include `sectionId` for direct API consumers, but the frontend does not rely on it: SSE only re-pushes on libvirt/containerd events, so after a move the assignments envelope (cached in `sectionsStore`) is the live source of truth on the client.

---

## WebSocket

### WS /ws/console/:name/vnc

VNC console WebSocket proxy. Bridges the browser's noVNC client to QEMU's VNC server on localhost.

- **Auth:** `?token=<jwt>` query parameter (WebSocket handshake cannot carry Authorization header)
- **Protocol:** Binary frames — bidirectional TCP-to-WebSocket bridge
- **Connection flow:**
  1. Verify JWT from query parameter
  2. Validate VM name
  3. Read VNC port from domain XML
  4. Open TCP connection to `127.0.0.1:<port>`
  5. Pipe data bidirectionally between WebSocket and TCP socket
- **Close codes:**
  - `4001` — Authentication required/failed
  - `4000` — Invalid VM name or VNC not available
  - `1011` — TCP connection error

### WS /ws/container-console/:name

Interactive shell in a **running** container. Uses containerd `Tasks.Exec` with a PTY (`/bin/sh`); I/O is bridged over WebSocket.

- **Auth:** `?token=<jwt>` query parameter (same as VNC console)
- **Query:** `cols` and `rows` (optional, defaults 80×24) — initial PTY size; client may send further resize messages after connect
- **Protocol:**
  - **Binary frames** — terminal input (client → server) and output (server → client)
  - **Text frames** — JSON control only: `{ "type": "resize", "cols": number, "rows": number }` (client → server)
- **Connection flow:**
  1. Verify JWT from query parameter
  2. Validate container name
  3. Ensure the container task is running; create a unique exec session with named pipes + `Tasks.Exec` / `Tasks.Start`
  4. Bridge WebSocket ↔ FIFO streams; forward `resize` to `Tasks.ResizePty`
  5. On close, kill the exec process and remove temp FIFO directory
- **Close codes:**
  - `4001` — Authentication required/failed
  - `4000` — Invalid container name, container not running, or exec failed
  - `1011` — Stream/proxy error

---

## Containers

All container routes require JWT authentication. Routes with a `:name` path parameter validate it via `validateContainerName` (length 1–63, regex `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`, no `..`/`/`/`\`); failures return 422 `INVALID_CONTAINER_NAME`.

### GET /api/containers

List all containers (summary).

**200:** `[{ name, type: "container", image, state, iconId, updateAvailable, sectionId }]`. List payload is intentionally minimal — only what the sidebar renders. `updateAvailable` is set by the image update checker (see CONTAINERS.md → *Image updates*) and defaults to `false` when the field is not set on disk. `sectionId` is the assigned sidebar section id (or `"main"` when unassigned — see [Sections](#sections)). Detail fields (`pid`, `cpuLimit`, `memoryLimitMiB`, `restartPolicy`, `autostart`, `pendingRestart`, etc.) are returned by `GET /api/containers/:name`; runtime samples (`uptime`, live CPU/IO) come from the per-container stats SSE.

`iconId` is the optional UI icon key (same registry as VM icons); omit or `null` means the client uses the default container icon.

### GET /api/containers/stream

SSE stream of the container list. Event-driven: pushes when containerd emits a relevant event (`tasks/start`, `tasks/exit`, `tasks/delete`, `containers/create`, `containers/update`, `containers/delete`, etc.), when a `container.json` is written by wisp, or when an image-update check completes. No polling timer — clients receive updates as they happen.

- **Query:** none
- **Content-Type:** `text/event-stream`
- **Event data:** Same array as `GET /api/containers`. An initial event is sent on connect.

### POST /api/containers

Create a new container (async job with image pull). The container is **defined in containerd but not started** (no task, no CNI setup yet) so mounts and settings can be configured before **Start**.

**Body:** `{ name, image, iconId?, app?, appConfig? }`

Optional `iconId` selects a workload icon from the same set as VMs (persisted in `container.json`).

Optional `app` is an app registry ID (e.g. `"caddy-reverse-proxy"`) — creates a custom app container with a dedicated config UI. If `app` is set without `appConfig`, the app module's default config is used. Unknown `app` values → **422**. See [CUSTOM-APPS.md](CUSTOM-APPS.md).

On create, the server writes defaults in `container.json` (empty `mounts`, bridge `network` with a generated MAC and the default container parent bridge, `localDns: true`, etc.). Use **PATCH** to change command, resources, env, mounts, and network before starting.

**200:** `{ jobId: "uuid", title: string }` — `title` is e.g. `Create <name>`

### GET /api/containers/create-progress/:jobId

SSE stream for container creation progress. Events: `{ step: "validating"|"using-local"|"pulling"|"pulled"|"creating"|"done"|"error", ... }`

The `using-local` step replaces `pulling`/`pulled` when the exact literal `image` in the request body already exists in containerd's `wisp` namespace (e.g. an operator pre-loaded it with `ctr -n wisp image import`, or the Create Container form's picker selected it verbatim). In that case the backend skips ref normalization and the Transfer pull entirely, so the sequence is `validating` → `using-local` → `creating` → `done`. For registry-named refs (`nginx:latest` etc.) the sequence is unchanged: `validating` → `pulling` → `pulled` → `creating` → `done`.

### GET /api/containers/images

List OCI images in the containerd `wisp` namespace (same store used when creating containers).

**200:** `[{ name, digest, size, updated }]` — `name` is the full image reference; `digest` is the manifest descriptor digest; **`size`** is the total **compressed** content-store size in bytes (sum of the image manifest’s config + layer descriptor sizes for this host’s platform), not the small top-level index/manifest blob alone; **`updated`** is ISO 8601 from containerd image `updatedAt` / `createdAt`, or `null` if timestamps are missing. If compressed size cannot be resolved, `size` falls back to the top-level descriptor size.

**503:** `NO_CONTAINERD` when containerd is unavailable.

### DELETE /api/containers/images

Remove an image from containerd. Query parameter **`ref`** (required): image reference (e.g. `nginx:latest` or `docker.io/library/nginx:latest`); normalized the same way as create/pull.

**200:** `{ ok: true }`

**404:** `CONTAINER_IMAGE_NOT_FOUND`

**409:** `CONTAINER_IMAGE_IN_USE` — at least one Wisp container’s `container.json` still references this image (after reference normalization). Delete or reconfigure those containers first.

**422:** `INVALID_CONTAINER_IMAGE_REF` — empty or missing `ref`.

**503:** `NO_CONTAINERD`

### POST /api/containers/images/check-updates

Start an image update check in the background. **Body:** `{ ref?: string }` — when `ref` is omitted (or empty) a bulk check runs over every image in the library; when `ref` is given, only that image is checked.

For each image, the current top-level digest is recorded, the image is re-pulled via the Transfer service (idempotent), and the new digest is compared. When they differ, every container using that image reference has its `container.json` updated: `updateAvailable: true` is set, and if the container task is running/paused, `pendingRestart: true` is set as well. See CONTAINERS.md → *Image updates*.

**200:** `{ jobId, title }`. Subscribe to `GET /api/containers/images/check-updates/:jobId` for progress.

### GET /api/containers/images/check-updates/:jobId

SSE stream for the check-updates job. Events:

- `{ step: "checking", ref, index, total }` — check is starting on this image (bulk: index within total; single: 1/1).
- `{ step: "unchanged", ref }` — digest did not change.
- `{ step: "updated", ref, oldDigest, newDigest }` — the registry returned new content; layers were downloaded.
- `{ step: "skipped", ref, reason }` — pull failed (local-only ref, unreachable registry, auth required, etc.); the sweep continues.
- `{ step: "flagged-container", name }` — `container.json` was updated with `updateAvailable` (and `pendingRestart` if running).
- `{ step: "done", checked, updated, flaggedContainers, lastCheckedAt }` — terminal.
- `{ step: "error", error, detail }` — terminal; unexpected failure (e.g. containerd disconnected mid-sweep). Single-image failures use `skipped` instead.

**404:** job not found / expired (TTL 5 min after terminal).

### GET /api/containers/images/update-status

Cached summary of the last check. **200:** `{ lastCheckedAt: ISO8601 | null, imagesChecked: number, imagesUpdated: number }`. In-memory; resets on backend restart.

### GET /api/containers/:name

Full container config including live state.

**200:** Full `container.json` fields plus `state`, `pid`, `uptime`, `type`, and `mdnsHostname` when Local DNS is enabled and registration is active. For bridge networking, `network.ip` / `network.mac` may be set after CNI DHCP; if the task is running and `network.ip` is still empty, the handler may probe the netns once and persist the address (see CONTAINERS.md).

The **`env`** field uses a structured shape: `{ KEY: { value, secret?, isSet? } }`. Non-secret entries are returned as `{ value: "plaintext" }`. Secret entries are returned as `{ value: null, secret: true, isSet: boolean }` — the value is never sent to the client, and `isSet` is `true` when a value is stored on disk. See CONTAINERS.md → *Secret env vars*.

**404:** `{ error, detail }` if container not found.

### PATCH /api/containers/:name

Partially update container config.

**Body:** Any subset of container.json fields, except environment variables — those must use **`envPatch`** (see below). **`iconId`:** set to a string to choose a UI icon (same ids as VM icons), or `null` / empty string to clear and use the client default. **`localDns`:** boolean toggle for mDNS registration. **`runAsRoot`:** boolean — when `true`, the container process runs as UID/GID 0 instead of the Wisp deploy user (required for images that write to root-owned paths inside the container, e.g. OpenWebUI); requires restart.

**`envPatch`:** Delta applied to the container's environment variables. Keyed by env var name:

- `envPatch[KEY] = { value: "new", secret?: boolean }` — upsert. Fields omitted on an existing entry are preserved.
- `envPatch[KEY] = null` — remove the entry.

Rules: a brand-new key with `secret: true` requires an explicit `value` (otherwise **422** `CONFIG_ERROR`). Flipping an existing entry from `secret: true` → `secret: false` without providing a new `value` clears the stored value to `""` (the UI warns the user before doing this). Renames are expressed as `{ OLD: null, NEW: { value: "..." } }`. Sending a top-level `env` field in the PATCH body is rejected with **422** `CONFIG_ERROR` (`Use envPatch to update environment variables`). Any non-empty `envPatch` on a running container sets `requiresRestart: true`.

**`network`:** Merged with the existing object (not replaced wholesale). **Bridge networking** requires **`network.mac`** after merge (unicast format). While the task is **running or paused**, **`network.ip`** from the body is ignored (server-owned), and changing **`network.mac`** or **`network.interface`** returns **409** `CONTAINER_MUST_BE_STOPPED`. Invalid MAC → **422** `INVALID_CONTAINER_MAC`.

**`mounts`:** Replaces the entire mounts array (bulk update). Prefer row-scoped mount routes below for UI editing. Each element: `{ type: "file"|"directory"|"tmpfs", name, containerPath, ... }`. For `file`/`directory`: `readonly`, optional `sourceId`/`subPath` (directories only), `containerOwnerUid`/`Gid`. For `tmpfs`: `sizeMiB` (1–2048, default 64); `sourceId`/`subPath`/`readonly`/`containerOwnerUid`/`Gid` are rejected. **`name`** is a single path segment (storage key under the container’s `files/` directory; tmpfs entries have no on-disk artifact). Duplicate **`name`** or duplicate **`containerPath`** → **422** `CONTAINER_MOUNT_DUPLICATE`. Invalid shape → **422** `INVALID_CONTAINER_MOUNTS`. Mounts removed from the array have their on-disk artifacts deleted automatically (tmpfs has no artifact).

**`devices`:** Replaces the entire devices array. Each element: `{ type: "gpu", device }`. v1 caps the array at one entry; `type` must be `"gpu"`; `device` must match `^/dev/dri/renderD\d+$`. Invalid shape → **422** `INVALID_CONTAINER_DEVICES`. Always requires a task restart on running containers. The configured device must exist and be a character device at start; otherwise the container fails to start with **503** `CONTAINER_DEVICE_MISSING`. See CONTAINERS.md → [Devices entry](../spec/CONTAINERS.md#devices-entry) for details.

**`services`:** Not editable via PATCH — returns **422** `CONFIG_ERROR`. Use the row-scoped service endpoints (`POST` / `PATCH` / `DELETE` `/api/containers/:name/services[/:port]`) below.

**`appConfig`:** (app containers only) Structured config for the app. Validated by the app module; on success, regenerates derived env, mounts, and mount files. Sets `pendingRestart: true` if the container is running. Sending `envPatch` or `mounts` on an app container → **422** `APP_CONFIG_ONLY`.

**`eject: true`:** (app containers only) Removes `app`, `appConfig`, and `pendingRestart` from the config. Generated env vars and mounts are preserved as-is and become directly editable. One-way operation.

**200:** `{ requiresRestart: boolean, reloaded?: boolean }` — `reloaded: true` when the app was live-reloaded (no restart needed).

**422:** `APP_RELOAD_FAILED` — the app's reload command exited non-zero. Config is saved but the app rejected it; check `detail` for stderr.

### DELETE /api/containers/:name

Delete a container. Query param: `deleteFiles` (default `true`).

**200:** `{ ok: true }`

### POST /api/containers/:name/start

Start a stopped container.

**200:** `{ ok: true }` | **409:** already running

### POST /api/containers/:name/stop

Stop a running container (SIGTERM + grace period).

**200:** `{ ok: true }` | **409:** not running

### POST /api/containers/:name/restart

Restart a container (stop + start).

**200:** `{ ok: true }`

### POST /api/containers/:name/kill

Kill a container (SIGKILL).

**200:** `{ ok: true }` | **409:** not running

### GET /api/containers/:name/stats

SSE stream for per-container stats.

- **Query:** `?intervalMs=` (default **3000**, min **2000**, max **60000**) — push interval in milliseconds for sampled metrics (CPU, memory, uptime).
- **Event data:** `{ state, cpuPercent, memoryUsageMiB, memoryLimitMiB, uptime, pid }` (and related fields from `getContainerStats`).
- **Errors:** `{ error, detail, code }` (same shape as other SSE error payloads).

Default interval is **3s** when `intervalMs` is omitted.

### GET /api/containers/:name/runs

List log runs for a container. Each start creates a new run under `runs/<runId>.log` with a sidecar `runs/<runId>.json` holding timing + exit status. The newest 10 runs are kept (older pairs pruned on new-run allocation).

**200:** `{ runs: [{ runId, startedAt, endedAt, exitCode, imageDigest, logSizeBytes }, ...] }` — newest first. `endedAt` / `exitCode` are null for the currently-running run.

### GET /api/containers/:name/logs

SSE stream for a single run's logs. Initial event: `{ type: "history", lines, runId }`. Subsequent: `{ type: "line", line }`.

- **Query:** `?runId=<runId>` — optional. Omit (or pass an empty value) to stream the newest run (the currently-running one if any, else the most recent completed run). Runs that have ended are served from disk and then idle-tailed — the SSE connection stays open with no new lines until the client disconnects. The live tail streams new bytes appended after the connection opens.
- **Errors:** `CONTAINER_RUN_NOT_FOUND` (404) if a non-existent or malformed `runId` is requested.
- **Empty state:** containers with no runs yet (never started) return a single history event with `lines: []` and `runId: null`.

### GET /api/containers/:name/runs/:runId/log

Download one run's log file. Responds with `Content-Type: text/plain; charset=utf-8` and an RFC 5987 `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded(name-runId.log)>` header. Streams the file directly from disk. `runId` must match `^[a-zA-Z0-9._-]+$`.

**404:** `CONTAINER_RUN_NOT_FOUND` if the run does not exist. **422:** invalid `runId` format.

### POST /api/containers/:name/mounts

Append one bind mount (row-scoped). **Body:** `{ type: "file"|"directory"|"tmpfs", name, containerPath, ... }` (same shape as one element of **`mounts`** in **PATCH**; `readonly`/`sourceId`/`subPath`/`containerOwnerUid`/`Gid` for file/directory; `sizeMiB` for tmpfs).

**200:** `{ requiresRestart: boolean }` | **422:** `INVALID_CONTAINER_MOUNTS`, `CONTAINER_MOUNT_DUPLICATE`

### PATCH /api/containers/:name/mounts/:mountName

Update one mount by its current storage **`name`** (URL segment). **Body:** optional subset of `{ name, containerPath, readonly, sourceId, subPath, containerOwnerUid, containerOwnerGid }` for file/directory mounts, or `{ name, containerPath, sizeMiB }` for tmpfs mounts (other fields rejected on tmpfs). Renaming **`name`** moves `files/<oldName>` to `files/<newName>` on disk; tmpfs renames are config-only.

**200:** `{ requiresRestart: boolean }` | **404:** `CONTAINER_MOUNT_NOT_FOUND` | **422:** duplicate path/name

### DELETE /api/containers/:name/mounts/:mountName

Remove one mount and delete its `files/<mountName>` backing store (tmpfs has no backing store; its row is removed config-only).

**200:** `{ requiresRestart: boolean }` | **404:** `CONTAINER_MOUNT_NOT_FOUND`

### Mount backing store (`files/<mountName>`)

Multipart **file** upload: a single file part (field name typically **`file`**). The mount must already exist in `container.json`.

**400:** `BAD_MULTIPART_TOO_MANY_FILES` if more than one file part | plain `{ error, detail }` if no file part.

### POST /api/containers/:name/mounts/:mountName/file

Multipart: one file part. Mount must have **`type: "file"`**. Overwrites an existing file.

**200:** `{ name, size, modified }`

### POST /api/containers/:name/mounts/:mountName/zip

Multipart: one file part. Mount must have **`type: "directory"`**. Clears `files/<mountName>/` and extracts the zip using the system **`unzip`** binary (entry paths validated with **`unzip -Z1`** before extraction for zip-slip safety).

**200:** `{ ok: true }` | **422:** `CONTAINER_ZIP_INVALID`, `CONTAINER_ZIP_UNSAFE`

### GET /api/containers/:name/mounts/:mountName/content

**File** mounts only. Returns the backing file as UTF-8 text for the in-app editor.

**200:** `{ content: string }` — UTF-8 text (max **512 KiB** decoded size on disk).

**404:** `CONTAINER_MOUNT_NOT_FOUND` | **422:** `CONTAINER_MOUNT_TYPE_MISMATCH`, `CONTAINER_MOUNT_FILE_TOO_LARGE`, `CONTAINER_MOUNT_FILE_NOT_UTF8`, `CONTAINER_MOUNT_SOURCE_MISSING` (no file on disk yet)

### PUT /api/containers/:name/mounts/:mountName/content

**Body:** JSON `{ "content": string }`. Replaces the backing file with UTF-8 bytes (max **512 KiB** encoded length). The route's `bodyLimit` is set just above the content cap to reject oversized payloads at the parser before reaching the handler; the handler enforces the exact byte cap on the decoded content.

**200:** `{ ok: true }` | **413:** request body too large | **422:** same family as GET for type/size/encoding

### POST /api/containers/:name/mounts/:mountName/init

Create an empty file (0 bytes) or empty directory according to the mount **`type`** (still supported for API clients; the UI relies on automatic creation when saving mounts or starting).

**200:** `{ ok: true }`

### DELETE /api/containers/:name/mounts/:mountName/data

Remove the backing file or directory tree for that mount. The mount row remains in `container.json` until **DELETE** `/mounts/:mountName` or **PATCH** replaces **`mounts`**.

### POST /api/containers/:name/services

Append one mDNS service advertisement (row-scoped, keyed by port). **Body:** `{ port: integer, type: string, txt?: object }` — `type` matches `^_[a-z0-9-]+\._(tcp|udp)$`; `txt` is a flat key/value map (values stringified). Requires `localDns: true` on the container. Live registration happens immediately if the container is running.

**200:** `{ requiresRestart: false }` | **409:** `CONTAINER_LOCAL_DNS_DISABLED`, `CONTAINER_SERVICE_DUPLICATE` | **422:** `INVALID_CONTAINER_SERVICE`

### PATCH /api/containers/:name/services/:port

Update one service identified by its current **`port`** (URL segment). **Body:** optional subset of `{ type, txt }`. Port is not editable — delete + create to move to a different port.

**200:** `{ requiresRestart: false }` | **404:** `CONTAINER_SERVICE_NOT_FOUND` | **409:** `CONTAINER_LOCAL_DNS_DISABLED` | **422:** `INVALID_CONTAINER_SERVICE`

### DELETE /api/containers/:name/services/:port

Remove an mDNS service by its port. Live deregistration happens immediately if the container is running.

**200:** `{ requiresRestart: false }` | **404:** `CONTAINER_SERVICE_NOT_FOUND`

**200:** `{ ok: true }`
