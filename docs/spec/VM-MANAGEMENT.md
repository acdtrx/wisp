# VM Management

This document covers the core VM lifecycle, configuration, creation, and the backend module that interfaces with the hypervisor.

## VM Lifecycle

### States

| State | Code | Description |
|-------|------|-------------|
| running | 1 | VM is actively executing |
| idle | 2 | VM is idle (libvirt internal) |
| paused | 3 | VM is suspended/paused |
| shutdown | 4 | Shutting down (in progress) |
| shutoff | 5 | VM is stopped |
| crashed | 6 | VM has crashed |
| pmsuspended | 7 | Power-management suspended |

### Operations

| Operation | Precondition | DBus Method | Flags | Notes |
|-----------|-------------|-------------|-------|-------|
| Start | VM is stopped | `Domain.Create(0)` | 0 | |
| Stop (graceful) | VM is running | `Domain.Shutdown(0)` | 0 | ACPI shutdown signal |
| Force stop | VM is running | `Domain.Destroy(0)` | 0 | Immediate power-off |
| Reboot | VM is running | `Domain.Reboot(0)` | 0 | |
| Suspend | VM is running | `Domain.Suspend()` | — | Pauses VM execution |
| Resume | VM is paused | `Domain.Resume()` | — | |

### State change events

The backend listens for `DomainEvent` signals on the libvirt Connect interface. Event codes:

- 0 = defined, 1 = undefined, 2 = started, 3 = suspended, 4 = resumed, 5 = stopped

When a domain stops (event 5) or is undefined (event 1), cached VM stats for that domain are cleared.

## Name validation

VM names go through `validateVMName(name)` (in `backend/src/lib/validation.js`):

