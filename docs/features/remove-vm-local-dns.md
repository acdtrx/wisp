# Wisp no longer publishes a `.local` name for a VM

Proposed by the user on 2026-11-20, while phase 3 was settling whether a VM's `.local`
name is the VM's name or the guest's hostname.

## What it is for

A VM is a full machine and announces itself. Cloud-init installs `avahi-daemon` in the
guest by default, and Windows and macOS guests announce their own names. Wisp publishing
a name for the same machine from the host fights with the guest's own announcement: the
user had to turn Wisp's off each time to use avahi in the guest, and rarely needed it
otherwise. It also needs the guest agent for the name and the address, a reconciler, and
a periodic probe. So the feature goes.

Containers keep theirs: a container has no daemon of its own to announce it, so the host
is the only place its name can come from.

## Decisions

- **Wisp publishes no `.local` name for a VM.** The guest announces itself. Nothing is
  kept "off by default": the setting, its toggle and the code behind it go.
- **Gone**: the VM's Local DNS setting (in the VM's General section and in the create
  panel), the `.local` name shown in the VM's stats bar, the `localDns` field of the VM
  API and of MCP's VM answers, the reconciler that published VM names, and whatever in
  the VM manager existed only to feed it. The builder lists what else used the VM
  manager's network-change events, and keeps only that.
- **A request that still sends `localDns` for a VM** is refused like any unknown key.
- **A VM that had the setting on** simply stops being published at the update. Its stored
  preference is ignored and no longer written; the builder says whether anything needs
  removing from stored VM definitions for a clean read.
- **Containers are unchanged**: their names are published as now, and follow a rename
  and a delete.
- **The container DNS forwarder** resolves a VM's name as it resolves any other name on
  the LAN, through the host's avahi, when the guest announces it.
- **Kept, wherever it then lives**: the recovery of avahi's stuck probes when a VM stops
  (avahi 0.8 loses a probe counter when an interface goes away; a stopping VM's tap is
  such an interface). Today the VM name reconciler triggers it. Container names depend
  on it.
- **Cloud-init's `installAvahiDaemon` stays**, on by default: it is now the way a Linux
  guest gets its `.local` name.

## What it changes in the docs

- `specs/VM-MANAGEMENT.md`: the Local DNS section becomes a short "not published by
  Wisp" passage with this reasoning (settled, dated), and Renaming and Deletion lose the
  `.local` follow-up. `specs/API-VMS.md`: `localDns` leaves the VM's bodies and answers.
  `specs/MCP.md`, `specs/UI.md` (the General section, the stats bar, the create panel).
- `specs/CONTAINERS.md`: where Local DNS speaks of VMs (the forwarder's answers, the
  stuck-probe trigger).
- `specs/CLOUD-INIT.md`: `installAvahiDaemon` as the way a guest announces itself.
- `ARCHITECTURE.md`, where it names the VM name reconciler.
- `BACKLOG.md`: every entry about VM `.local` names is removed ("a VM and a container
  of the same name share one mDNS entry" among them).

## Constraints

- The release's changelog says that VMs are no longer published and how a guest
  announces itself.
- Built on its own branch from `main` (phase 3 is merged).

## Milestone

### 1. No VM names from Wisp

Acceptance, on the test host with throwaway workloads:

- A VM created with cloud-init's defaults resolves by its own name from another machine
  on the LAN and from a container on the same host, with nothing of Wisp's publishing it
  (the host's avahi holds no entry group for it).
- A VM with the old setting on, carried over a deploy of this work, is no longer
  published by Wisp, and its page loads and saves.
- The VM page and the create panel have no Local DNS control. A `PATCH` of a VM with
  `localDns` answers 400 naming the key.
- A container's `.local` name resolves, still resolves after a VM on the same host is
  stopped, and follows a rename and a delete.
- A VM rename moves its sidebar section and backup status; a delete removes them.
- No file in the backend or the frontend publishes, reads or shows a VM `.local` name.
  `npm run check` passes.

## Not in this feature

- Container Local DNS, the forwarder and the stub.
- How a guest without avahi gets a name (Windows and macOS do it themselves; another
  Linux guest installs it).
