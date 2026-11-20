# Backlog

Deferred bugs and ideas (see `AGENTS.md`, Scope).

Entry format: a bolded title, what it is in a sentence or two, and the **revisit
trigger** — the observed condition that would make it worth building (features earn
their place). Date rulings inline: `(ruled YYYY-MM-DD: wait to see if needed.)`.
Group entries under headings as themes emerge.

**Setup's server-name answer ignores `WISP_CONFIG_PATH`.** `config.sh`, `has_server_name`
(`install-state.sh`) and the 0600 pass in `answers.sh` name `config/wisp-config.json`,
while the backend reads the file `WISP_CONFIG_PATH` names; `wisp-password` follows it
since 2026-11-20 (`wisp_config_dir`, `lib.sh`), the settings file in setup does not
(found while moving the password, 2026-11-20). No Wisp tool writes the key. **Revisit
trigger:** a host that sets `WISP_CONFIG_PATH` by hand and reinstalls.

**Sidebar: manual within-section workload ordering.** A third sort mode alongside
alphabetical and online-first; the order lives on the section assignments so it is the
single ordering shared by every consumer. **Revisit trigger:** the existing sorts
demonstrably fight a real workflow — repeatedly hunting for a workload the sort keeps
burying.

**A command's busy wait can end on a frame it didn't cause.** `sendAndAwaitTopic` and
`sendAndAwaitChange` end on the topic's (or the VM's) next frame, which may come from
another tab, a gather that started before the write, or a second frame of the same change
(found in the command-acks milestone 3 review, 2026-11-15). Two seen in review: a
reconnect's `{ kind: "all" }` landing during a VM PATCH releases it onto the config before
the save, and cloud-init's own cue for the VM releases a USB attach sent just after. The
window is narrow; closing it needs frames that name the command they answer. (The opposite
case, a wait that never ends because its frame never comes, is bounded since 2026-11-16: a
wait ends after 30 s.) **Revisit trigger:** a control seen re-enabled on stale state.

**A save whose values only normalise to the stored ones waits out the deadline.** A
command whose write the backend finds unchanged (e.g. a mount PATCH that only
re-normalises its fields, the `layoutUnchanged` return in `containerManagerMountCrud.js`)
writes nothing and so fires no change cue: the busy wait runs the full 30 s. The forms skip
the request when they can see nothing changed (container General, an unchanged service);
the rest needs the client to normalise like the server, or the ack to say nothing was
written (found in the command-acks milestone 4 review, 2026-11-16). **Revisit trigger:** a
user seeing a save spin for 30 s.

**Restore in place can't repair a container whose `container.json` is missing or corrupt.**
The restore route checks the container against `listContainers`, which skips a directory
without a readable `container.json`, so it answers 404; and the safety backup taken before
the swap reads that file strictly and fails. Restore as new is the only way back. Predates
command-acks (found in its milestone 4 review, 2026-11-16). **Revisit trigger:** a user
with a damaged `container.json` and a backup they can't restore over it.

**A Samba server run as a Wisp container never answers SMB.** Both
`dperson/samba` and `ghcr.io/servercontainers/samba` (run as root) accept the TCP
connection and the negotiate, then never reply, from the host and from the LAN alike; a
lower open-files limit didn't change it. Cause unknown (capabilities, seccomp, the
container's DNS?). Found while building a test share in the command-acks milestone 5 run,
2026-11-16. **Revisit trigger:** a user running a file server in a container.

**Job-based host commands go idle before the re-read their cue started lands.** The
host mount delete and unmount and the bridge delete (`HostStorage.jsx`,
`HostNetworkBridges.jsx`) end their busy state when `awaitJob` resolves, but the list
re-read that their `host-mounts` or `network-bridges` cue started may still be in
flight: for one GET's latency the old row's button is clickable again, and a click
answers 409 or 404. Closing it means waiting for the cue's re-read as well as the job
(found in the command-acks milestone 5 review, 2026-11-16). **Revisit trigger:** a user
seeing that 409 or 404 after a delete or unmount.