- length 1–128
- regex `^[a-zA-Z0-9._-]+$`
- rejects `..`, `/`, `\`

It is enforced in three places:

1. The `vmsRoutes` `preHandler` (every `/vms/:name/...` route) — for the path parameter.
2. `POST /vms` and `POST /vms/:name/clone` route handlers — for `body.name` / `body.newName`, before any background job is created.
3. `createVM`, `cloneVM`, and `updateVMConfig` (rename branch) — defense in depth so library callers get the same guarantee.

Failures map to HTTP 422 (`INVALID_VM_NAME`).

## VM Creation

### Templates

Five predefined templates provide default configurations:

| Template | OS Type | OS Variant | Firmware | Special |
|----------|---------|-----------|----------|---------|
| Ubuntu Server | Linux | ubuntu24.04 | UEFI | Cloud-init enabled by default |
| Ubuntu Desktop | Linux | ubuntu24.04 | UEFI | Cloud-init enabled by default |
| Windows 11 | Windows | win11 | UEFI + SecureBoot | vTPM enabled, Windows optimizations applied, cloud-init hidden |
| Home Assistant OS | Other | generic | UEFI | Cloud-init hidden, no ISO needed, existing image picker |
| Custom | Other | generic | BIOS | No pre-fills |

### Creation flow

1. **Validate** — check name uniqueness, validate parameters
2. **Create VM directory** — `<vmsPath>/<name>/`
3. **Handle disk(s)** — for each requested block disk (`disk`, then `disk2`, skipping `type: none`), create a new qcow2 or copy/convert an existing image from the library into `disk0.qcow2`, `disk1.qcow2` in order. If both are `none`, no block disk images are created (CD-ROM–only or network-only installs are allowed).
4. **Optional resize** — resize the copied disk if a target size was specified
5. **Optional cloud-init** — generate seed ISO and config files
6. **Build domain XML** — build a domain object and serialize with fast-xml-parser (`buildXml`); UEFI loader/nvram paths are set on the object when firmware is available
7. **Define domain** — `Connect.DomainDefineXML(xml, 0)` registers the VM with libvirt
8. **Set autostart** — if requested, set autostart via DBus Properties

Progress is reported via callback for each step, streamed to the frontend via SSE.

### Disk provisioning

- **New disk:** Created with `qemu-img create -f qcow2 <path> <size>G`
- **Existing image:** Copied from the image library to the VM directory using `qemu-img convert -O qcow2 -p <src> <dst>`. Progress is parsed from stdout (`-p` flag). The source image is never modified.
- **Resize:** After copy, `qemu-img resize <dst> <size>G` if a resize target was specified. Can only grow, not shrink.

## Cloning

A VM can be cloned when it is stopped.

1. Validate `newName` (`validateVMName`); reject if a VM with that name already exists.
2. **Create the cloned VM's directory** at `<vmsPath>/<newName>/` (`mkdir -p`).
3. Copy each disk **into the new VM's directory** preserving its basename (`cp --reflink=auto` falling back to `copyFile`). For example, cloning `archy` → `archy2` produces `<vmsPath>/archy2/disk0.qcow2`, **not** `<vmsPath>/archy/archy2.qcow2`. This keeps the "directory == VM name" invariant so a later rename or delete of the clone behaves predictably.
4. Read the original domain XML, parse with `parseDomainRaw`.
5. Mutate the domain object: new name, drop uuid, point each disk `<source file>` at the copied path, regenerate every NIC MAC, and (UEFI only) **always** point `<nvram>` at the new VM's `<vmsPath>/<newName>/VARS.fd` and `copyFile` the source's NVRAM file there. The clone never shares NVRAM with the source — even if the source's NVRAM lives in a legacy location outside its expected directory. If the source NVRAM file is missing on disk, the copy is skipped and libvirt template-fills on first define.
6. Serialize with `buildXml(parsed)` and define via `Connect.DomainDefineXML`.

On define failure: the copied disks and the new VM's directory are removed so a retry starts clean.

## Renaming

A VM can be renamed when it is stopped (rename is the `name` field in `PATCH /api/vms/:name`).

1. Pre-check: VM offline; the new name passes `validateVMName`; no other VM already uses it; the target directory `<vmsPath>/<newName>/` does not already exist.
2. **Infer the source dir.** `findActualVmDir` walks every absolute path in the parsed domain XML (disk `<source file>`, NVRAM, loader) and picks the deepest directory under `<vmsPath>/`. This may not equal `<vmsPath>/<oldName>/` — legacy state from a pre-fix rename can leave files in a directory whose name no longer matches the libvirt domain name. The rename converges that state by moving from the *actual* dir, not the *expected* one.
3. **`iface.Rename(newName, 0)`** — libvirt updates the domain's `<name>` element.
4. **`fs.rename(actualOldDir, <vmsPath>/<newName>)`** — atomic move on the same filesystem; brings disks, NVRAM, cloud-init artefacts, and the `snapshots/` subdirectory along. On failure, the libvirt rename is rolled back.
5. **Rewrite domain XML paths** (`vmManagerRename.rewriteDomainPaths`): every `<disk><source file>`, `<os><nvram>`, and `<os><loader>` value that started with `actualOldDir/` is rewritten to `<vmsPath>/<newName>/…`, then the domain is redefined via `DomainDefineXML`. On failure here, both the directory move and the libvirt rename are rolled back.
6. **Rewrite snapshot memory paths** (`vmManagerRename.rewriteSnapshotMemoryPaths`): walk every domain snapshot, update `<memory @file>` if it pointed into `actualOldDir`, and redefine the snapshot via `SnapshotCreateXML(xml, VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE)`. Per-snapshot failures are logged but do not unwind the rename.

After step 5, the on-disk layout, libvirt's name, and the domain XML's absolute paths are all consistent under the new name. Backups taken before the rename keep references to the old path in their manifest — this is intentional; restore re-creates the per-VM dir under the **current** name.

### Out-of-band renames

Renames performed outside Wisp (`virsh domrename`, hand-edited domain XML, etc.) are **not** auto-reconciled. The VM mDNS publisher tracks domains by name, so an external rename leaves a stale Avahi entry under the old name until the backend restarts; per-VM directories and snapshot memory paths are also untouched. If you must rename outside Wisp, restart `wisp` afterwards so the publisher re-syncs and run the standard Wisp rename to reconcile the on-disk layout.

## Deletion

1. Force-stop the VM if it is running.
2. Delete all snapshots (best-effort; libvirt won't undefine while snapshots exist).
3. **`Domain.Undefine(flags)`**:
   - `deleteDisks=true` and the NVRAM file lives inside this VM's own dir → `VIR_DOMAIN_UNDEFINE_NVRAM` so libvirt removes its managed NVRAM along with everything else.
   - All other cases (`deleteDisks=false`, **or** the NVRAM file lives outside the VM's dir — legacy state from a pre-fix rename, or a clone produced by buggy older code) → `VIR_DOMAIN_UNDEFINE_KEEP_NVRAM`. We never let libvirt delete a file that may belong to another VM.
4. **`deleteDisks=true`** only: `rm -rf <vmsPath>/<name>/`. Disks, NVRAM, cloud-init artifacts, snapshots — everything goes.
   **`deleteDisks=false`**: the per-VM directory is left **completely untouched**. The operator chose "keep my data"; that means disks, NVRAM, cloud-init.iso, cloud-init.json all stay. A subsequent re-create with the same name picks them up.

## VM Configuration

### Reading config

`getVMConfig(name)` resolves the domain via DBus, reads its **inactive** (persistent) XML with `GetXMLDesc(2)`, and parses it into a structured object containing: name, uuid, state, vcpus, memoryMiB, disks, nics, firmware, machineType, cpuMode, videoDriver, graphicsType, bootOrder, bootMenu, memBalloon, guestAgent, vtpm, virtioRng, nestedVirt, osCategory, osVariant, autostart, iconId, and `localDns`. Each file-backed **disk** (`device: disk`) entry may include **`sizeGiB`** (virtual size via `qemu-img info` when the image is readable). Reading inactive XML ensures saved config edits (e.g. boot menu, firmware, video driver) are reflected immediately on running VMs — `DomainDefineXML` writes there, and active XML on a running VM does not pick up such changes until the next start. The only consumer of active XML in vmManager is `getVNCPort`, which needs the runtime-allocated VNC port.

### Updating config

`updateVMConfig(name, changes)` applies partial configuration changes. The update logic:

1. Reads the current domain XML
2. Parses it and applies the requested changes. **Name changes** use `org.libvirt.Domain.Rename` (same as `virDomainRename`) when the VM is **not running**; then XML is read again. Editing `<name>` and calling `Connect.DomainDefineXML` alone is not used for rename (it fails for many libvirt/QEMU cases).
3. For hot-applicable changes on a running VM: uses `Domain.UpdateDevice(xml, 3)` where flags=3 means LIVE+CONFIG
4. For config-only changes: redefines the domain with `Connect.DomainDefineXML(xml, 0)`
5. Returns `{ requiresRestart: true }` when changes to firmware, machine type, or CPU count are applied to a running VM

### Live vs. offline changes

| Change | Running VM | Stopped VM |
|--------|-----------|------------|
| Name (rename) | Not allowed (stop VM first) | Rename via `Domain.Rename` |
| RAM | Config only (restart required) | Config only |
| CPU count | Config only (restart required) | Config only |
| Firmware | Config only (restart required) | Config only |
| Machine type | Config only (restart required) | Config only |
| NIC config | Config only (restart required) | Config only |
| ISO attach/eject | Live + Config (hot-plug) | Config only |
| Video driver | Config only (restart required) | Config only |
| Boot order | Config only | Config only |
| Toggles (balloon, agent, etc.) | Config only | Config only |
| Local DNS | Immediate register/deregister | Config only (applies on next start) |

## Domain XML Conventions

### CPU topology

CPU count is always expressed as a full topology block. Never use `<vcpu>N</vcpu>` alone:

```xml
<vcpu placement='static'>N</vcpu>
<cpu mode='host-passthrough' check='none' migratable='on'>
  <topology sockets='1' dies='1' cores='N' threads='1'/>
