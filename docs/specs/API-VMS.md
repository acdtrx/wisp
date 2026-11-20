# API — Virtual machines

VMs, their stats stream, disks, CD-ROMs, USB passthrough and cloud-init. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Virtual Machines

A `:name` in the path that breaks the [name rules](ERROR-HANDLING.md#name-validation) answers **400** `VALIDATION_FAILED`, before anything is read.

### GET /api/vms · `read`

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
    "guestAgent": true,
    "pendingRestart": null,
    "startedAt": 1730000000000,
    "staleBinary": false
  }
]
```

`startedAt` is when QEMU started (epoch ms), `null` while the VM is off; `staleBinary` is `true` when the running QEMU's binary was replaced on disk since it started (a restart picks up the new one). The same rows are the `vms` topic's array.

- `pendingRestart` is `{ since }` (ISO time the change was saved) while a saved definition change awaits a restart of the VM, else `null` — set by a `PATCH` that changed a running VM's definition (or by a state migration), persisted in the domain's `wisp:prefs` metadata, and dropped once the VM's QEMU process is seen to have started after `since`. A guest reboot keeps the process, so it doesn't clear it. See [VM-MANAGEMENT.md → Restart-required flag](VM-MANAGEMENT.md#restart-required-flag).

- `staleBinary` is `true` when the VM's running qemu process is using a binary that has been replaced on disk (typically after a qemu/libvirt package upgrade); the VM needs to be restarted to pick up the new binary. Always `false` for non-running VMs. Detected by reading `/var/run/libvirt/qemu/<name>.pid` and checking whether `/proc/<pid>/exe` ends with ` (deleted)`.
- The list payload does **not** carry section assignment. Section info arrives on its own channel, the `sections` topic of `GET /api/events` (see [Sections](API-WORKSPACE.md#sections)) — libvirt/containerd events don't fire on assignment changes, so the list feeds aren't a usable carrier for it.
- Live updates arrive on the `vms` topic of `GET /api/events` (see [Events stream](API.md#events-stream-sse)): the same array, pushed when libvirt emits a `DomainEvent` (define/undefine/start/stop/etc.), when a VM's config is saved (a rename included), or when a `qemu-system-*` binary is replaced on disk (apt/dnf upgrade). No polling timer.

### POST /api/vms · `admin`

Create a new VM. A [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; its subject is the new name, whose [operation lock](BACKUPS.md#per-vm-operation-lock) it holds for the whole job.

- **Body:**

```json
{
  "name": "string (required, 1-128 chars; starts with a letter or digit, then alphanumeric, dot, hyphen, underscore; no surrounding whitespace, no .. or path separators)",
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

- **`disk.type: existing`:** `sourcePath` must be a `.qcow2`, `.raw` or `.img` image with no backing file or external data file. That is checked inside the job (before the copy): an unusable image ends the job with an `error` event carrying `DISK_FORMAT_UNSUPPORTED` / `DISK_IMAGE_UNSAFE`, and no VM directory is left behind ([VM-MANAGEMENT.md § Untrusted images](VM-MANAGEMENT.md#untrusted-images)).

- **`videoDriver` / `graphicsType`:** one of `virtio`, `qxl`, `vga` / `vnc`, `spice` (schema enums, on create and `PATCH`); any other value → **400** `VALIDATION_FAILED` (settled 2026-11-12).

- **`cloudInit.enabled`:** Optional; default is on. If `false`, cloud-init is skipped during create (no seed ISO, no `sde`, no `cloud-init.json`).

- **202:** `{ jobId: string, title: string }` — `title` is the display label for the background job (e.g. `Create <name>`)
- **Progress events:** `{ step, ... }` — `step` includes `validating`, `copying` (may include `percent`), `resizing`, `creating-disk`, `cloudinit`, `defining`.
- **`done` result:** `{ name }` — the new VM's name
- **409:** `{ error, detail }` — `VM_EXISTS` when a VM with that name is defined; `VM_DIR_EXISTS` when `<vmsPath>/<name>/` already exists (e.g. left by *Delete VM, keep disks*); `detail` says so, the path redacted (`<path>`); `VM_BUSY` while another job holds that name's lock (e.g. a create or restore as new to the same name). Checked before the job starts; nothing is created.
- **400:** `VALIDATION_FAILED` — the body fails its schema: a name that breaks the [name rules](ERROR-HANDLING.md#name-validation), a wrong type, a missing `name`, or an unknown key at any level (in `nics[]`, `disk`, `disk2` and `cloudInit` too). A NIC takes no VLAN (`vlan` is an unknown key): use a VLAN-specific bridge (for example `br0-vlan22`) instead

### GET /api/vms/:name · `read`

Full VM configuration parsed from domain XML.

- **200:** Full VM config object, read from the VM's saved (inactive) definition: `name`, `uuid`, `state`, `stateCode`, `autostart`, `vcpus`, `memoryMiB`, `osType`, `osCategory`, `arch`, `machineType`, `firmware`, `cpuMode`, `cpuTopology`, `cpuFeatures`, `nestedVirt`, `bootOrder`, `bootMenu`, `disks[]` (`slot`, `device`, `bus`, `source`, `driverType`, `readonly`, `sizeGiB`), `nics[]` (`type`, `mac`, `source`, `model`, `target`), `graphics` (`type`, `port`, `listen`, `autoport`), `videoModel`, `features` (`hyperv`), `memBalloon`, `guestAgent`, `vtpm`, `virtioRng`, `iconId`, `localDns`, `pendingRestart` — `pendingRestart` as on the list payload. USB attachments are `GET /api/vms/:name/usb`.

Each `disks[]` entry may include **`sizeGiB`** (integer, virtual size in GiB, rounded) for **`device: "disk"`** entries with a file `source`, when `qemu-img info` succeeds. Omitted if the image is missing or size read fails.

### PATCH /api/vms/:name · `admin`

Update VM configuration.

- **Body:** Partial config object. Allowed fields: `name`, `memoryMiB`, `vcpus`, `cpuMode`, `nestedVirt`, `machineType`, `firmware`, `bootOrder`, `bootMenu`, `osType`, `nics`, `videoDriver`, `graphicsType`, `memBalloon`, `vtpm`, `virtioRng`, `guestAgent`, `iconId`, `localDns`, `autostart`. Any other key, here or in a `nics[]` entry, is refused: **400** `VALIDATION_FAILED` naming it. `videoDriver` and `graphicsType` take the values listed under create; any other → **400** `VALIDATION_FAILED`, as is a `name` that breaks the [name rules](ERROR-HANDLING.md#name-validation).
- **204:** saved; the VM's new state reaches clients as `{ kind: "vm", id: <name> }` on the [`changes`](API.md#changes-topic-payload) topic, under the new name after a rename. When the VM is running and the patch changed its domain definition (anything but icon, local DNS and autostart), its `pendingRestart` flag is set
- **409:** `{ error, detail }` — e.g. `VM_MUST_BE_OFFLINE` when renaming while the VM is running; `VM_EXISTS` / `VM_DIR_EXISTS` when the new name belongs to another VM or `<vmsPath>/<name>/` already exists (the rename reserves that directory first, so a concurrent rename or create to the same name gets this, see [VM-MANAGEMENT.md → Renaming](VM-MANAGEMENT.md#renaming)); `VM_BUSY` while another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock) — every PATCH takes it, rename or not, and a rename also takes the new name's (`VM_BUSY` while a job holds that name)
- A NIC takes no VLAN: `vlan` in a `nics[]` entry is an unknown key, **400** `VALIDATION_FAILED`; use a VLAN-specific bridge (for example `br0-vlan22`) instead

`localDns` is supported in PATCH and controls VM mDNS registration behavior.

### DELETE /api/vms/:name · `admin`

Delete a VM.

- **Query:** `?deleteDisks=true|false` — whether to also delete disk images and VM directory
- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name }`
- **404:** `VM_NOT_FOUND`
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)

### GET /api/vms/:name/xml · `read`

Raw libvirt domain XML (for debugging/inspection).

- **200:** `{ xml: string }`

### POST /api/vms/:name/start · `admin`

- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name }`
- **404:** `VM_NOT_FOUND`
- **409:** `VM_ALREADY_RUNNING`; `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)
- **Job errors:** `LIBVIRT_ERROR`

### POST /api/vms/:name/stop · `admin`

Graceful shutdown (ACPI).

- **204:** shutdown requested; the state change arrives on the `vms` topic
- **409:** `VM_BUSY` — another operation on this VM holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock). The stop holds it only while the request is sent, so a force stop is accepted while the guest shuts down.

### POST /api/vms/:name/force-stop · `admin`

Immediate force stop (destroy).

- **202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name }`
- **404:** `VM_NOT_FOUND` | **409:** `VM_NOT_RUNNING`; `VM_BUSY` — another operation on this VM holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)
- **Job errors:** `LIBVIRT_ERROR`

### POST /api/vms/:name/reboot · `admin`

- **204:** reboot requested
- **409:** `VM_BUSY` — as for stop

### POST /api/vms/:name/suspend · `admin`

- **204:** suspended; the state change arrives on the `vms` topic
- **409:** `VM_BUSY` — as for stop

### POST /api/vms/:name/resume · `admin`

- **204:** resumed; the state change arrives on the `vms` topic
- **409:** `VM_BUSY` — as for stop

---

## VM Stats (SSE)

### GET /api/vms/:name/stats · `read`

SSE stream of per-VM statistics. Pushes every 5 seconds.

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

### POST /api/vms/:name/disks · `admin`

Attach an existing disk image or create and attach a new empty disk. VM must be stopped.

- **Body (attach existing):** `{ slot: "sda" | "sdb", path: string, bus?: "virtio" | "scsi" | "sata" | "ide" }`
- **Body (create new):** `{ slot: "sda" | "sdb", sizeGB: number, bus?: "virtio" | "scsi" | "sata" | "ide" }` — creates a new qcow2 in the VM directory under the lowest `disk<N>.qcow2` name not already present (never overwrites an existing file) and attaches it. Provide either `path` or `sizeGB`, not both.
- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_MUST_BE_OFFLINE` (VM not stopped), `DISK_SLOT_IN_USE` (slot already holds a device — detach it first), `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)
- **422:** `INVALID_REQUEST` for both or neither of `path` and `sizeGB` provided, or for a slot other than `sda`/`sdb`; `PATH_NOT_ALLOWED` for a `path` outside the allowed roots; `DISK_FORMAT_UNSUPPORTED` for an image that is not a `.qcow2` / `.raw` / `.img` qcow2-or-raw file; `DISK_IMAGE_UNSAFE` for an image with a backing file or external data file ([VM-MANAGEMENT.md § Untrusted images](VM-MANAGEMENT.md#untrusted-images))

### DELETE /api/vms/:name/disks/:slot · `admin`

Detach a disk from a VM slot.

- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)

### POST /api/vms/:name/disks/:slot/resize · `admin`

Resize a disk.

- **Body:** `{ sizeGB: number }`
- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)
- **422:** `RESIZE_INVALID` (not larger than the current size), `DISK_IMAGE_UNSAFE` (the disk has a backing file), `DISK_FORMAT_UNSUPPORTED` (its `<driver type>` is not qcow2/raw)

### POST /api/vms/:name/disks/:slot/bus · `admin`

Change the disk controller (bus) for a block disk slot. VM must be stopped.

- **Body:** `{ bus: "virtio" | "scsi" | "sata" | "ide" }`
- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)
- **422:** `DISK_NOT_FOUND` — slot is not a block disk; an invalid `bus` is **400** `VALIDATION_FAILED`

---

## CDROM (ISO)

### POST /api/vms/:name/cdrom/:slot · `admin`

Attach an ISO to a CDROM slot. Supports hot-plug (live + config).

- **Params:** slot is `sdc` or `sdd`
- **Body:** `{ path: string }`
- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock) (taken in every VM state, hot-plug included)

### DELETE /api/vms/:name/cdrom/:slot · `admin`

Eject an ISO from a CDROM slot. Supports hot-unplug.

- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)

---

## USB

### GET /api/vms/:name/usb · `read`

List USB devices attached to this VM.

- **200:** `[{ vendorId: "046d", productId: "c077" }]`

### POST /api/vms/:name/usb · `admin`

Attach a USB device to the VM. Hot-plug when running, persistent config when stopped.

- **Body:** `{ vendorId: string (4 hex chars), productId: string (4 hex chars) }`
- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock) (taken in every VM state, hot-plug included)

