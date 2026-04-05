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

1. Copy all disk images using `cp --reflink=auto` (CoW on supported filesystems) or `copyFile`
2. Read the original domain XML, parse with `parseDomainRaw`
3. Mutate the domain object: new name, remove uuid, update disk source paths and interface MACs
4. Serialize with `buildXml(parsed)` and define with `Connect.DomainDefineXML`

## Deletion

1. Force-stop the VM if it is running
2. Delete all snapshots
3. Undefine the domain via `Domain.Undefine(0)`
4. Remove cloud-init ISO and config files
5. If `deleteDisks=true`: remove disk images and the entire VM directory

## VM Configuration

### Reading config

`getVMConfig(name)` resolves the domain via DBus, reads its XML with `GetXMLDesc(0)`, and parses it into a structured object containing: name, uuid, state, vcpus, memoryMiB, disks, nics, firmware, machineType, cpuMode, videoDriver, graphicsType, bootOrder, bootMenu, memBalloon, guestAgent, vtpm, virtioRng, nestedVirt, osCategory, osVariant, autostart, iconId, and `localDns`. Each file-backed **disk** (`device: disk`) entry may include **`sizeGiB`** (virtual size via `qemu-img info` when the image is readable).

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

The backend writes and reads children with the `wisp:` prefix (`wisp:icon`, `wisp:localDns`) to match what libvirt returns after its own XML round-trip. `DomainDefineXML` writes to the **inactive** (persistent) config, while `GetXMLDesc(0)` returns the **active** (live) XML for running VMs — which does not reflect metadata changes until restart. To avoid stale reads, VM listing reads the inactive XML, and the detail view reads wisp prefs from the inactive XML while using the active XML for runtime fields (VNC port, etc.).

For upgrade safety, VMs without `localDns` metadata are treated as `false` (off). New VMs default to `true`.

## Local DNS (mDNS)

VMs can be registered on the local network via mDNS (`.local`) using avahi-daemon.

- Controlled by VM metadata `wisp:prefs.localDns`
- Name source: guest hostname from QEMU guest agent (`GetHostname`) when available; fallback to sanitized VM name
- Address source: guest primary IP from guest agent interface addresses
- Registration is attempted from the VM stats path when the VM is active and guest IP is available
- Registration is removed when VM stats become inactive or `localDns` is toggled off
- UI: Advanced section has a **Local DNS** toggle; VM stats bar shows the registered `.local` hostname when active

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
- DomainEvent signal listener for state change tracking and VM list cache refresh

### macOS: `backend/src/lib/darwin/vmManager/index.js`

- No DBus; `connect()` logs a dev-mode warning; VM APIs throw `NO_CONNECTION` or return empty lists where appropriate (same behavior as the former `IS_DARWIN` branches).

### `vmManagerXml.js` (under `linux/vmManager/`)

XML parsing and building utilities using fast-xml-parser. Handles the conversion between libvirt XML and the structured config objects used by the rest of the application.

### `vmManagerHost.js` (under `linux/vmManager/`)

- Host info (hostname, versions, uptime, kernel, primary IP)
- Host hardware (CPU cores, total memory)
- Running VM allocations (total vCPUs and memory across active domains)
- Network bridge enumeration
- UEFI firmware path discovery
- USB device listing via sysfs (`usbMonitor.js`; see [USB.md](USB.md))

### vmManagerList.js

- **VM list cache** — in-memory cache of the VM list, populated on connect and refreshed automatically on any `DomainEvent` signal (defined, undefined, started, stopped, suspended, resumed). `listVMs()` returns the cache when populated, avoiding per-call libvirt queries. The cache is invalidated on disconnect or bus error.
- `listVMs()` — returns cached VM list (sub-millisecond); falls back to a live libvirt query on first call before cache populates
- `getVMConfig(name)` — full VM configuration parsed from XML
- `getCachedLocalDns(name)` — reads the `localDns` flag for a VM from the cached list; used by `getVMStats` to avoid an extra inactive XML fetch per stats cycle

### vmManagerLifecycle.js

Purpose-named lifecycle functions: `startVM`, `stopVM`, `forceStopVM`, `rebootVM`, `suspendVM`, `resumeVM`. Each resolves the domain by name, gets the domain interface, and calls the appropriate DBus method.

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

Domain object paths follow the pattern `/org/libvirt/domains/<uuid>` where UUIDs are obtained from `ListDomains`. Always obtain a fresh proxy object for each operation — do not cache proxy references across reconnects.