</cpu>
```

`sockets=1`, `dies=1`, `threads=1` are always fixed. Only `cores` changes.

### Dual CDROM slots

Every VM defines two CDROM slots (`sdc` and `sdd`) at creation, even if empty:

```xml
<disk type='file' device='cdrom'>
  <target dev='sdc' bus='sata'/>
  <readonly/>
</disk>
```

When an ISO is attached, the `<source file='...'/>` element is added. When ejected, the `<source>` is removed. These slots are never removed from the XML — only their content changes.

ISO attach/eject uses `Domain.UpdateDevice(xmlString, 3)` (flags: LIVE=1 + CONFIG=2 = 3).

### Disk slot convention

| Slot | Purpose |
|------|---------|
| `sda` | Primary boot disk |
| `sdb` | Secondary data disk (optional) |
| `sdc` | CDROM 1 — boot ISO / OS installer |
| `sdd` | CDROM 2 — secondary ISO (e.g. VirtIO drivers) |
| `sde` | Cloud-init seed ISO (when cloud-init is enabled) |

### UEFI firmware

UEFI VMs include loader and NVRAM in the XML:

```xml
<os>
  <type arch='x86_64' machine='pc-q35-*'>hvm</type>
  <loader readonly='yes' type='pflash'>/usr/share/OVMF/OVMF_CODE_4M.fd</loader>
  <nvram>/var/lib/wisp/vms/<name>/VARS.fd</nvram>