### DELETE /api/vms/:name/usb/:id · `admin`

Detach a USB device. `id` format: `vendorId:productId` (e.g. `046d:c077`). Both must be 4 hex digits; any other `id` is **400** `VALIDATION_FAILED`.

- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)
- **422:** `{ error, detail }` — `USB_DETACH_FAILED`: device not found

---

## Cloud-Init

### GET /api/vms/:name/cloudinit · `read`

Get the cloud-init configuration for a VM.

- **200:** Full stored object when `cloud-init.json` exists: `{ enabled: boolean, hostname?, username?, password?: "set" | "", sshKey?, sshKeySource?, growPartition?, packageUpgrade?, installQemuGuestAgent?, installAvahiDaemon? }` (including `enabled: false` after a soft-disable). If there is no config file, `{ enabled: false }` only.

### PUT /api/vms/:name/cloudinit · `admin`

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

- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **404:** `VM_NOT_FOUND` — no such VM; nothing is written (no VM directory is created)
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)

### DELETE /api/vms/:name/cloudinit · `admin`

Remove cloud-init completely: detach `sde`, delete `cloud-init.iso` and `cloud-init.json`.

- **204:** done; the VM's new state reaches clients as `{ kind: "vm", id }` on the `changes` topic
- **409:** `VM_BUSY` — another operation on this VM (e.g. a backup) holds the [per-VM operation lock](BACKUPS.md#per-vm-operation-lock)

### GET /api/github/keys/:username · `admin`

Fetch SSH public keys for a GitHub user (server-side proxy to avoid CORS).

- **Params:** username must match `^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$`
- **200:** `{ keys: ["ssh-rsa ...", ...] }`
- **404:** `GITHUB_KEYS_NOT_FOUND` — no keys found
- **502:** `GITHUB_KEYS_UNAVAILABLE` — the lookup failed, or the SSRF guard refused a redirect ([CLOUD-INIT.md](CLOUD-INIT.md#github-ssh-key-import))
