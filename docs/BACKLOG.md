# Backlog

Deferred bugs and ideas (see `AGENTS.md`, Scope).

Entry format: a bolded title, what it is in a sentence or two, and the **revisit
trigger** — the observed condition that would make it worth building (features earn
their place). Date rulings inline: `(ruled YYYY-MM-DD: wait to see if needed.)`.
Entries are grouped under headings by area.

## Install, setup, updates, helpers

**A rolled-back release's staged tree stays under `/var/lib/wisp/updates`.** After a
rollback the updater leaves the staged tree (`staging-<version>`) and the target file in
place, and only a new download of the same version clears that tree: a release that
failed and is never retried keeps its tree, a few hundred MB, for good (seen in the
privileged helpers milestone 3 runs, 2026-11-23). **Revisit trigger:** a host whose
updates folder holds more than one staged tree.

**There is no complete uninstall.** Nothing removes what an install put on a host:
`wisp.service` and `wisp-updater.service`, the `wisp-*` helpers and their sudo rules, the
container DNS stub's netplan file, the CNI plugins and `cni-dhcp.service`; and nothing
says what an uninstall keeps (`/var/lib/wisp`, the bridge). `wispctl svc uninstall`, which
removed `wisp.service` alone, is gone (privileged helpers, milestone 2, 2026-11-22).
**Revisit trigger:** a user asks to remove Wisp from a host.

**The OS update list's download size is always 0.** `wisp-os-update list` reads the size
from apt's "Need to get … of archives." line, which `apt-get -s dist-upgrade` never
prints, so `TOTAL` is 0 and `downloadBytes` with it (seen on Ubuntu 26.04 with 213
packages to upgrade, 2026-11-22, the release before this feature too). **Revisit
trigger:** the update card shows, or needs, the download size.

**Helper hardening leftover.** `/mnt/wisp` is deploy-writable (0775), so `wisp-mount`'s
realpath + symlink checks can't fully close a race by the deploy user. It needs the
deploy user, which is root-equivalent anyway (UPDATES.md § Privilege model). **Revisit
trigger:** the deploy user is separated from root (e.g. signed updates staged by a
root-owned path).

**A self-update whose backend never comes back waits for ever.** Once the install job
reports `restarting`, the page waits for its stream to end in `JOB_GONE` after the
restart; a backend that never returns leaves the wait unsettled, so the "stuck" note
never shows (existing behaviour, noted 2026-11-20). **Revisit trigger:** an update seen
hanging on the page.

**OS upgrade runs inside wisp.service.** `wisp-os-update upgrade` (apt/dpkg) is a child of
the backend, so a Wisp self-update forced past the running-jobs guard (its first step
stops the service) or a backend crash can kill dpkg mid-upgrade. Fix shape: run it in its
own oneshot unit started via one fixed sudo rule (like `wisp-updater`). **Revisit
trigger:** an upgrade is ever interrupted, or OS upgrades become unattended/scheduled.
(re-review 2026-10-16, P2)

**Migration history in the UI.** The journal (`journalctl -u wisp-updater`) and the ledger
(`config/migrations.json`) are the only record of what an update's state migrations
changed. **Revisit trigger:** the user asks "what did the last update change?"

**Back up Wisp's own configuration.** Wisp backs up workloads, but not its `config/`
(settings, the password hash, the migration ledger; `PRODUCTION.md`, Backups): a host
whose install is lost is set up again by hand. **Revisit trigger:** a host's configuration
is lost, or has to be rebuilt by hand.

**containerd's `config.toml` is edited by line.** Setup's containerd step sets the
socket's group with `sed` on the TOML (staged and written whole since 2026-11-19), and
the edit sets every `gid =` line, `[ttrpc]`'s and `[debug]`'s too, not only `[grpc]`'s.
A TOML-aware edit, or a drop-in of Wisp's own if containerd's `imports` reaches one,
would set only the socket's. **Revisit trigger:** a host whose ttrpc or debug socket
group matters, or a containerd release whose default configuration the line edit
misreads.

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

**The vendored noVNC ships twice.** The backend serves `/vendor/` from
`frontend/public/vendor`, and Vite also copies all of `public/` into `frontend/dist`, so
a release holds the same files under `frontend/dist/vendor` too (seen while the release
became a list, 2026-11-24). One home would be the backend serving `/vendor/` from the
built tree, or the build leaving `vendor/` out. **Revisit trigger:** the release's size
matters, or the two copies are found to differ.