</os>
```

The NVRAM file is copied from the system template at VM creation. Available firmware paths are detected by scanning known locations (varies by Linux distribution) and cached at startup.

For UEFI with Secure Boot, a different firmware file is used (typically `OVMF_CODE_4M.secboot.fd`).

### Windows optimizations

Windows VMs (templates `windows-11`, `win10`) include additional XML blocks:

- **Hyper-V enlightenments:** `<hyperv>` block with relaxed, vapic, spinlocks, vpindex, runtime, synic, stimer, reset, frequencies, reenlightenment, tlbflush, ipi
- **Clock adjustments:** Windows-specific clock configuration with hypervclock timer
- **vTPM:** Software TPM for Windows 11 compatibility

These are applied at creation and preserved on all subsequent config updates.

### Network

Each NIC is defined as:

```xml
<interface type='bridge'>
  <source bridge='br0'/>
  <model type='virtio'/>
  <mac address='52:54:00:xx:xx:xx'/>
</interface>
```

MAC addresses are generated with the `52:54:00` prefix (QEMU's locally-administered range) followed by 3 random bytes.

VM NIC VLAN tagging via `<vlan>` is not used. The Advanced Network VLAN field is shown but disabled, and VM NIC updates clear VLAN values in persisted config; use a VLAN-specific bridge (for example `br0-vlan22`, created from Host → Host Mgmt → Network Bridges) instead.

### Additional devices

- **USB tablet input:** Included by default for better mouse tracking in VNC
- **Memory balloon:** Optional, enabled by default
- **Guest agent channel:** virtio-serial channel for qemu-guest-agent
- **VirtIO RNG:** `/dev/urandom` entropy source
- **vTPM:** Software TPM via swtpm (required for Windows 11)

### Wisp metadata (`wisp:prefs`)

Wisp app-level VM metadata is stored in domain XML metadata under the `https://wisp.local/app` namespace:

- `icon` — workload icon id for the UI
- `localDns` — `"true"`/`"false"` toggle controlling mDNS registration

The backend writes and reads children with the `wisp:` prefix (`wisp:icon`, `wisp:localDns`) to match what libvirt returns after its own XML round-trip. `DomainDefineXML` writes to the **inactive** (persistent) config, while `GetXMLDesc(0)` returns the **active** (live) XML for running VMs — which does not reflect changes (metadata or otherwise) until restart. Both the VM list and the detail view (`getVMConfig`) read inactive XML so saved edits show immediately; runtime fields like the live VNC port have their own dedicated active-XML readers (`getVNCPort`).

For upgrade safety, VMs without `localDns` metadata are treated as `false` (off). New VMs default to `true`.

## Local DNS (mDNS)

VMs can be registered on the local network via mDNS (`.local`) using avahi-daemon.