**A VM deleted elsewhere leaves its open tab on an endless spinner.** When another tab or
an MCP agent deletes the VM a tab has open, the list's auto-deselect nulls the config, and
the tab stays on `/vm/<name>` with the loading spinner: nothing navigates away or says the
VM is gone. Predates command-acks (found in its milestone 3 review, 2026-11-16).
**Revisit trigger:** the next work on the VM detail page, or a user left on a spinner after
a delete.

**The VM General section renders the list seed while the config loads.** On the VM
detail page `GeneralSection` sits outside the `configLoading` skeleton (`OverviewPanel.jsx`),
so until the select's `getVM` lands it shows the list item as the config: Local DNS and
Auto Start read as off whatever they are. Predates command-acks (found in its milestone 3
review, 2026-11-16). **Revisit trigger:** the next work on the VM detail page, or a user
seeing those toggles flip on load.

**A stale `vms` frame can undo a same-tab VM rename.** After a rename, the renaming tab
follows it at once (`followRename`, then `navigate`, in `OverviewPanel.jsx`). A `vms`
frame whose list was computed before libvirt's rename, arriving after that, shows the old
name and not the new, and `migrateSelectionIfRenamed` follows the uuid back to the old name;
the user lands on "not found" for a VM that exists under the new one. It needs a server
list refresh that spans the rename: plausible, rare (found in the command-acks milestone 3
review, 2026-11-16). **Revisit trigger:** a rename seen to land on "not found".

**A VM rename navigates even after the user moved on.** `handleSectionSave` in
`OverviewPanel.jsx` navigates to the renamed VM once the save resolves, even if the user
opened another VM while it ran. Predates command-acks (found in its milestone 3 review,
2026-11-16). **Revisit trigger:** a user pulled back to a VM they had left.

**A late USB hot-unplug is never re-read.** `DetachDevice` on a running VM can return
before the guest releases the device; `GET /usb` then still lists it, and nothing listens
for libvirt's `DeviceRemoved` to send a second `vm` frame. **Revisit trigger:** a detached
USB device seen still listed until a reload.

**A disk bus change off VirtIO always fails.** `updateDiskBus` rewrites `<target bus>` but
keeps the disk's `<address type='pci'>`, so libvirt refuses SATA, SCSI or IDE with
"Invalid address type 'pci' for the disk … with the bus type 'sata'" (500). Seen on tini
in the command-acks milestone 3 check (2026-11-16). The other direction likely fails the
same way with a `drive` address. **Revisit trigger:** fix with the next disk work, or as
soon as a user needs a non-VirtIO bus.