## Networking: addresses, DHCP, mDNS, bridges

**Two containers of the same name on two Wisp hosts get the same address.** The backend
passes the container's name as the CNI container ID, and the CNI `dhcp` plugin builds its
DHCP client identity from that ID, the network's name (`wisp-bridge` on every host) and
the interface's, not from the MAC. Two Wisp hosts on one LAN, each with a container of
the same name, then present the same identity, and the DHCP server gives both the same
address, each with its own MAC (seen 2026-11-20 and 2026-11-23 on nested test hosts and
tini). A per-host part in the ID (the host's name or machine ID) would keep them apart;
the lease of each existing container would change once. **Revisit trigger:** a user with
two hosts, or a host and its backup, running a container of the same name.

**A container's DHCP lease is never released to the LAN's server.** At every CNI DEL
the `cni-dhcp` daemon logs "releasing lease", then "failed to release DHCP lease: unable
to get interface information: route ip+net: no such network interface", and no
DHCPRELEASE leaves the host: it drops the lease from its own state, and the LAN's server
keeps it until it expires. Seen on tini's journal for every container delete on
2026-11-22, the release before this feature and with it (found building the privileged
helpers, milestone 1). **Revisit trigger:** a LAN whose DHCP pool runs short of addresses
held by deleted containers.

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

**A timed-out avahi registration is never retried.** With the 5 s bound on avahi calls
(settled 2026-11-12), a registration that times out leaves its entry unpublished;
`reregisterAll` runs only when the daemon restarts, not when a hung one recovers, so a
container stays unpublished until its next address change, a local DNS toggle or a
restart. **Revisit trigger:** a workload is seen unpublished after avahi stalled.

**Cloud-init could keep a guest's avahi from renaming it `<host>-2`.** A Linux guest gets
its `.local` name from the avahi-daemon cloud-init installs (`installAvahiDaemon`, on by
default), and avahi 0.8 renames a host to `<host>-2` when an address is withdrawn while it
probes its name ([avahi#117](https://github.com/avahi/avahi/issues/117); CONTAINERS.md →
Host name conflicts on address churn). The host's setup sets `publish-aaaa-on-ipv4=no`
for it; Wisp does not configure guests, so a guest keeps the stock config and can lose its
name the same way. Cloud-init could write that line into the guest's `avahi-daemon.conf`
(found 2026-11-20, while removing VM name publishing). **Revisit trigger:** a VM seen
announcing `<name>-2.local`.

**avahi `deny-interfaces` for `veth*` / `vnet*`.** Avahi publishes the host name on every
container veth and VM tap; the forwarder already ignores those link-local answers
(CONTAINERS.md § Local DNS, settled 2026-10-16), and stopping them at the source means
rewriting `avahi-daemon.conf` in place (no drop-ins). **Revisit trigger:** a non-container
consumer is hurt by the per-veth records.

**`br0` floods tagged VLAN frames to every workload.** `br0` has VLAN filtering off (the
kernel's default, which setup's bridge keeps), so when the uplink is a trunk the switch's 802.1Q-tagged frames reach
every VM tap and container veth. Observed 2026-10-22: the dev VM received the router's
mDNS reflections for VLANs 2, 3, 4 and 22 (its kernel drops them as `otherhost`, ~59% of
its RX frames). Any workload can add a VLAN sub-interface and join those networks — the
isolation a VLAN implies doesn't hold behind Wisp. Fix shape: `vlan_filtering 1` with the
uplink and ports on PVID 1 untagged, plus explicit memberships for VLAN bridges.
**Revisit trigger:** a VLAN must be isolated from Wisp workloads, or untrusted workloads
land on `br0`.

**`cni-dhcp` keeps running the old plugin binary after a CNI plugin upgrade.** The CNI step
replaces `/opt/cni/bin` but leaves `cni-dhcp.service` running: restarting it would forget
the leases of the running containers, which would then not be renewed. The old daemon
keeps working until the next reboot or restart. **Revisit trigger:** a plugin upgrade
whose DHCP daemon must run at once (a fix in `dhcp` itself).

**The default bridge for VMs and containers is the first non-VLAN-style bridge, not the
uplink's.** `getDefaultContainerParentBridge` (and through it `getDefaultBridge`) takes the
first bridge in `/sys/class/net` whose name is not VLAN-style, so a `docker0` or another
bridge can win over the one carrying the uplink. **Revisit trigger:** a host with a second bridge whose
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

**A VLAN bridge whose `netplan apply` fails leaves its file behind.** `wisp-bridge` (Host
Mgmt's VLAN bridges, `lib/networking/linux/managedBridges.js`) writes
`/etc/netplan/91-wisp-vlan__*.yaml` and runs `netplan apply`; when the apply fails, the
helper removes nothing, so the file stays and fails every later `netplan generate` — the
boot's, and setup's container-dns step's, which renders the container DNS stub — until
the bridge is deleted in the UI. The helper should take back its file when the apply
fails. **Revisit trigger:** a VLAN bridge create that fails at its apply.

**A paused container's stats stream has no local name.** Seen on tini (2026-11-24): with
a running container's task paused (`ctr tasks pause`, outside Wisp), its stats stream
sent `mdnsHostname: null` while `ip` stayed, and the name was back on resume. Not looked
into: whether the name is withdrawn from Avahi or only missing from the stream, and
whether a backup's pause, the one pause Wisp makes itself, does the same; if both, a
container's `.local` name stops resolving for the length of each backup's archive.
**Revisit trigger:** a container's `.local` name fails to resolve during its backup, or
the next change to the container mDNS reconciler.

## VMs and first boot setup

**A VM rename does not rebuild its cloud-init seed.** The seed ISO keeps the hostname it
was built with, so a VM renamed after its cloud-init was set keeps the old name until
the seed is rebuilt; and a VM whose stored cloud-init has no hostname (one written
through the API) takes the VM's current name each time the seed is built, so an
unrelated cloud-init save renames the guest. **Revisit trigger:** a guest found named
other than its VM, or the next work on VM rename.

**A Linux VM created with BIOS firmware has no ACPI.** `vmManagerCreate.js` gives a
Linux domain `<features><acpi/></features>` only with UEFI, so one created with
`firmware: "bios"` has none: an Ubuntu 26.04 cloud image booted that way stops in early
boot and never reaches its network (found 2026-11-20 and 2026-11-21 on throwaway VMs).
UEFI is the default and firmware cannot be changed after create, so only a create that
asks for BIOS meets it. **Revisit trigger:** a user creating a Linux VM with BIOS
firmware.

**Choosing "A model like the host's" CPU always fails.** `updateVMConfig` writes
`<cpu mode='host-model' migratable='on'>`, and libvirt refuses it with LIBVIRT_ERROR
"Attribute migratable is only allowed for 'host-passthrough' / 'maximum' CPU mode". Seen
on tini, before and after phase 5's milestone 3 (2026-11-22). Fix shape: write
`migratable` for host-passthrough only. **Revisit trigger:** the next CPU work, or a user
choosing that model.

**A CD or USB change on a transient VM fails as a libvirt error.** The hot-plug paths
(`vmManagerIso.js`, `vmManagerUsb.js`) pass LIVE|CONFIG for a VM that is on, and libvirt
refuses the CONFIG half on a domain started with `virsh create`: 500 LIBVIRT_ERROR
"transient domains do not have any persistent config" (seen on tini in phase 5's
milestone 3 run, 2026-11-22). Fix shape: LIVE only when the domain is not persistent, or
refuse with VM_TRANSIENT. **Revisit trigger:** a transient VM managed through Wisp.

**A late USB hot-unplug is never re-read.** `DetachDevice` on a running VM can return
before the guest releases the device; `GET /usb` then still lists it, and nothing listens
for libvirt's `DeviceRemoved` to send a second `vm` frame. **Revisit trigger:** a detached
USB device seen still listed until a reload.

**Live VM memory growth (balloon headroom / virtio-mem).** Wisp pins `<memory>` equal to
`<currentMemory>`, so a running VM's RAM ceiling is its boot-time size and every increase
costs a stop/start. Writing `<maxMemory>` above `<currentMemory>` and driving the virtio
balloon (or virtio-mem) live would allow growth without restart. Semantics to design: how
much headroom to define, guest cooperation, and what the Overview shows. Trigger observed
2026-08-26: the play VM (4 GiB) OOM-killed a working agent session and the RAM bump
required restarting everything inside. **Revisit trigger:** it happens again, or a memory
bump needs to land on a VM that can't be restarted.

**Adopt kept VM disks at create.** *Delete VM, keep disks* leaves `vms/<name>/`, and
create/restore refuse that name (409 `VM_DIR_EXISTS`, settled 2026-10-16); reusing a kept
disk means moving it into the image library by hand and picking it as an existing disk.
Shape: the create form offers the kept `disk*.qcow2` of a blocked name.
**Revisit trigger:** reusing kept disks through the shell becomes a recurring chore.

**Cloud-init: no way to remove a password in the UI.** A blank password field on edit
keeps the stored one (settled 2026-11-12), so the only way to drop a password is deleting
the VM's cloud-init config. **Revisit trigger:** a password needs removing without
wiping cloud-init.

**The app does not say that the host cannot run VMs.** On a host without `/dev/kvm`,
which setup accepts (DEPLOYMENT.md, Supported hosts), only setup's and the installer's
last lines say so; in the app a VM start fails with libvirt's error. The backend should
report the capability (the host's API) and the UI show it where VMs are created and
started. **Revisit trigger:** the first install on a host without KVM, or a user
puzzled by a VM that will not start there.

## Containers and apps

**A Samba server run as a Wisp container never answers SMB.** Both
`dperson/samba` and `ghcr.io/servercontainers/samba` (run as root) accept the TCP
connection and the negotiate, then never reply, from the host and from the LAN alike; a
lower open-files limit didn't change it. Cause unknown (capabilities, seccomp, the
container's DNS?). Found while building a test share in the command-acks milestone 5 run,
2026-11-16. **Revisit trigger:** a user running a file server in a container.

**The image update status could carry the containers the last check flagged.** The
image library's status line reads the update status record (`lastCheckedAt`,
`imagesUpdated`); how many containers a check flagged reaches only the tab that ran the
check, from its job's result (`ImageLibrary.jsx`), so another tab, a reload or the hourly
check never shows it. Carrying `flaggedContainers` in `GET /api/containers/image-updates`
would let every view show it: a wire change (found in the frontend data flow
milestone 3 run, 2026-11-21). **Revisit trigger:** a user missing the flagged count
after a reload or a scheduled check.

**Container autostart does not run when containerd connects after Wisp started.** The
autostart pass runs once at the start; with containerd down then, it fails, and the
connect that comes later (the events stream's reconnect, phase 5 milestone 1) does not
run it. **Revisit trigger:** a host whose containerd starts after Wisp, its autostart
containers seen stopped.

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

**Per-container seccomp opt-out.** Every container runs under Docker's default seccomp
profile (CONTAINERS.md § OCI Runtime Spec). An opt-out would be a `container.json` field
(e.g. `seccomp: "unconfined"`, no UI, editable via PATCH/MCP) read at the single place
`buildOCISpec` sets `linux.seccomp` — omit the block when set. **Revisit trigger:** an
image the user needs fails with EPERM/ENOSYS on a syscall the default profile blocks (and
a capability grant or image setting can't fix it).

**App containers: devices bypass appConfig.** `PATCH {devices}` and the Devices section
work on app containers, but Jellyfin's next `appConfig` save replaces them with its derived
devices. **Revisit trigger:** a manual device pick on an app container is lost on a config
save.

**containerManager's smaller duplicates (the rest of audit C-7).** Left by phase 5's
milestone 4, which took only the wait for a stop, "is on" and the name check: the
manifest walk written twice (`containerManagerPull.js` `resolveManifest` and
`containerManagerOciSize.js`); two shapes of progress callback; files off the
`containerManager*` naming scheme; `containerError` defined twice; the darwin stub
importing from `../linux/` (docs/reviews/2026-11-17/AUDIT.md, C-7; 2026-11-22).
**Revisit trigger:** the next change to one of them.

**containerApps' duplicates (audit C-8).** Four modules alias `createAppError` as
`containerError`; `jellyfin.js` copies two validators; the backend and frontend app
registries both hold each app's label, description and default image; `applyAppConfig`
(`containerApps/index.js`) is the layer's most fragile function
(docs/reviews/2026-11-17/AUDIT.md, C-8; 2026-11-22). **Revisit trigger:** the next app,
or the next change to `applyAppConfig`.

**An unchanged app save sets "restart required" when the app has no reload command.**
`applyAppConfig` (`backend/src/lib/containerApps/index.js`) flags a running app container
whenever it has no reload command (or the env changed), even when the save changed
nothing: its mount contents are written each time and not compared with what they were
(found in phase 5, milestone 4, 2026-11-22). **Revisit trigger:** the badge seen after
re-saving an unchanged app.

**A run log that cannot be read answers `CONTAINERD_ERROR`.** containerManager's log
reads (`containerManagerLogs.js`, four sites) code a file read failure on the run log
(`EACCES`, `EIO`) as `CONTAINERD_ERROR`, a containerd fault it is not (seen on tini,
2026-11-20, through MCP `get_container_logs` and the logs stream). The run-log download
route lets the same failure through uncoded, as `INTERNAL_ERROR`: one failure, two codes.
**Revisit trigger:** the next work on container logs, or a client that branches on it.

**A container that exits while its lock is held keeps its run open.** The exit settle
skips the run when a backup, app save, config PATCH or mount operation holds the
container's operation lock, so the run keeps `endedAt: null` (and its last line unshown)
until the next start. **Revisit trigger:** a run is seen open for a stopped container.

**Reload failure detail may echo secrets.** `APP_RELOAD_FAILED` carries the app's error
lines verbatim to the UI and MCP; an app that prints a token in its error would surface it
(unconfirmed). **Revisit trigger:** a reload error is seen carrying a secret value.

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

**A container that crash-loops reads stopped with a pid.** Seen on tini (2026-11-27): a
container whose command failed at once, restarted by its policy, read `state: stopped`
with a `pid` in `GET /api/containers/:name` between two attempts, and the CLI printed
"State: stopped (pid 6141)". Not looked into: whether the pid is the exited task's, kept
until the task is deleted, or the next attempt's, set before the state. **Revisit
trigger:** the next change to the restart policy's code or to a container's state read.

## Backups

**Deleting a container's last backup leaves its empty folder.** After `DELETE
/api/container-backups` removed a container's only backup, `/var/lib/wisp/backups/containers/<name>/`
stayed, empty (seen on tini, 2026-11-25, in the host-certificate verification). **Revisit
trigger:** a listing or a retention pass that trips on an empty folder, or a user who notices
them.

**Restore in place can't repair a container whose `container.json` is missing or corrupt.**
The restore route checks the container against `listContainers`, which skips a directory
without a readable `container.json`, so it answers 404; and the safety backup taken before
the swap reads that file strictly and fails. Restore as new is the only way back. Predates
command-acks (found in its milestone 4 review, 2026-11-16). **Revisit trigger:** a user
with a damaged `container.json` and a backup they can't restore over it.

**The backups panel shows a backup's age in the browser's time zone.** A backup's
timestamp is its folder name, in UTC (`2026-07-14T03-00-05`); `backupTsToIso` in
`frontend/src/components/backups/BackupsPanel.jsx` turns it into an ISO string with no
`Z`, which the browser reads as local time, so in UTC+2 a backup made just now shows "2h
ago" in its row while the header's last attempt says "just now" (seen on tini,
2026-11-20, phase 4's milestone 1 check). **Revisit trigger:** a user reading a wrong
age, or the next work on the backups panel.

**Deleting a workload's last backup leaves its folder.** The empty
`backups/containers/<name>/` or `backups/vms/<name>/` stays after its last timestamp
directory is deleted (seen on tini, for VMs too on 2026-11-18). Harmless, but it piles
up. **Revisit trigger:** backup listings or cleanup start tripping over empty folders.

**VM restore as new shows no progress.** The restore job reports only its end:
`restoreBackup` takes no progress callback, so the tray shows no percent while a large disk
is copied back. **Revisit trigger:** a slow restore looks stuck to a user.

**VM backups include vTPM (swtpm) state.** Backups copy disks, NVRAM and cloud-init but
not `/var/lib/libvirt/swtpm/<uuid>/` (root-owned, keyed by UUID), so restore-as-new boots
with an empty TPM; the gap is documented in `docs/specs/BACKUPS.md` § Not backed up (audit
2026-10-16, V18). Shape: a privileged helper (registered in `install-helpers.sh` + sudoers
per DEPLOYMENT.md) that copies the state dir into the backup and back under the restored
VM's UUID. **Revisit trigger:** a restored Windows VM needed BitLocker recovery.

**A rename leaves the workload's backups under its old name.** Backups live in per-name
folders at each destination (`<root>/vms/<name>/<timestamp>/`,
`<root>/containers/<name>/<timestamp>/`), and a rename moves neither folder: on each
destination (local, and the SMB backup mount when one is configured) the old name's folder
stays, its manifests naming the old name. The workload's page, which lists backups by the
current name, then shows none, and the Backups view shows them as a workload of the old
name that no longer exists; restoring one as new still works. The last-attempt status does
move (milestone 3). Seen on tini for a container rename (2026-11-20); a VM rename does the
same by the code (`vmManagerBackup.js` lists `<root>/vms/<vmName>/`, and nothing moves it).
**Revisit trigger:** a user who renamed a workload looking for its backups, or the next work
on backups.

**A backup that fails on a tool error records `INTERNAL_ERROR`.** A backup that fails
inside its run on a tool error (tar exit 2) records `INTERNAL_ERROR`, not a backup code:
the managers' backup paths leave such failures uncoded (found on tini, 2026-11-20).
**Revisit trigger:** a client that branches on a backup failure's code.

## Host, storage, stats

**The first stats tick of a VM or container shows zero rates.** With no previous sample
the CPU, disk and network rates are 0 rather than missing (`getVMStats`,
`getContainerStats`). **Revisit trigger:** a zero seen and taken for a real figure, or the
stats shapes' next change.

**A hung CIFS mount blocks Node's filesystem calls.** The readers of a share that remain
on libuv's thread pool can each be held there by an unresponsive SMB share, and about 4
held at once stall all of Wisp's file access: listings, writes and deletes on an SMB
backup destination (run as jobs, which contains the damage but does not fix it), the
container mount-usage walk (its 20 s budget answers the page, but a walk stuck in `lstat`
keeps its thread), the container mount content routes, and the bind-source check of a
container start. The Host page no longer reads a share (phase 5, milestone 2: its
filesystem usage lists local storage only). **Revisit trigger:** Wisp is seen stalled by
an unresponsive SMB share.

**Hardware temperature reads may wake disks.** Host stats read hwmon every 5 s; with
`drivetemp` loaded a SATA disk's sensor read can keep it from standby, which SMART reads
now respect (`-n standby`). **Revisit trigger:** disks on a host with `drivetemp` never
reach standby.

**host and storage's smaller duplicates (audit V-11), and the silent catches left (V-6).**
Left by phase 5 of the 2026-11-17 plan, which did not reach them: `smbMount.js` and
`diskMount.js` are near-twins; three error factories are byte-identical; the storage
facade's generic exports (`start`, `stop`, `getDevices`, `onChange`, `refresh`) are
renamed by every caller. Milestone 1 logged the failed host reads; the other silent
catches the audit counted in host, storage and mdns were not counted again
(docs/reviews/2026-11-17/AUDIT.md, V-6 and V-11; 2026-11-22). **Revisit trigger:** the
next change to the mount helpers, or the docs and rule sweep (phase 8).

**Detected drives list a filesystem Wisp cannot adopt.** An `iso9660` disc (the cloud-init
disc of a VM that runs Wisp, say) shows in Host Mgmt's Detected drives with an Adopt that
is off and a UUID cut short, and nothing says why. **Revisit trigger:** a user asks what
the row is for.

## Frontend

**Sidebar: manual within-section workload ordering.** A third sort mode alongside
alphabetical and online-first; the order lives on the section assignments so it is the
single ordering shared by every consumer. **Revisit trigger:** the existing sorts
demonstrably fight a real workflow — repeatedly hunting for a workload the sort keeps
burying.

**Two tabs can exhaust HTTP/1.1's six connections.** Chrome's cap is per origin and
shared by every tab: each tab holds `/api/events`, and a detail page or Host Mgmt adds
its scoped streams (stats, logs, disks, USB, job progress), so two such tabs can reach
six and queue every further request until a stream closes. Seen once during the
command-acks milestone 1 check (2026-11-15): a GET queued 15–30 s in the second tab right
after a navigation in the first. Confirmed on tini (2026-11-16): two tabs on one VM's
detail page (each holds `/api/events`, the VM's stats and the host USB stream) left the
second tab's USB section on "Loading USB devices…". One tab reaches it too: a page left
by a full load (typed URL, link, not in-app navigation) goes to Chrome's back-forward
cache with its streams still holding their connections — seen on tini (2026-11-21, a
headless walk loading pages one after the other; `pagehide` reported `persisted`): after
three loads of container pages a GET waited over 15 s. Closing the streams on a persisted
`pagehide` and opening them on `pageshow` would free them. ARCHITECTURE § Transport counts on the
scoped streams staying few enough. Behind an HTTP/2 proxy it can't happen. **Revisit
trigger:** a request seen stalled in DevTools ("Stalled"/"Queueing") with two tabs open
over plain HTTP.

**Help icons rely on `title`.** `HelpIcon.jsx` shows its text only as a `title` tooltip,
which never appears on touch (found in the 2026-11-12 rules audit). **Revisit trigger:**
help text is needed on a phone or tablet.

**The library picker lists symlinks that point outside the library.** The allowed-roots
check now rejects them (422 `PATH_NOT_ALLOWED`), but the picker still offers them.
**Revisit trigger:** a symlinked library entry is picked and refused.

**Pages come in two widths.** A VM's and a container's page, and the New VM and New
container forms, hold their content to a centred column (`PageBody`'s `narrow`, 768 px);
Host Overview, Host Mgmt, Software, App Config and Backups run the full width. So the
app changes shape between a workload and the host. The user's read after browsing
2.9.0-beta.2 (2026-11-24): one width for every page; the Host pages still looked right
in a narrowed window, though some may be tight; 768 px may be a little narrow, but much
wider and a workload's label and value sit too far apart. Shape: one column width, set
once in `PageBody` (no `narrow` prop), picked by reading the workload cards and the
widest Host tables (network, hardware, storage, backups, the image library, Software's
two cards side by side) at a few candidates; the page specs and FRONTEND-RULES say the
width once. **Revisit trigger:** the next frontend session, or before the stable 2.9.0.

**On a phone the figures are spread unevenly.** Seen by the user on an iPhone
(2.9.0-beta.2, 2026-11-24). A container's live line puts CPU at the left edge and
Memory at the right edge with the line's whole width between them. A VM's puts Disk
starting at the middle, not centred, so CPU has too much room and Disk and Net sit
close. The identity line above is packed at the left (address, name, uptime with dots)
while the line under it is spread. The user's shape: the identity line spread like a
VM's live line, the address at the left, the name in the middle, the uptime at the
right; a VM's three live figures evenly placed, Disk centred; a container's two brought
together (Memory beside CPU, or both about the middle), not pushed to the edges. The
rule that no label moves with a live value stays (reserved widths). Touches
`FiguresRow.jsx` below `sm` only, and the Phones line of `docs/specs/UI.md`.
**Revisit trigger:** the next frontend session.

**On an iPhone the top of the page fades out.** The top bar (the menu button, the logo,
the server name and the three buttons at the right) looks dimmed, as under a dark
gradient that starts behind the status bar, in the dark theme on 2.9.0-beta.2 (the
user's screenshots, 2026-11-24). Cause not looked into: the page is laid out under the
status bar (`viewport-fit=cover`, the safe-area paddings in `index.css`), so the
browser's own edge effect over that area is the first thing to rule out, then the top
bar's background and `theme-color`. **Revisit trigger:** the next frontend session.

**The New VM form's Image field reads "Loading the library…" after the library's read
failed.** Its first option tells loading from loaded by the data alone, so under the
failed read's error and its Retry the field still says it is loading (seen on the dev
stack, 2026-11-24). **Revisit trigger:** the next change to the New VM form.

## Backend robustness and outbound requests

**Other wraps pass an inner Wisp error's message as its raw cause.** The five wraps of a
Wisp error go through `wrapAppError` and the managers' twins since 2026-11-20; other
sites still hand an inner error's `message` to the outer one's raw, e.g.
`copyBackupPayload`'s copy failure in `vmManagerBackup.js`, whose inner is often the
pipeline's own `BACKUP_RESTORE_FAILED`. The detail is right but the inner Wisp message
is redacted like a tool's (found while fixing the five, 2026-11-20). **Revisit trigger:**
a detail whose redacted cause hides a path or name the operator needed.

**Watchdogs fire up to 15 s late.** `createStallWatchdog` checks every
`min(15 s, stallMs / 4)`, so a 60 s or 90 s bound fires up to 15 s after it is reached.
**Revisit trigger:** a bound's precision starts to matter (a caller's bound that must end
inside another's).

**The Home Assistant OS preset download finds no image.** `getLatestHaosAsset` reads the
latest release of `home-assistant/operating-system` and looks for a `haos_ova-*.qcow2.xz`
or `haos_generic-x86-64-*.qcow2.xz` asset; on 2026-11-20 the latest release (18.5) lists 8
assets and none of them is a disk image, so the preset answers `NO_ASSET` (seen running
the lookup itself; the GET through the SSRF guard succeeds). Where the images are now
published needs looking up before the fix. **Revisit trigger:** a user downloading Home
Assistant OS, or the next work on the library presets.

## Checks, tests, development

**A helper refusal test can hit the 10 s test timeout under load.** `wisp-mount.test.js`'s
"a credentials file of another user is refused" timed out once in a full `npm run check`
on the Mac (exit `null`, not 64) while other test files ran beside it, and passed alone
(found in the host-certificate build, 2026-11-25). **Revisit trigger:** it fails again, or
any helper test times out in the release workflow.

**No check refuses a duplicate JSX prop.** A component given the same prop twice keeps
the last one silently: that is how a doubled `saveDisabledReason` on the VM General card
let its Save on while its CPU or RAM had a problem (found in the frontend data flow
milestone 4 run, 2026-11-21). ESLint's core rules have none for JSX, and no React plugin
is installed (`eslint-plugin-react`'s `jsx-no-duplicate-props` would be one, a new dev
dependency). **Revisit trigger:** another duplicate prop found in review or as a bug.

**The source checks read code with a hand lexer.** `check-imports.mjs`, `check-fences.mjs`
and `check-error-messages.mjs` find imports, calls and strings through `scripts/sourceScan.mjs`,
which strips comments by hand: a `/*` or a lone backtick in JSX text, a regex after `i++ /`,
or the word "import" in text can make them miss code or read text as code.
`check-exports.mjs` reads a real parse (ESLint's `Linter`, with a rule of its own) and fails
on a file that does not parse; the others should move to the same parsed reader. And
`check-imports.mjs` covers only `backend/src`, `backend/migrations` and `shared/`: a
frontend import of a name its module does not export is caught only by the frontend build,
which `npm run check` does not run (found 2026-11-21: views kept importing a removed
`useHeld` and the check passed). One known misreading: a destructured dynamic import
with a name holding "import" (`const { importSshKeys } = await import('…')`) is reported
as unreadable, so `backend/src/lib/settingsSshKeys.test.js` reads the module by member. **Revisit trigger:** one of those checks passing or failing
on text rather than code, a frontend import of a missing name reaching a commit, or the
next work on the checks.

**Unused exports in `backend/src` and `shared/` are not checked.** `scripts/check-exports.mjs`
scans `frontend/src` only: an export of a backend or shared module that nothing imports
passes. The backend's facades (`lib/<module>/index.js`, bound per platform) and the
dynamic imports of the `linux/` files need the scan to follow them first. **Revisit
trigger:** dead backend code found that a check would have caught, or the next work on the
checks.

**macOS dev backend sometimes ignores SIGTERM.** A dev backend started with plain
`nohup node src/index.js` sometimes kept running after `kill` (seen 2026-11-12, on main's
code too); `npm run dev` under a terminal was not affected. Not investigated: possibly a
shutdown step that waits on a darwin stub. **Revisit trigger:** it gets in the way of dev
work or a script that restarts the dev backend.

**No check sees the manager members a migration reads.** Migrations take the managers
from their context and read them as `ctx.vmManager.X` / `ctx.containerManager.X`
(0001–0008, sometimes through an alias), which the import check cannot follow: a
misnamed member in a new migration fails the host's update, which then rolls back
(found in the safety-net review, 2026-11-18). Fix shape: check those member reads in
`backend/migrations/` against the facades' exports. **Revisit trigger:** the next new
migration, or the next work on the checks.

**A unit test failed once and could not be made to fail again.** `npm run check` on
`main` answered "check failed: test" once, right after a merge and while another
session's work was ending on the same machine (2026-11-23); the next five runs passed
with all 571 tests, and the failing test's name was not kept. A test that depends on
timing under load is the likely kind. **Revisit trigger:** the test step fails again
without a code change: keep the full output and name the test.

**The import check misreads a name that begins with `import`.** `check-imports`
finds an `import … from` by a pattern that also matches inside an export list holding a
name such as `importImageArchive`, and reports it as a form it cannot read; the image
archive upload named its function `storeImagesFromArchive` to pass (2026-11-26).
**Revisit trigger:** another name has to change for the scan.

## Docs and method

**Split CONTAINERS.md by area.** Like API.md and UI.md (split 2026-11-15 and later),
it is large enough that an agent reading it for a single area loads all of it: about
137 KB before the docs and rule sweep cut it. Shape: a shared core file plus one file
per area, content moved unchanged, links fixed across the docs. **Revisit trigger:** the
next feature that works in that spec, if it is still above about 60 KB.