- Controlled by VM metadata `wisp:prefs.localDns`
- Name source: guest hostname from QEMU guest agent (`GetHostname`) when available; fallback to sanitized VM name
- Address source: guest primary IP from guest agent interface addresses
- Publishing is owned by **`backend/src/lib/linux/vmMdnsPublisher.js`** — a backend reconciler driven by libvirt lifecycle (`DomainEvent`) and qemu-ga lifecycle (`AgentEvent`) signals. It is **not** triggered by the SSE stats stream or any UI activity, so hostnames keep resolving even when no one is viewing the VM in the UI.
- Triggers: backend boot (initial reconcile), `DomainEvent` (any VM start/stop, including externally via `virsh`), `AgentEvent` `state=connected` (publishes immediately when qemu-ga comes up — no IP-fetch retry loop), config endpoint (toggle on/off), and a 45 s periodic reconcile as a safety net for DHCP drift or missed signals.
- The publisher tracks the desired set as `running + localDns=true`, attaches a per-domain `AgentEvent` listener for each tracked VM, and detaches when the VM leaves the set (stop, localDns off, delete).
- Registration is removed when the VM stops, is undefined, or `localDns` is toggled off.
- UI: Advanced section has a **Local DNS** toggle; VM stats bar shows the registered `.local` hostname when active, plus a guest-agent `connected/disconnected` pill.

### Avahi restart recovery

`mdnsManager` listens for `NameOwnerChanged` on the system DBus to detect avahi-daemon restarts. When the owner of `org.freedesktop.Avahi` changes, every cached `EntryGroup` reference is invalidated and `reregisterAll()` re-publishes every entry/service.

dbus-next 0.10.x auto-installs the match rule when you attach a listener on the `org.freedesktop.DBus` proxy iface (`iface.on('NameOwnerChanged', ...)`), so no explicit `AddMatch` call is needed. The previously-used `bus.addMatch` is not a public API in this version and broke watch installation entirely (see CHANGELOG 2026-04-27).

### Guest agent state surfacing

`getVMStats()` derives `guestAgent.connected` from whether `InterfaceAddresses` or `GetHostname` produced a value during the current poll. The flag is `undefined` when the domain XML has no guest_agent channel configured (so the UI hides the pill entirely). `vmMdnsPublisher` independently maintains its own per-VM agent state via the `AgentEvent` signal — the two paths are deliberately decoupled so the stats stream remains side-effect free.

## Backend Module Structure

The VM management backend is organized as a **platform facade** plus implementations:

- **`backend/src/lib/vmManager.js`** — facade. At load time it imports either `linux/vmManager/` (libvirt over DBus) or `darwin/vmManager/` (dev stub: no libvirt). Routes import only this module.
- **`backend/src/lib/vmManagerShared.js`** — pure helpers shared by both platforms (`vmError`, `unwrapVariant`, `unwrapDict`, `formatVersion`, `generateMAC`); no DBus.

### Linux: `backend/src/lib/linux/vmManager/vmManagerConnection.js`

- DBus system bus connection to `org.libvirt` at `/org/libvirt/QEMU`
- Connection state management (bus, connectIface, connectProps)
- Automatic reconnection on DBus error (2-second delay via `setTimeout`; other timers are used for non-race housekeeping — e.g. job-store TTL in `jobStore.js`, SSE intervals — see project timing rules in `docs/WISP-RULES.md`)
- Domain lookup by name (`DomainLookupByName`)
- Domain state retrieval (`GetState`)
- Domain XML retrieval (`GetXMLDesc`)
- DomainEvent signal listener for state change tracking, fanned out to subscribers via `subscribeDomainChange(handler)` (used by `vmManagerList` for cache refresh and by `vmMdnsPublisher` for reconcile)
- Per-domain `AgentEvent` (qemu-ga lifecycle) subscription helpers: `attachAgentSubscription(path, name)` / `detachAgentSubscription(path)`. Handlers register via `subscribeAgentEvent((vmName, { state, reason, domainPath }))` — `state=1` is connected, `state=0` is disconnected. Note: libvirt's C constant is `VIR_DOMAIN_EVENT_ID_AGENT_LIFECYCLE`, but libvirt-dbus surfaces it as the `AgentEvent` signal on the per-domain `org.libvirt.Domain` interface.

### macOS: `backend/src/lib/darwin/vmManager/index.js`

- No DBus; `connect()` logs a dev-mode warning; VM APIs throw `NO_CONNECTION` or return empty lists where appropriate (same behavior as the former `IS_DARWIN` branches).

### `vmManagerXml.js` (under `linux/vmManager/`)

XML parsing and building utilities using fast-xml-parser. Handles the conversion between libvirt XML and the structured config objects used by the rest of the application.

### `vmManagerHost.js` (under `linux/vmManager/`)