**Two tabs can exhaust HTTP/1.1's six connections.** Chrome's cap is per origin and
shared by every tab: each tab holds `/api/events`, and a detail page or Host Mgmt adds
its scoped streams (stats, logs, disks, USB, job progress), so two such tabs can reach
six and queue every further request until a stream closes. Seen once during the
command-acks milestone 1 check (2026-11-15): a GET queued 15–30 s in the second tab right
after a navigation in the first. Confirmed on tini (2026-11-16): two tabs on one VM's
detail page (each holds `/api/events`, the VM's stats and the host USB stream) left the
second tab's USB section on "Loading USB devices…". ARCHITECTURE § Transport counts on the
scoped streams staying few enough. Behind an HTTP/2 proxy it can't happen. **Revisit
trigger:** a request seen stalled in DevTools ("Stalled"/"Queueing") with two tabs open
over plain HTTP.

**Split CONTAINERS.md and UI.md by area.** Like API.md (split 2026-11-15), both are large
enough that an agent reading one for a single area loads all of it: `specs/CONTAINERS.md`
is about 129 KB, `specs/UI.md` about 78 KB. Shape: a shared core file plus one file per
area, content moved unchanged, links fixed across the docs. **Revisit trigger:** the next
feature that works in either spec.

**A hung CIFS mount blocks Node's filesystem calls.** Listings, deletes and copies on an
unresponsive SMB destination block the libuv thread pool and can't be timed out; running
them as jobs contains the damage but doesn't fix it. The container mount-usage walk is one
such caller: its 20 s budget answers the page, but a walk stuck in `lstat` on a dead
hard-mounted source keeps one of libuv's 4 threads, so about 4 such page visits stall all
file access, login password hashing included. Likely fix there: skip sizing a storage mount
that isn't mounted, or run one walk per mount at a time. **Revisit trigger:** Wisp is seen
stalled by an unresponsive SMB share.

**Deleting a workload's last backup leaves its folder.** The empty
`backups/containers/<name>/` or `backups/vms/<name>/` stays after its last timestamp
directory is deleted (seen on tini, for VMs too on 2026-11-18). Harmless, but it piles
up. **Revisit trigger:** backup listings or cleanup start tripping over empty folders.

**VM restore as new shows no progress.** The restore job reports only its end:
`restoreBackup` takes no progress callback, so the tray shows no percent while a large disk
is copied back. **Revisit trigger:** a slow restore looks stuck to a user.

**Watchdogs fire up to 15 s late.** `createStallWatchdog` checks every
`min(15 s, stallMs / 4)`, so a 60 s or 90 s bound fires up to 15 s after it is reached.
**Revisit trigger:** a bound's precision starts to matter (a caller's bound that must end
inside another's).

**Live VM memory growth (balloon headroom / virtio-mem).** Wisp pins `<memory>` equal to
`<currentMemory>`, so a running VM's RAM ceiling is its boot-time size and every increase
costs a stop/start. Writing `<maxMemory>` above `<currentMemory>` and driving the virtio
balloon (or virtio-mem) live would allow growth without restart. Semantics to design: how
much headroom to define, guest cooperation, and what the Overview shows. Trigger observed
2026-08-26: the play VM (4 GiB) OOM-killed a working agent session and the RAM bump
required restarting everything inside. **Revisit trigger:** it happens again, or a memory
bump needs to land on a VM that can't be restarted.

**Optional SSO on Caddy hosts (Pocket ID).** Per-host auth toggle on the Caddy app's
reverse-proxy records. Explored 2026-08-28/29, settled shape: a forward-auth gateway as a
new wisp app container + `hosts[].sso` flag whose Caddyfile emission adds `forward_auth
<gateway> { uri ... }` in the host's handle block (no Caddy image change — forward_auth is
core Caddy; caddy-security in the custom image was considered and rejected: front-door
blast radius, config surface, Pocket ID friction reports). Gateway choice is the open
decision: **Tinyauth** (per-app group rules referencing Pocket ID groups via the `groups`
claim — authz membership stays in Pocket ID; but NO bearer-token support, so machine
clients need per-app API keys + per-host "SSO bypass paths" emitted as Caddy matchers) vs
**oauth2-proxy** (`--skip-jwt-bearer-tokens` validates Pocket ID JWT access tokens for
non-interactive clients; clunkier config, weaker per-app groups). Pocket ID admin-API
client provisioning is optional sugar — one client total in the forward-auth model. Wisp
wrinkles noted: TINYAUTH_AUTH_TRUSTEDPROXIES wants Caddy's (DHCP) IP; `hosts` is
agent-writable via MCP so the sso flag needs the human-only treatment.
**Revisit trigger:** the user schedules the auth session.

**VM backups include vTPM (swtpm) state.** Backups copy disks, NVRAM and cloud-init but
not `/var/lib/libvirt/swtpm/<uuid>/` (root-owned, keyed by UUID), so restore-as-new boots
with an empty TPM; the gap is documented in `docs/specs/BACKUPS.md` § Not backed up (audit
2026-10-16, V18). Shape: a privileged helper (registered in `install-helpers.sh` + sudoers
per DEPLOYMENT.md) that copies the state dir into the backup and back under the restored
VM's UUID. **Revisit trigger:** a restored Windows VM needed BitLocker recovery.

