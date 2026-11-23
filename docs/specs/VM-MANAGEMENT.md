# VM Management

This document covers the core VM lifecycle, creation, configuration and the conventions of a VM's definition.

## VM Lifecycle

### States

| State | Code | Description |
|-------|------|-------------|
| nostate | 0 | No state reported (libvirt reports `shutoff` for an inactive domain, so this is not "stopped") |
| running | 1 | VM is actively executing |
| idle | 2 | VM is idle (libvirt internal) |
| paused | 3 | VM is suspended/paused |
| shutdown | 4 | Shutting down (in progress) |
| shutoff | 5 | VM is stopped |
| crashed | 6 | VM has crashed |
| pmsuspended | 7 | Power-management suspended |

**Stopped means `shutoff` (5) and nothing else** (settled 2026-10-16). Every operation that needs the VM's disks closed — disk attach / detach / resize, rename, backup — accepts only that state and answers **409 `VM_MUST_BE_OFFLINE`** otherwise; `shutdown` (4) is a guest shutdown still in progress with qemu holding the disks. Stop and Force stop use the same test for their `VM_NOT_RUNNING` answer. It is the only state question: **every other state counts as on** (settled 2026-11-22), paused, shutting down and crashed included. So a VM that is on gets a CD change applied live, counts in the host's running VM count and allocations, and has "restart required" set by an edit. Start, suspend and resume test the exact state they need (running, paused).

When a VM stops or is undefined, its per-run stats state (the previous CPU / disk / network sample and the uptime start) is cleared, so the next run's first stats tick starts from a fresh baseline.

### Operations

| Operation | Precondition | Notes |
|-----------|-------------|-------|
| Start | VM is stopped | |
| Stop (graceful) | VM is running | ACPI shutdown signal |
| Force stop | VM is running | Immediate power-off |
| Reboot | VM is running | |
| Suspend | VM is running | Pauses VM execution |
| Resume | VM is paused | |

### Not supported: snapshots, cloning, restore-in-place