- Host info (hostname, versions, uptime, kernel, primary IP)
- Host hardware (CPU cores, total memory)
- Network bridge enumeration
- UEFI firmware path discovery
- USB device listing via sysfs (`usbMonitor.js`; see [USB.md](USB.md))

### vmManagerList.js

- **VM list cache** — in-memory cache of the VM list, populated on connect and refreshed automatically on any `DomainEvent` signal (defined, undefined, started, stopped, suspended, resumed) and on any qemu binary replacement detected by `watchQemuBinaries` (apt/dnf upgrade of `qemu-system-*`). `listVMs()` returns the cache when populated, avoiding per-call libvirt queries. The cache is invalidated on disconnect or bus error. Each cached entry holds: `name`, `uuid`, `domainPath`, `state`, `stateCode`, `vcpus`, `memoryMiB`, `osCategory`, `iconId`, `localDns`, `guestAgent`, `staleBinary`.
- `listVMs()` — returns cached VM list (sub-millisecond); falls back to a live libvirt query on first call before cache populates.
- `getRunningVMAllocations()` — sums `vcpus` and `memoryMiB` across cached entries with `stateCode === 1` (running). Powers the host stats SSE allocation totals without per-tick libvirt traffic; updates piggyback on the same DomainEvent-driven cache refresh used by `listVMs()`.
- `getVMConfig(name)` — full VM configuration parsed from XML
- `getCachedLocalDns(name)` — reads the `localDns` flag for a VM from the cached list; used by `getVMStats` to avoid an extra inactive XML fetch per stats cycle
- `getCachedVcpus(name)` — reads cached vCPU count; used by `getVMStats` for CPU% computation without a per-tick `GetXMLDesc`
- `getCachedGuestAgent(name)` — reads whether the qemu guest agent is configured in the domain XML; used by `getVMStats` to gate `InterfaceAddresses` / `GetHostname` calls
- `getCachedStateCode(name)` — reads the libvirt state code from the cached list; used by `getVMStats` to fast-path non-running VMs to a zero-DBus tick
- `getCachedDomainPath(name)` — returns the libvirt-dbus domain path captured during cache population; used by `getVMStats` to skip `DomainLookupByName` on the hot path
- `getCachedStaleBinary(name)` — reads the `staleBinary` flag from the cached list; used by `getVMStats` to avoid per-tick `/proc` syscalls
- `subscribeVMListChange(handler)` — subscribe to cache-refresh events. Used by the `/vms/stream` SSE handler to push the list to clients without a polling timer. Returns an unsubscribe function.

### vmManagerLifecycle.js

Purpose-named lifecycle functions: `startVM`, `stopVM`, `forceStopVM`, `rebootVM`, `suspendVM`, `resumeVM`. Each resolves the domain by name, gets the domain interface, and calls the appropriate DBus method.

### vmManagerProc.js

- `isVMBinaryStale(name)` — returns `true` when the VM's qemu process is using a binary that has been replaced on disk (typically after a qemu/libvirt upgrade). Reads the libvirt pidfile at `/var/run/libvirt/qemu/<name>.pid`, then checks whether `/proc/<pid>/exe` ends with ` (deleted)`. Returns `false` on any error (missing pidfile, dead pid, EACCES). Computed once per VM list cache refresh and read via `getCachedStaleBinary` from both list and stats payloads.
- `watchQemuBinaries(onChange)` — sets up `fs.watch` on directories where `qemu-system-*` binaries can live (`/usr/bin`, `/usr/local/bin`, `/usr/libexec`) and calls `onChange` whenever any matching basename changes. Used at vmManager connect to wire qemu upgrades into `fireDomainChange`, so `staleBinary` updates are event-driven (no polling). Returns a cleanup function called on disconnect.

### vmManagerCreate.js

- `createVM(spec, callbacks)` — full creation flow with template defaults
- `deleteVM(name, deleteDisks)` — destruction flow
- `cloneVM(name, newName)` — clone with disk copy and parse/mutate/build XML (no regex)
- `getWindowsFeatures()`, `getWindowsClock()`, `getLinuxFeatures()` — return fast-xml-parser-compatible objects for features and clock blocks

### vmManagerConfig.js

- `updateVMConfig(name, changes)` — partial config updates with live/offline awareness

