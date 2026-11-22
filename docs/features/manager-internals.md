# Manager internals: say when it failed, and one way to do each thing

Phase 5 of `docs/reviews/2026-11-17/IMPLEMENTATION.md` (findings X-1 to X-3, V-1 to V-11,
C-1, C-3 to C-8 of that audit). The counts below were taken on `main` on 2026-11-22.

## What it is for

The code that talks to libvirt and containerd works, but it is written to keep going
when something fails, and the same job is written out in several places.

- **It answers softly when it cannot do its job.** With libvirt or containerd
  unreachable, the VM and container lists answer "none". The check that guards an image
  delete answers "nobody uses it" when it could not look. A VM delete reports success
  when it could not remove the VM's folder. A name check reads any failed lookup as
  "the name is free".
- **One dead network share stops the whole server.** While the Host page reads the size
  of a dead CIFS share, every other request waits: 181 s measured, longer on a hard
  mount.
- **Container `.local` names stay dead after the system bus restarts**, until Wisp is
  restarted.
- **A VM's definition is changed in 13 places, each written out**: read it, change it,
  write it back. One of them takes no lock and can undo another's change; 12 of them drop
  a console password set outside Wisp.
- **The same thing is written several ways**: 36 hand-written change emitters, 6 ways to
  run a privileged helper, 4 definitions of "is this VM running", 3 ways to read a
  container's config, device XML built once for create and again for an edit.

This feature gives each of those one home, and makes the managers say when they failed.

## Decisions

### A manager does its job or says it could not (settled 2026-11-22)

- **A list that could not be read is an error**, not an empty list: the page shows that
  libvirt or containerd cannot be reached, with a Retry, instead of "no VMs".
- **A check that guards a delete fails closed.** When Wisp cannot tell whether an image
  or a mount is in use, the delete is refused with that reason.
- **"Is this name free" fails when the lookup failed**, for VMs as it already does for
  containers.
- **A delete says what it could not remove.** A VM or container delete that left
  something behind ends as a failure naming it.
- **Live figures may be missing, never invented.** A stats read that failed shows no
  figure, not zeros.
- **A failure that is caught is logged.** The 34 silent catches in the host code log, or
  reach the caller.

### The server never waits on a mount

- The Host page lists local storage only: a network share's size is not read (changed
  by the user on 2026-11-22, after the first build showed that a size read stuck on a
  dead share cannot be ended and holds Wisp's exit). So no request waits on a share
  that stopped answering.
- The mDNS connection reopens its bus when the bus goes away, and registers the
  containers' names again.

### One way to change a VM's definition

- **One helper** reads the saved definition, applies a change and writes it back. It
  takes the VM's lock, keeps secrets set outside Wisp, and leaves a transient domain
  transient. The 13 places use it.
- **One answer to "is it running" and one to "is it shut off"**, used everywhere.
- **Device XML is built once**, used by create and by an edit.
- **The firmware, the machine type and a disk's bus are set when the VM is created and
  not changed afterwards** (settled 2026-11-22). Expert settings shows them. This removes the code that changes firmware on
  an existing VM, which today turns "UEFI" into "UEFI with Secure Boot" and leaves a
  variables file behind, and the disk bus change, which fails off VirtIO.
- **Code that reads older shapes goes**, by the ruling of 2026-11-21: the older backup
  layouts, and the repair for a rename bug fixed long ago.

### One way for the rest

- **Containers**: one read of a container's config; the 925-line create file split into
  pull, create, start and delete, which removes the three import-cycle exceptions; one
  rule for "restart required"; the unused leases client and the figures that are always
  zero go.
- **Container networking keeps one path per step.** Where the test host shows the first
  way always works (the helpers installed, the network file present), the fallbacks
  behind it go, one at a time.
- **Shared homes**: one change emitter, one way to run a privileged helper, one logger
  convention with no `console` left; the two mount files share their common code.

## Behaviour changes

- With libvirt or containerd down, the sidebar and the pages say so instead of showing
  no workloads.
- An image or a mount cannot be deleted while Wisp cannot tell whether it is in use.
- A delete that left something behind is reported as failed.
- A dead network share no longer freezes the app.
- A container's `.local` name comes back by itself after the system bus restarts.
- Firmware, machine type and disk bus are no longer editable on an existing VM.
- A backup in one of the older layouts cannot be restored (the ruling of 2026-11-21).

## Constraints

- No new dependency.
- Nothing changes on the wire except the answers named above (an error where an empty
  list was, a refusal where a delete went through).
- Every step is run on the test host. What can break a host (stopping libvirt,
  containerd or the system bus, a dead share) runs in a nested throwaway VM, never on
  the test host itself.
- The method of the redesign: the builder sends its open points before each milestone,
  builds, and each milestone gets one review for defects a user would hit. The design
  session writes the specs.

## Milestones

### 1. A manager says when it failed

- With libvirt stopped in the nested VM, the VM list and a VM's page show that libvirt
  cannot be reached, with a Retry that works once it is back. The same for containerd.
- With the manager down, deleting a library image and removing a storage mount are
  refused with the reason.
- Creating or renaming to a name while the lookup fails is refused, not allowed.
- A VM delete whose folder cannot be removed ends as a failure naming the folder.
- A failed SMART read shows in the journal.

### 2. The server never waits on a mount; mDNS comes back

- With a dead CIFS share in the nested VM, the Host page and every other page answer
  within their usual time, and Wisp stops at once when asked.
- After the system bus restarts in the nested VM, a running container's `.local` name
  resolves again within a minute, without restarting Wisp.

### 3. One way to change a VM's definition

- The count of read-change-write sites outside the helper is zero.
- Every edit still works on the test host: size, disks, CD, adapters, USB, Expert
  settings, rename, the start-up switch; the definition after each is as before.
- A console password set with `virsh` survives an edit; a domain started with
  `virsh create` is not made permanent by Wisp.
- A VM is created with each profile and its definition is unchanged from today's.
- A backup and restore of a UEFI VM works; a backup in an older layout is refused.

### 4. Containers

- One read of `container.json` is left, and the cycle-exception list is empty.
- On the test host: create with a pull, start, stop, restart after a kill, autostart at
  Wisp's start, rename, backup, restore, delete; each as before.
- Each fallback removed from the network path is named with what was observed on the
  test host to show its first way always works.

### 5. Shared homes

- One change emitter, one helper runner, no `console` call left in the backend; the
  counts are zero outside their homes.
- Each privileged helper is run once on the test host through the one runner (the power
  and bridge helpers in the nested VM).

## Not in this feature

- The privileged helpers' own scripts and the updater: the feature after this one.
- A VM rename rebuilding its first boot setup, vTPM in backups, adopting kept disks:
  backlog.