*(settled 2026-10-16)* Wisp has **no VM snapshots** (create / list / revert / delete), **no VM cloning**, and **no VM restore-in-place** ([BACKUPS.md](BACKUPS.md#scope-settled-2026-10-16)): the user did not use them, and their interactions with rename, backup and the operation lock kept producing bugs. The replacements are manual:

- **Copy a VM**: back it up, then restore the backup **as a new VM**.
- **Roll a VM back**: restore the backup as a new VM, check it, then delete the old VM (and rename the new one if the name matters).

Deleting a VM still succeeds when libvirt holds snapshot metadata made outside Wisp (`virsh snapshot-create…`) — see [Deletion](#deletion) — and backups still flatten disks on a backing chain ([BACKUPS.md](BACKUPS.md#disks-on-a-backing-chain)).

## Name validation

A VM name must meet:

- length 1–128
- regex `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` — must start with a letter or digit (same shape as container names), so `.`, `..` and `.foo` are impossible and the per-VM directory `<vmsPath>/<name>/` is always a child of `vmsPath`, never `vmsPath` itself (settled 2026-10-16)
- rejects `..`, `/`, `\`
- rejects leading/trailing whitespace instead of trimming it — every caller uses the name verbatim, so a silently-trimmed validation would vouch for a different string than the one used. (UI forms trim their own input before sending.)

It is enforced in two layers:

1. At the boundary, by one schema ([ERROR-HANDLING.md → Name validation](ERROR-HANDLING.md#name-validation)) wherever a VM name arrives: every `/vms/:name/...` path, `POST /vms` and `PATCH /vms/:name` bodies, the backup routes' names, the VNC WebSocket and the MCP `get_vm` argument — before any background job is created or the manager is called. A name that breaks it answers **400** `VALIDATION_FAILED` (settled 2026-11-20).
2. Inside the manager, for create, restore as new and rename, so library callers get the same guarantee: **422** `INVALID_VM_NAME`.

A domain whose name predates the leading-alphanumeric rule (e.g. `_test`) fails the `:name` check on every route; it must be renamed outside Wisp (e.g. `virsh domrename`) to be managed again.

## VM Creation

### Profiles

A VM has a profile: what it runs (settled 2026-11-21). The server holds the profiles in
one table; a create names one, takes its settings from it, and anything the request also
sends wins.

| Profile | Firmware | Disk bus | Also set | First boot setup |
|---|---|---|---|---|
| `linux` | UEFI | VirtIO | — | Yes, for a cloud image |
| `windows-11` | UEFI with Secure Boot | SCSI | vTPM, the Windows tuning (`osType: Windows`) | No |
| `other` | UEFI | VirtIO | — | No |

Every profile: Q35, the host's CPU model, VirtIO video, VNC, boot from disk then CD then
network with the boot menu on, guest agent, memory balloon and random number device on,
one VirtIO adapter on the host's default bridge.

The VM remembers its profile ([Wisp metadata](#wisp-metadata-wispprefs)); the page shows
it. A domain Wisp neither created nor migrated has none. First boot setup is refused, at
create and afterwards, for a VM whose profile has none.

### Creation flow

- **The name must be free both in libvirt (`VM_EXISTS`) and on disk.** If `<vmsPath>/<name>/` already exists — typically left by *Delete VM, keep disks* — create is refused with **409 `VM_DIR_EXISTS`** (its detail names the directory, redacted to `<path>` like every host path). A new VM never adopts or overwrites files it did not create *(settled 2026-10-16)*. `POST /api/vms` checks this before it starts the job, so a conflict is an HTTP 409, not a job error.
- **The VM directory `<vmsPath>/<name>/` is created exclusively**: an existing path is `VM_DIR_EXISTS`, atomically, which covers a race with a concurrent create.
- **First boot setup**, when asked for, has its seed ISO and `cloud-init.json` built into the fresh directory before the domain is defined ([CLOUD-INIT.md](CLOUD-INIT.md)).
- **Disks.** For each requested block disk (`disk`, then `disk2`, skipping `type: none`), a new qcow2 is created or a library image is copied in, as `disk0.qcow2`, `disk1.qcow2` in order. If both are `none`, no block disk images are created (CD-ROM–only or network-only installs are allowed).
- **A failure after the directory is created removes it**, so a failed create leaves nothing behind and a retry starts clean.
- **Autostart**, if requested, is set after the domain is defined; a failure there is logged and does not fail the create.
- Progress is reported for each step on the job's stream.

### Disk provisioning

- **New disk:** a qcow2 of the size asked for.
- **Adding a disk to an existing VM** (settled 2026-10-16): the slot must be `sda` or `sdb` (anything else is **422 INVALID_REQUEST**), the VM must be stopped (**409 VM_MUST_BE_OFFLINE**), and the slot must be free in the persistent definition (**409 DISK_SLOT_IN_USE** — detach first). All three checks run before any file is touched. A new disk is created as the lowest-numbered `disk<N>.qcow2` that does not exist yet in the VM directory, reserved with an exclusive create, so an existing image (attached, or detached with its file kept) is never overwritten; the file name therefore need not match the slot. If creating or defining it fails, the reserved file is removed.
- **Existing image:** checked ([Untrusted images](#untrusted-images)), then copied from the image library to the VM directory and converted to qcow2. The source image is never modified.
- **Resize:** after the copy, if a target size was given. Can only grow, not shrink.

### Untrusted images

*(settled 2026-10-16)* An image's content is not trusted: a qcow2 can name a **backing file** or an **external data file** — any host file (`/etc/shadow`, `/dev/sda`) — and a vmdk descriptor names arbitrary host files as its extents. So:

- **Every `qemu-img` call names the format** (`-f`) — none lets qemu-img probe it, since probing decides by content. A VM's own disk is read as its domain `<driver type>` (none = `raw`, as libvirt reads it): disk sizes in the VM detail, resize, and the backup's backing-chain read and flatten.
- **A library or user-supplied image** (create with an existing disk, attach an existing disk) is read as the format its name gives: `.qcow2` → qcow2 (the file must start with the qcow2 magic), `.raw` → raw, `.img` → qcow2 when it starts with the qcow2 magic, raw otherwise (Ubuntu cloud images are qcow2 `.img` files; only qcow2 is ever decided by content). Any other extension — `.vmdk`, `.iso`, … — is **422 `DISK_FORMAT_UNSUPPORTED`**: convert it to qcow2 on the host (`qemu-img convert -O qcow2`).
- **Before converting, attaching or resizing**, the image is inspected, and refused with **422 `DISK_IMAGE_UNSAFE`** for a backing file or a qcow2 external data file, and with **422 `DISK_FORMAT_UNSUPPORTED`** for a format other than qcow2/raw. That covers create-from-library (before the copy; the create job fails and leaves no VM directory), attach existing, and resize — a VM disk that is an overlay (a snapshot made outside Wisp) cannot be resized through Wisp; flatten it first.
- **Attach existing** defines the disk with the format it was checked as (`<driver type='raw'>` for a raw image, `qcow2` for a qcow2).

## Renaming

A VM can be renamed when it is stopped (rename is the `name` field in `PATCH /api/vms/:name`).

- **Locks.** The rename holds the VM's [operation lock](BACKUPS.md#per-vm-operation-lock) and the new name's *(settled 2026-11-20)* for the whole rename, its follow-ups included, as a container rename does.
- **A step of its own** *(settled 2026-11-20)*: the rename, then its follow-ups (below), then the rest of the patch under the new name — a failure of the rest answers its error, while the rename and its follow-ups stand.
- **Pre-check:** VM offline; the new name passes the name rules; no other VM already uses it.
- **The source dir is `<vmsPath>/<oldName>/`.** A VM whose files sit in a directory that does not match its name is not repaired (settled 2026-11-22): its rename moves nothing and rewrites no path, and the VM keeps working from where its files are.
- **The target name is reserved** by creating `<vmsPath>/<newName>/` exclusively; an existing path is **409 `VM_DIR_EXISTS`**, atomically *(settled 2026-10-16)*. The reservation stays beside the lock: it refuses a directory that exists without a VM (a kept one).
- **Order:** libvirt renames the domain; the directory moves to the new name, replacing the empty reserved directory and bringing disks, NVRAM and cloud-init artefacts along; every `<disk><source file>`, `<os><nvram>` and `<os><loader>` value under `<vmsPath>/<oldName>/` is rewritten to the new directory and the domain redefined ([Updating config](#updating-config)). A failure at a step rolls back the steps before it.
- **A reservation nothing moved into** (libvirt refused the rename, the move failed, or the VM has no directory of its own — CD-ROM-only) is removed with `rmdir`, which never deletes files someone else put there.

Afterwards the on-disk layout, libvirt's name, and the definition's absolute paths are consistent under the new name. Backups taken before the rename keep the old path in their manifest; restore re-creates the per-VM dir under the **current** name.

**Then the follow-ups** (a container rename's less its `.local` name; settled 2026-11-20), best-effort — logged when one fails, never failing the rename: the sidebar section assignment moves from `vm:<old>` to `vm:<new>` (a stale assignment the new name kept is dropped; the move reaches clients on the `sections` topic), and the last backup attempt moves to the new name ([BACKUPS.md → Backup attempt status](BACKUPS.md#backup-attempt-status)).

### Out-of-band renames

Renames performed outside Wisp (`virsh domrename`, hand-edited domain XML, etc.) are **not** auto-reconciled: per-VM directories are untouched. If you must rename outside Wisp, run the standard Wisp rename to reconcile the on-disk layout.

## Deletion

1. Force-stop the VM if it is running. A VM that cannot be stopped is not deleted (500 `LIBVIRT_ERROR`): undefining it would leave it running with its disks removed under it. A force stop that fails because the guest finished shutting down meanwhile is a stopped VM, and the delete goes on. A definition that cannot be read fails the delete too (settled 2026-11-22).
2. Undefine the domain. Libvirt snapshot metadata made outside Wisp (`virsh snapshot-create…`) goes with it; snapshot data inside the disk images or in overlay files goes or stays with the disks per step 3. A UEFI VM's NVRAM file is removed by libvirt only with `deleteDisks=true` and the file inside this VM's own directory; in every other case it is kept: libvirt never deletes a file that may belong to another VM.
3. **`deleteDisks=true`** only: `<vmsPath>/<name>/` is removed with everything in it (disks, NVRAM, cloud-init artifacts). A folder that cannot be removed ends the delete as failed with `VM_DELETE_INCOMPLETE`, naming the folder: the VM is gone, and the job says what it left.
   **`deleteDisks=false`**: the per-VM directory is left **completely untouched**. The kept directory **blocks the name**: create and restore-as-new under that name are refused with 409 `VM_DIR_EXISTS` rather than writing into it. To reuse a kept disk, move it into the image library and pick it with the **existing disk** option at create (it is copied into the new VM's directory); to reuse the name, remove `<vmsPath>/<name>/` first.
4. **The follow-ups** (a container delete's less its `.local` name; settled 2026-11-20), once the domain is gone, with or without its disks: the VM's last backup attempt and its section assignment are removed, so neither lingers nor lands on a later VM of that name.

## VM Configuration

### Reading config

The VM list and the VM detail read the **inactive** (persistent) definition, so a saved edit shows at once on a running VM. Only runtime values, such as the VNC port, are read from the live one. The detail's shape: [API-VMS.md](API-VMS.md).

### Updating config

**One way to change a VM's definition** (settled 2026-11-22). Every change to an existing VM's saved definition goes through one path: config edits, the rename's path rewrite, disk attach and detach, a new CD slot, the CD and USB changes of a VM that is shut off, the console listen address, the restart-required flag and the migrations' metadata writes. Create and restore define a new domain and are the only other defines. That path:

- **waits its turn**: writes to one domain run one after another, in a queue keyed by the domain's path (which a rename does not change). A write never refuses for being second, a writer that fails does not hold up the next, and each define is bounded like every libvirt call (30 s);
- **reads the inactive definition** — never the live one (settled 2026-10-16): on a running VM the live definition lacks earlier pending-restart edits, so defining from it would revert them. Live state is consulted only for the on/shut off decision;
- **reads it with the secure flag**, so a console password set outside Wisp is written back, not dropped;
- **never defines a transient domain** (one started with `virsh create`, with no saved definition): defining it would make it permanent. A change it would need is refused with **409 `VM_TRANSIENT`**; a change that changes nothing is no error. The state migrations' writers skip such a domain and report it as not changed, so a transient domain never fails Wisp's start. Such a VM lists and its page loads; its definition is not Wisp's to change. A CD or USB change on a running one is refused by libvirt itself (500 `LIBVIRT_ERROR`; backlog);
- defines nothing when the change changes nothing.

Device elements (disk, CD-ROM, NIC, graphics, video, balloon, guest-agent channel, TPM, RNG, USB host device) are built in one place, used by create and by every edit, so an edit writes an element exactly as create does. Hot-plug calls on a VM that is on are not read-change-define and go to libvirt directly.

A config save applies partial changes. Nothing in it is hot-applied (ISO attach/eject and USB passthrough are the hot-plug paths, via their own endpoints). A rename is a call of its own ([Renaming](#renaming)): it uses libvirt's domain rename, on a VM that is shut off.

A save returns `{ requiresRestart: true }` when the VM is on and the redefined domain differs from the one it started from in anything but Wisp's `<metadata>` — memory, CPU, OS type, boot order and menu, NICs, video, graphics and every device toggle all count; icon and autostart don't. The test compares the serialized definition (minus `<metadata>`) before and after the patch, so a patch that re-sends current values counts only if it actually rewrites the XML. When it is true the VM's restart-required flag is set in the same define.

### Restart-required flag

`<wisp:pendingRestart>2026-10-16T10:00:00.000Z</wisp:pendingRestart>` in the VM's `wisp:prefs` (inactive XML) records **when** a change the running QEMU doesn't reflect was saved; absent means no flag. It surfaces as `pendingRestart: { since } | null` on the list and detail payloads (and MCP `get_vm`). Containers carry the same flag (`pendingRestart: { since }` in `container.json`, [CONTAINERS.md](CONTAINERS.md#config-changes-that-need-a-restart)).

**The rule** (settled 2026-10-16): a workload needs a restart iff the flag exists **and** its process has not started since `since`. The start time is the real process's — for a VM the QEMU process, read from libvirt's pidfile and `/proc` (to the whole second, so it errs toward keeping the flag).

- **Set** by a config save that needs it (above) with `since = now`, by a CD slot added to a VM that is on (in the same define), and by the manager's own setter for code that changes a definition outside a config save (state migrations): setting writes `since = now` (a later change moves it forward), clearing removes it. Setting the flag is a `<metadata>` change, so it never counts as a restart-needing change itself.
- **Reported** by every read — the VM list and the detail apply the rule and report `null` for a flag the running QEMU started after. Reads never write.
- **Cleared at the start** *(settled 2026-11-12)*: a flag the QEMU started after is dropped from the definition (conditional on it still holding that `since`), triggered by libvirt's started event for that VM and, for every VM, by each (re)connect — which catches VMs started while Wisp was not connected (host-boot autostart). Wired only with event watching, so the start's state migrations never clear a flag. No other path clears it.
- **Kept** while the VM is stopped, while the same QEMU keeps running (a guest-side reboot keeps the process, so the flag correctly stays — stop and start applies it), and when the start time can't be read: never cleared on a guess.

### Live vs. offline changes

"Running" in this table is any VM that is on (not shut off).

| Change | Running VM | Stopped VM |
|--------|-----------|------------|
| Name (rename) | Not allowed (stop VM first) | Rename via `Domain.Rename` |
| RAM | Config only (restart required) | Config only |
| CPU count | Config only (restart required) | Config only |
| Firmware, machine type, a disk's bus | Not editable: set at create (settled 2026-11-22) | Not editable |
| NIC config | Config only (restart required) | Config only |
| Graphics | Config only (restart required) | Config only |
| ISO attach/eject | Live + Config (hot-plug) | Config only |
| A new CD slot (first boot setup turned on for a VM made without it) | Config only (restart required): a SATA CD-ROM cannot be hot-plugged, and the seed is read at the next boot | Config only |
| Video driver | Config only (restart required) | Config only |
| Boot order / boot menu | Config only (restart required) | Config only |
| Toggles (balloon, agent, RNG, vTPM, nested virt) | Config only (restart required) | Config only |
| Icon | Config only (metadata, no restart) | Config only |

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

Every VM defines two SATA CDROM slots (`sdc` and `sdd`) at creation, even if empty. Attaching an ISO adds the slot's `<source file>`, ejecting removes it; the slots themselves are never removed. On a VM that is on, attach and eject apply live and to the saved definition.

### Disk slot convention

| Slot | Purpose |
|------|---------|
| `sda` | Primary boot disk |
| `sdb` | Secondary data disk (optional) |
| `sdc` | CDROM 1 — boot ISO / OS installer |
| `sdd` | CDROM 2 — secondary ISO (e.g. VirtIO drivers) |
| `sde` | Cloud-init seed ISO (when cloud-init is enabled) |

### UEFI firmware

A UEFI VM's definition names the firmware loader and its own NVRAM file, `<vmsPath>/<name>/VARS.fd`, which is copied from the system template at VM creation. UEFI with Secure Boot uses the Secure Boot firmware file.

### Windows optimizations

Windows VMs (the `windows-11` profile, or `osType: Windows` set in Expert settings) get Hyper-V enlightenments, a Windows clock configuration and a vTPM. These are applied at creation and preserved on all subsequent config updates.

### Network

Each NIC is a bridge interface with a model and a MAC. MAC addresses are generated with the `52:54:00` prefix (QEMU's locally-administered range) followed by 3 random bytes.

VM NIC VLAN tagging via `<vlan>` is not used; use a VLAN-specific bridge (for example `br0-vlan22`, created from Host → Host Mgmt → Network Bridges) instead.

### Additional devices

- **USB tablet input:** included by default, for pointer tracking in the console.
- **Graphics:** one `<graphics type='vnc|spice' port='-1' autoport='yes' listen='127.0.0.1'/>`, written by create and by a Graphics edit (which replaces the element). Localhost only *(settled 2026-10-16)*: QEMU's VNC has no password, so the only way in is Wisp's authenticated console proxy, which connects to `127.0.0.1` ([CONSOLE.md](CONSOLE.md)). A restore copies the backup's `<graphics>` as it is.

### Exact values

The definition's parser keeps every text node and attribute as the exact string libvirt wrote (settled 2026-10-16): a definition is changed and written back, so a coerced value would be rewritten on the way (a VM named `007` came back as `7`). A reader that needs a number converts it explicitly.

### Wisp metadata (`wisp:prefs`)

Wisp app-level VM metadata is stored in domain XML metadata under the `https://wisp.local/app` namespace:

- `icon` — workload icon id for the UI
- `pendingRestart` — ISO time the change awaiting a restart was saved; omitted otherwise (see [Restart-required flag](#restart-required-flag))
- `profile` — what the VM runs (`linux`, `windows-11`, `other`), written at create

Each writer sets or removes only its own children of the existing `wisp:prefs` element, so one pref never drops another. Children carry the `wisp:` prefix (`wisp:icon`, `wisp:pendingRestart`), as libvirt returns them.

## Local DNS (mDNS)

**Wisp publishes no `.local` name for a VM** *(settled 2026-11-20)*: a name published from the host fought the guest's own announcement. A VM is a full machine and announces itself: cloud-init installs `avahi-daemon` in a Linux guest by default ([CLOUD-INIT.md](CLOUD-INIT.md)), and Windows and macOS guests announce their own names. Containers keep theirs ([CONTAINERS.md → Local DNS](CONTAINERS.md#local-dns-mdns)).

- A container resolves a VM's name through the DNS forwarder as it resolves any other name on the LAN, through the host's avahi, when the guest announces it.
- A VM's stop still triggers the stuck-probe recovery that container names rely on, since its tap goes away with it ([CONTAINERS.md → Publishing](CONTAINERS.md#publishing-avahi-daemon-via-dbus), Stuck-probe recovery).

### Guest agent state

A VM's stats carry `guestAgent.connected`: whether the guest agent answered. The flag is `undefined` when the VM has no guest agent channel, and the UI then hides the pill.

## Connection and the VM list

- **Reconnect.** When the system-bus connection to libvirt fails, Wisp reconnects with exponential backoff from 2 s, doubling to a 30 s cap, one pending retry at a time, until libvirt is back; each failed attempt is logged. A failed connect at boot enters the same loop *(settled 2026-11-12)*, so VMs appear once libvirt is up, without a backend restart; until then VM operations report the missing connection. Only with event watching: the start's state migrations connect once, and a failure there is their warning.
- **The VM list is cached**, refreshed on libvirt's domain events, on every change Wisp makes to a VM, and when a `qemu-system-*` binary is replaced on disk. Any libvirt call that fails marks it stale: the next read asks libvirt again. The list tells its subscribers only when its answer changes, a list or an error (settled 2026-11-22). A domain that goes away between the listing and its own read is left out, not an error.
- **A list read returns every VM or throws** (`NO_CONNECTION`, `LIBVIRT_ERROR` with libvirt's text): a list that could not be read is never an empty list (settled 2026-11-22). For the start's state migrations there is no cache: every call queries libvirt, and returns every VM or throws ([UPDATES.md → Runner](UPDATES.md#runner)).
- **A stopped libvirtd is noticed while a tab is open**: each host stats tick asks libvirt one cheap question, and a failure marks the list stale ([HOST-MONITORING.md](HOST-MONITORING.md)).
- **A write to a VM's definition or devices** (config, disks, CD-ROM, USB, graphics, the restart flag) is announced as `changes { kind: "vm", id }` ([API.md](API.md)).

### Allowed paths for attach / create

Every host-supplied disk or ISO path (attach disk/CDROM at runtime, plus `disk.sourcePath` and `cdrom1Path`/`cdrom2Path` at create time) must resolve under either the image library (`imagePath`) or this VM's own per-VM directory. Paths outside those roots return **422 PATH_NOT_ALLOWED**: libvirt would otherwise open arbitrary host files (e.g. `/etc/shadow`) as block / CDROM devices for QEMU. The check follows symlinks as QEMU's open will *(settled 2026-11-12)*: the path is resolved — asynchronously, so a stale network mount can't freeze the backend — with the kernel's `realpath` (its deepest existing ancestor, plus the not-yet-created rest), and so are the two roots (`vmsPath` may itself be a symlink) — a symlink in the image library that points outside it, and `..` traversal, are rejected.

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) Every libvirt DBus call, the connect setup and introspection included, gives up after **30 s**; the lifecycle calls (Create, Shutdown, Destroy, Reboot, Undefine, Suspend, Resume) after **2 min**. A call past its bound fails with `LIBVIRT_ERROR`; libvirt still runs it if it answers late. A failed connect retries on the reconnect backoff. The NVRAM copy: **60 s**. `qemu-img create` and the cloud-init seed ISO build: **20 s** each (settled 2026-11-13).

Start, force-stop, delete and restore as a new VM run as server jobs (settled 2026-11-13): a lifecycle call's 2 min outlasts a short request. Stop, reboot, suspend and resume stay synchronous.