### vmManagerDisk.js

- `attachDisk(name, slot, path, bus)` — attach a disk image to a slot
- `detachDisk(name, slot)` — detach a disk from a slot
- `resizeDiskBySlot(name, slot, sizeGB)` — resize a disk
- `updateDiskBus(name, slot, bus)` — change block disk bus (VirtIO, VirtIO SCSI, SATA, IDE); VM stopped
- `extractDiskSnippet(name, slot)` — extract disk XML for UpdateDevice calls

### vmManagerIso.js

- `attachISO(name, slot, isoPath)` — attach ISO to CDROM slot (hot-plug capable)
- `ejectISO(name, slot)` — eject ISO from CDROM slot (hot-unplug capable)

### Allowed paths for attach / create

Every host-supplied disk or ISO path (attach disk/CDROM at runtime, plus `disk.sourcePath` and `cdrom1Path`/`cdrom2Path` at create time) is asserted to resolve under either the image library (`imagePath`) or this VM's own per-VM directory (`getVMBasePath(name)`). Paths outside those roots return **422 PATH_NOT_ALLOWED**. The check uses `path.resolve` to canonicalize before comparing — `..` traversal is rejected. libvirt would otherwise happily open arbitrary host files (e.g. `/etc/shadow`) as block / CDROM devices for QEMU.

### vmManagerUsb.js

- `getVMUSBDevices(name)` — list USB devices attached to a VM
- `attachUSBDevice(name, vendorId, productId)` — attach (hot-plug when running)
- `detachUSBDevice(name, vendorId, productId)` — detach (hot-unplug when running)

### vmManagerSnapshots.js

- `listSnapshots(name)` — list all snapshots with metadata
- `createSnapshot(name, snapName)` — create (live with external memory, offline otherwise)
- `revertSnapshot(name, snapName)` — revert to a named snapshot
- `deleteSnapshot(name, snapName)` — delete a named snapshot

### vmManagerBackup.js

- `createBackup(name, destPath, callbacks)` — full VM backup
- `listBackups(destinations, vmNameFilter)` — scan destinations for backups
- `restoreBackup(backupPath, newVmName)` — restore as a new VM; rewrites paths under the backed-up VM directory using `manifest.vmBasePath` (see [BACKUPS.md](BACKUPS.md))
- `deleteBackup(backupPath, allowedRoots)` — delete with safety check

### vmManagerStats.js

- `getVMStats(name)` — per-VM CPU, memory, disk I/O, net I/O, uptime
- `getVMXML(name)` — raw domain XML string
- `getVNCPort(name)` — parse VNC port from domain XML graphics element

### vmManagerCloudInit.js

- `generateCloudInit(name, config)` — generate seed ISO
- `attachCloudInitDisk(name)` — attach ISO to sde
- `detachCloudInitDisk(name)` — detach sde, delete ISO and config
- `getCloudInitConfig(name)` — read stored config
- `updateCloudInit(name, config)` — save config, regenerate ISO, attach

## DBus Object Paths

| Object Path | Interface | Purpose |
|-------------|-----------|---------|
| `/org/libvirt/QEMU` | `org.libvirt.Connect` | Domain enumeration, host info, define domain, events |
| `/org/libvirt/QEMU` | `org.freedesktop.DBus.Properties` | Read connect properties (LibVersion, etc.) |
| `/org/libvirt/domains/<uuid>` | `org.libvirt.Domain` | Per-VM lifecycle, config, stats, devices |
| `/org/libvirt/domains/<uuid>` | `org.freedesktop.DBus.Properties` | Read domain properties (autostart, etc.) |

Domain object paths follow the pattern `/org/libvirt/domains/<uuid>` where UUIDs are obtained from `ListDomains`. Per-domain proxy objects are cached in `connectionState.domainProxyCache` (path → `{ iface, props }`) so `getDomainObjAndIface(path)` skips the DBus `Introspect` round-trip on hot paths like the per-VM stats SSE. The cache is cleared on bus disconnect/error and the entry for a given path is dropped on `VIR_DOMAIN_EVENT_UNDEFINED`, so a redefined VM with the same path gets a fresh proxy. Do not stash proxy references in module-level state outside this cache.