**Per-container seccomp opt-out.** Every container runs under Docker's default seccomp
profile (CONTAINERS.md § OCI Runtime Spec). An opt-out would be a `container.json` field
(e.g. `seccomp: "unconfined"`, no UI, editable via PATCH/MCP) read at the single place
`buildOCISpec` sets `linux.seccomp` — omit the block when set. **Revisit trigger:** an
image the user needs fails with EPERM/ENOSYS on a syscall the default profile blocks (and
a capability grant or image setting can't fix it).

**Stuck-probe recovery misses removals outside Wisp.** The avahi 0.8 probe-counter leak
(CONTAINERS.md § Stuck-probe recovery) is recovered only after Wisp's own interface
removals. Observed 2026-10-21: unattended-upgrades (liblzma5) had needrestart restart
avahi-daemon and systemd-networkd in the same second; `reregisterAll` committed every
group, networkd re-applied `br0`'s addresses (avahi: "br0.IPv4 no longer relevant", then
re-added) while they probed, and every Wisp name stopped resolving on the LAN for ~14 h —
`git` to `cala.local` failed — until a cala restart's netns removal re-published them.
Caddy and container lookups were unaffected (the forwarder answers from Wisp's own table).
An avahi restart alone does not reproduce it. Candidate fixes: (1) reinstate the
per-Commit deadline (a group still `REGISTERING` ~10 s after Commit is re-committed) and
drop the per-removal triggers it makes redundant — reverses the 2026-10-16 rejection, but
a stuck group emits no signal to wait on; (2) re-publish on systemd-networkd link/address
change signals — event-driven, covers only networkd flaps, races avahi's own netlink
handling; (3) defer `reregisterAll` until avahi's Server reaches RUNNING — avoids this
exact ordering only by luck. Confirm first with `systemctl restart avahi-daemon
systemd-networkd`. **Revisit trigger:** Wisp `.local` names go dead on the LAN again,
especially after an unattended-upgrades run.

**Adopt kept VM disks at create.** *Delete VM, keep disks* leaves `vms/<name>/`, and
create/restore refuse that name (409 `VM_DIR_EXISTS`, settled 2026-10-16); reusing a kept
disk means moving it into the image library by hand and picking it as an existing disk.
Shape: the create form offers the kept `disk*.qcow2` of a blocked name.
**Revisit trigger:** reusing kept disks through the shell becomes a recurring chore.

**ISO attach/eject on a paused VM is config-only.** It lands in the inactive definition
without touching the paused QEMU. **Revisit trigger:** a CD-ROM change on a paused VM is
reported as "didn't apply".

**VM restart-flag clear can revert a concurrent define.** `writePendingRestart`
(`vmManagerPendingRestart.js`) reads the inactive XML and calls `DomainDefineXML` with no
per-VM lock, so a config, disk or ISO define landing in between is reverted. It now runs
only on libvirt connect and the STARTED event (review of repairs-to-migrations,
2026-11-12). Fix shape: vmManager takes a lock acquirer, as containerManager does.
**Revisit trigger:** a VM edit made right as the VM starts is seen lost.

**App containers: devices bypass appConfig.** `PATCH {devices}` and the Devices section
work on app containers, but Jellyfin's next `appConfig` save replaces them with its derived
devices. **Revisit trigger:** a manual device pick on an app container is lost on a config
save.

**Helper hardening leftovers.** `/mnt/wisp` is deploy-writable (0775), so `wisp-mount`'s
realpath + symlink checks can't fully close a race by the deploy user; `wisp-cni` only
checks that the netns argument is absolute (it could name the host's netns and disrupt
host networking). Both need the deploy user, which is root-equivalent anyway (UPDATES.md §
Privilege model). **Revisit trigger:** the deploy user is separated from root (e.g. signed
updates staged by a root-owned path).

**Hardware temperature reads may wake disks.** Host stats read hwmon every 5 s; with
`drivetemp` loaded a SATA disk's sensor read can keep it from standby, which SMART reads
now respect (`-n standby`). **Revisit trigger:** disks on a host with `drivetemp` never
reach standby.

**Cloud-init: no way to remove a password in the UI.** A blank password field on edit
keeps the stored one (settled 2026-11-12), so the only way to drop a password is deleting
the VM's cloud-init config. **Revisit trigger:** a password needs removing without
wiping cloud-init.

**One rule for a container's "restart required".** Three places decide it differently:
`updateContainerConfig` flags a mounts/devices change, the row mount `PATCH` has its own
`layoutUnchanged` test, and the app save path ORs its mount signature with the app
module's hook (found 2026-11-12). **Revisit trigger:** the response and the badge are
seen disagreeing again, or the next change to any of the three.

**Found on tini in milestone 3's run (2026-11-20), outside this feature.** A VM created
through the API with its firmware left at the default (`bios`) from the Ubuntu 26.04 cloud
image never boots (dracut emergency shell), while the UI's defaults (`uefi`) do; a `PATCH
{"firmware":"uefi"}` on such a VM answers 500 `LIBVIRT_ERROR` "UEFI requires ACPI". And a
backup that fails inside its run on a tool error (tar exit 2) records `INTERNAL_ERROR`, not
a backup code: the managers' backup paths leave such failures uncoded (phase 5's
containerManager work). **Revisit trigger:** the next work on VM create defaults or
firmware edits, or a client that branches on a backup failure's code.

**Container sections take no busy reason.** While a job holds a container, its header
actions are disabled with the job's title as the reason, but its sections (mounts, env,
services, devices) keep their Save enabled and meet a 409 `CONTAINER_BUSY` instead; the VM
page's sections take the reason (found 2026-11-20, in milestone 2's fixes). **Revisit
trigger:** the next work on the container detail sections, or a user meeting that 409.

**A self-update whose backend never comes back waits for ever.** Once the install job
reports `restarting`, the page waits for its stream to end in `JOB_GONE` after the
restart; a backend that never returns leaves the wait unsettled, so the "stuck" note
never shows (existing behaviour, noted 2026-11-20). **Revisit trigger:** an update seen
hanging on the page.

**A run log that cannot be read answers `CONTAINERD_ERROR`.** containerManager's log
reads (`containerManagerLogs.js`, four sites) code a file read failure on the run log
(`EACCES`, `EIO`) as `CONTAINERD_ERROR`, a containerd fault it is not (seen on tini,
2026-11-20, through MCP `get_container_logs` and the logs stream). The run-log download
route lets the same failure through uncoded, as `INTERNAL_ERROR`: one failure, two codes.
**Revisit trigger:** phase 5's work on containerManager, or a client that branches on it.

**Specs that disagree with the code, found in the error sweep.** Three statements in the
specs no longer match what the routes do (found 2026-11-20, while naming each error's
code): API-VMS says a VLAN on a bridge NIC is refused with 422, but no VM code refuses it
(create keeps `vlan`, PATCH strips it); API-HOST says `POST /api/host/mounts/:id/mount`
answers 422 for a disk mount, but the route mounts disks; CONTAINERS.md says Stop and
Kill answer 200 `{ ok, restartCancelled }`, while API-CONTAINERS has Stop as a 202 job
and Kill as 204. Each needs the code or the spec settled with the user. **Revisit
trigger:** the next work on VM NICs, host mounts or container lifecycle.

**Help icons rely on `title`.** `HelpIcon.jsx` shows its text only as a `title` tooltip,
which never appears on touch (found in the 2026-11-12 rules audit). **Revisit trigger:**
help text is needed on a phone or tablet.

**A timed-out avahi registration is never retried.** With the 5 s bound on avahi calls
(settled 2026-11-12), a registration that times out leaves its entry unpublished;
`reregisterAll` runs only when the daemon restarts, not when a hung one recovers, so a
container stays unpublished until its next address change, a local DNS toggle or a
restart (VMs recover on the 60 s probe). **Revisit trigger:** a workload is seen
unpublished after avahi stalled.

**A VM and a container of the same name share one mDNS entry.** Both reconcilers register
and deregister under the bare workload name (`registerAddress(name, …)` in
`lib/mdns/linux/avahi.js`), so a VM `web` stopping, renamed or deleted withdraws a
container `web`'s `.local` record too, and the two would claim the same host name anyway
(found 2026-11-20, while writing the delete follow-ups). **Revisit trigger:** a VM and a
container are given the same name, or the next work on mDNS publishing.

**The 60 s container probe never reads the IPv4 address.** `discoverIpv4InNetnsOnce`
(`containerManagerNetwork.js`) passes `{ maxAttempts: 1, sleepMs: 0 }`, so
`discoverIpv4InNetns`'s deadline is "now" and its loop never runs: the probe returns null,
and an IPv4 address that changes inside a running container (a DHCP renewal handing out
another one) is never written to `container.json` or its `.local` A record. IPv6 drift is
picked up. Seen on tini 2026-11-18 (phase 7): an address swapped in a container's netns
stayed unrecorded for minutes, while an added IPv6 address was recorded within a tick.
Separately, `ipv4CidrFromProcFibTrie` found no address in that container's `fib_trie`
layout, so the probe would fall back to the `wisp-netns` helper. **Revisit trigger:** the
next work on container networking, or a container seen with a stale IPv4 address.

**A container that exits while its lock is held keeps its run open.** The exit settle
skips the run when a backup, app save, config PATCH or mount operation holds the
container's operation lock, so the run keeps `endedAt: null` (and its last line unshown)
until the next start. **Revisit trigger:** a run is seen open for a stopped container.

**The library picker lists symlinks that point outside the library.** The allowed-roots
check now rejects them (422 `PATH_NOT_ALLOWED`), but the picker still offers them.
**Revisit trigger:** a symlinked library entry is picked and refused.

**Reload failure detail may echo secrets.** `APP_RELOAD_FAILED` carries the app's error
lines verbatim to the UI and MCP; an app that prints a token in its error would surface it
(unconfirmed). **Revisit trigger:** a reload error is seen carrying a secret value.

**avahi `deny-interfaces` for `veth*` / `vnet*`.** Avahi publishes the host name on every
container veth and VM tap; the forwarder already ignores those link-local answers
(CONTAINERS.md § Local DNS, settled 2026-10-16), and stopping them at the source means
rewriting `avahi-daemon.conf` in place (no drop-ins). **Revisit trigger:** a non-container
consumer is hurt by the per-veth records.

**`br0` floods tagged VLAN frames to every workload.** `bridge.sh` creates `br0` with
`vlan_filtering 0`, so when the uplink is a trunk the switch's 802.1Q-tagged frames reach
every VM tap and container veth. Observed 2026-10-22: the dev VM received the router's
mDNS reflections for VLANs 2, 3, 4 and 22 (its kernel drops them as `otherhost`, ~59% of
its RX frames). Any workload can add a VLAN sub-interface and join those networks — the
isolation a VLAN implies doesn't hold behind Wisp. Fix shape: `vlan_filtering 1` with the
uplink and ports on PVID 1 untagged, plus explicit memberships for VLAN bridges.
**Revisit trigger:** a VLAN must be isolated from Wisp workloads, or untrusted workloads
land on `br0`.

**OS upgrade runs inside wisp.service.** `wisp-os-update upgrade` (apt/dpkg) is a child of
the backend, so a Wisp self-update forced past the running-jobs guard (its first step
stops the service) or a backend crash can kill dpkg mid-upgrade. Fix shape: run it in its
own oneshot unit started via one fixed sudo rule (like `wisp-updater`). **Revisit
trigger:** an upgrade is ever interrupted, or OS upgrades become unattended/scheduled.
(re-review 2026-10-16, P2)

**The server display name can't be cleared from App Config.** `AppConfig.jsx` sends
`undefined` for an empty name, so the save leaves the stored name in place, though the
backend takes an empty name as "back to the default display name" (found in the
known-defects work, 2026-11-18). **Revisit trigger:** someone clears the name and it
comes back, or the next work on that form.

**macOS dev backend sometimes ignores SIGTERM.** A dev backend started with plain
`nohup node src/index.js` sometimes kept running after `kill` (seen 2026-11-12, on main's
code too); `npm run dev` under a terminal was not affected. Not investigated: possibly a
shutdown step that waits on a darwin stub. **Revisit trigger:** it gets in the way of dev
work or a script that restarts the dev backend.

**SMB shares without a password can't be mounted.** With no password in the credentials file, `mount.cifs` prompts on stdin; the helper never answers, so the mount waits until the helper's mount bound kills it (seen 2026-11-13). A guest share probably can't be mounted at all. Fix shape: pass `guest` (or an explicit empty `password=`) when no password is set. **Revisit trigger:** someone adds a guest share, or the next work on SMB mounts.

**`PATCH /api/containers/:name` has no body schema.** CODING-RULES §9 wants request
validation at the boundary; the manager validates fields piecemeal instead (found in the
2026-11-12 repairs inventory). **Revisit trigger:** a malformed PATCH body is stored, or
the next work on that route.

**Migration history in the UI.** The journal (`journalctl -u wisp-updater`) and the ledger
(`config/migrations.json`) are the only record of what an update's state migrations
changed. **Revisit trigger:** the user asks "what did the last update change?"

**No check sees the manager members a migration reads.** Migrations take the managers
from their context and read them as `ctx.vmManager.X` / `ctx.containerManager.X`
(0001–0008, sometimes through an alias), which the import check cannot follow: a
misnamed member in a new migration fails the host's update, which then rolls back
(found in the safety-net review, 2026-11-18). Fix shape: check those member reads in
`backend/migrations/` against the facades' exports. **Revisit trigger:** the next new
migration, or the next work on the checks.

**`release.sh` can stop halfway through.** Its "CHANGELOG.md missing" guard and its
"topmost section already has a release suffix" check run after the version bumps, so a
suffixed top section stops the script with five files bumped and dirty, no commit and no
tag (found in the safety-net milestone 3 review, 2026-11-18). Fix shape: both checks with
the other guards, before the bumps. **Revisit trigger:** a release cut that stops there,
or the next work on `release.sh`.

**Containers on macOS through Apple's `container` CLI.** A Darwin implementation of the
containerManager facade on Apple's `container` CLI (macOS 26+, Apple Silicon), so the
Containers tab works on a Mac: containers sit behind vmnet with no LAN IP of their own, so
LAN reach is host port publishing and `.local` names come from Bonjour (`dns-sd`) instead
of avahi; state is polled, since the CLI has no event stream; logs come from a tailer
subprocess into the existing run files. Out of scope: VMs on Darwin, device passthrough,
VLAN sub-bridges. Rejected workarounds for the LAN limit: bridged vmnet (needs Apple to
grant the `com.apple.vm.networking` entitlement, not realistic for a self-distributed
app), `pf` rules NATing vmnet onto the LAN (fragile, breaks Private Relay), and Bonjour
proxy A-records (`dns-sd -P`) pointing at the vmnet IP (registers, but other machines
can't reach it). The CLI would be the Darwin manager's one exec caller, which needs the
user's validation (CODING-RULES §7). **Revisit trigger:** the user wants Wisp to run
containers on a Mac.

**Back up Wisp's own configuration.** Wisp backs up workloads, but not its `config/`
(settings, the password hash, the migration ledger; `PRODUCTION.md`, Backups): a host
whose install is lost is set up again by hand. **Revisit trigger:** a host's configuration
is lost, or has to be rebuilt by hand.

**Containers of the same name on two hosts get the same DHCP lease.** The backend passes
the container's name as the CNI container ID (`containerManagerNetwork.js`, the `ADD`
call), and the CNI `dhcp` plugin builds its DHCP client identifier from the container
ID, the network's name (`wisp-bridge` on every host) and the interface name, not from
the MAC. Two Wisp hosts on one LAN, each with a container of the same name, then
present the same identifier, and the DHCP server hands both the same address
(observed 2026-11-20: two test hosts' `np-alp` containers, different MACs, both got
`10.79.1.136`). A per-host part in the ID (the host's name or machine ID) would keep
them apart; the lease of each existing container would change once. Found while
testing setup, not caused by it. **Revisit trigger:** a second Wisp host on the same
LAN, or a container whose address clashes.

**`cni-dhcp` keeps running the old plugin binary after a CNI plugin upgrade.** The CNI step
replaces `/opt/cni/bin` but leaves `cni-dhcp.service` running: restarting it would forget
the leases of the running containers, which would then not be renewed. The old daemon
keeps working until the next reboot or restart. **Revisit trigger:** a plugin upgrade
whose DHCP daemon must run at once (a fix in `dhcp` itself).

**The default bridge for VMs and containers is the first non-VLAN-style bridge, not the
uplink's.** `getDefaultContainerParentBridge` (and through it `getDefaultBridge`) takes the
first bridge in `/sys/class/net` whose name is not VLAN-style, so a `docker0` or another
bridge can win over the one carrying the uplink, which setup's CNI conflist names. Belongs
to the networking work in phase 5. **Revisit trigger:** a host with a second bridge whose
new workloads land on it.

**VMs and containers do not get the uplink's jumbo MTU.** On a host whose uplink runs at
a jumbo MTU (9000), setup gives the bridge that MTU, so the host keeps it, but each
container's veth (the CNI bridge plugin's default) and each VM's tap join at 1500: frames
above 1500 between a workload and the LAN, or the host, do not pass. Carrying the bridge's
MTU to the CNI config and the VM's interface would. **Revisit trigger:** a workload that
needs frames above 1500.

**The container DNS stub's address and resolv path are written in setup and in the
backend apart.** Setup declares `169.254.53.53` on `wisp-dns0` and writes
`/var/lib/wisp/container-resolv.conf` (`scripts/linux/setup/container-dns-plan.sh`,
`container-dns.sh`); the backend names the same address and path on its own
(`lib/mdns/linux/forwarder.js`, `avahi.js`, `vmManager/linux/vmManagerHost.js`,
`containerManager/linux/containerManagerNetwork.js`). A change to one that misses the
other leaves containers resolving through an address nothing listens on. One home (the
backend reading setup's, or a check tying them, like `check-bounds.mjs`'s lock path)
would hold them together (found in the phase-7 setup audit, 2026-11-19). **Revisit
trigger:** the stub's address or path is to change.

**containerd's `config.toml` is edited by line.** Setup's containerd step sets the
socket's group with `sed` on the TOML (staged and written whole since 2026-11-19), and
the edit sets every `gid =` line, `[ttrpc]`'s and `[debug]`'s too, not only `[grpc]`'s.
A TOML-aware edit, or a drop-in of Wisp's own if containerd's `imports` reaches one,
would set only the socket's. **Revisit trigger:** a host whose ttrpc or debug socket
group matters, or a containerd release whose default configuration the line edit
misreads.

**The app does not say that the host cannot run VMs.** On a host without `/dev/kvm`,
which setup accepts (DEPLOYMENT.md, Supported hosts), only setup's and the installer's
last lines say so; in the app a VM start fails with libvirt's error. The backend should
report the capability (the host's API) and the UI show it where VMs are created and
started. **Revisit trigger:** the first install on a host without KVM, or a user
puzzled by a VM that will not start there.

**A VLAN bridge whose `netplan apply` fails leaves its file behind.** `wisp-bridge` (Host
Mgmt's VLAN bridges, `lib/networking/linux/managedBridges.js`) writes
`/etc/netplan/91-wisp-vlan__*.yaml` and runs `netplan apply`; when the apply fails, the
helper removes nothing, so the file stays and fails every later `netplan generate` — the
boot's, and setup's container-dns step's, which renders the container DNS stub — until
the bridge is deleted in the UI. The helper should take back its file when the apply
fails. **Revisit trigger:** a VLAN bridge create that fails at its apply.

**The installer's follower can miss the install's last lines.** The work removes its
log once the install succeeds, and the foreground follows it with `tail -f --pid`: once
in five pushes (2026-11-20) the output stopped after "Install path:", without the
"Access:" line, though the install succeeded (rc 0). The follower and the removal race;
the work could leave the log to the follower to remove, or the follower read it to its
end before the work removes it. **Revisit trigger:** an operator missing the access line,
or a closing message that matters more being lost.

**ifupdown hosts.** Setup makes the bridge only where netplan runs the network (ruled
2026-11-20: netplan only for now). A Debian server installed with Debian's own installer
runs it with ifupdown (`/etc/network/interfaces`) and is refused, with "run the uplink
with netplan" as the remedy. ifupdown is the next tool to support, ahead of
NetworkManager and plain systemd-networkd, because it is common across distributions.
**Revisit trigger:** a Debian server install refused, or a first distribution beyond
Debian and Ubuntu.
