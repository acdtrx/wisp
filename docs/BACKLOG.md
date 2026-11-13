# Backlog

Deferred bugs and ideas (see `AGENTS.md`, Scope).

Entry format: a bolded title, what it is in a sentence or two, and the **revisit
trigger** — the observed condition that would make it worth building (features earn
their place). Date rulings inline: `(ruled YYYY-MM-DD: wait to see if needed.)`.
Group entries under headings as themes emerge.

**Sidebar: manual within-section workload ordering.** A third sort mode alongside
alphabetical and online-first; the order lives on the section assignments so it is the
single ordering shared by every consumer. **Revisit trigger:** the existing sorts
demonstrably fight a real workflow — repeatedly hunting for a workload the sort keeps
burying.

**Short commands that return their result in the response.** ARCHITECTURE § Transport
says a POST carries only the ack and validation errors, and the result arrives through the
stream. Long operations follow it (rules-conformance 2b-2); short ones such as a settings
PATCH still answer with the new state, which mostly also reaches clients through the
stream. **Revisit trigger:** a client shows stale state after a short command, or a short
command turns out to run long.

**Check Wisp's docs against the template for reworded rules.** ARCHITECTURE's "commands
go in as POSTs; results come back through the stream" had been reworded to fit the code
when the template was adopted, and the drift surfaced only through a timeout debate.
Diff each doc against `../claude-template` and list every place a template rule was
weakened rather than the code changed. **Revisit trigger:** the next template sync, or
another rule found reworded.

**A hung CIFS mount blocks Node's filesystem calls.** Listings, deletes and copies on an
unresponsive SMB destination block the libuv thread pool and can't be timed out; running
them as jobs contains the damage but doesn't fix it. **Revisit trigger:** Wisp is seen
stalled by an unresponsive SMB share.

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

**Arch: a custom pacman `DBPath` isn't followed.** `wisp-os-update`'s scratch sync
database assumes `/var/lib/pacman`. **Revisit trigger:** an Arch host with a custom
`DBPath` runs Wisp.

**Route errors carry the message, not a stable code.** `handleRouteError` answers
`error: err.message`, while CODING-RULES §5 wants `error` to be the stable code and the
message in `detail`; `specs/ERROR-HANDLING.md` describes the message form (found
2026-11-12). **Revisit trigger:** a client needs to branch on a route error, or the next
work on the error contract.

**Cloud-init: no way to remove a password in the UI.** A blank password field on edit
keeps the stored one (settled 2026-11-12), so the only way to drop a password is deleting
the VM's cloud-init config. **Revisit trigger:** a password needs removing without
wiping cloud-init.

**Container task-delete errors are swallowed.** `cleanupTask` ignores a failed
`Tasks.Delete`; when it was a stale CREATED task, the start then fails with "already
exists" and rolls back, with no clearer cause. **Revisit trigger:** a start is seen
failing with "already exists".

**One rule for a container's "restart required".** Three places decide it differently:
`updateContainerConfig` flags a mounts/devices change, the row mount `PATCH` has its own
`layoutUnchanged` test, and the app save path ORs its mount signature with the app
module's hook (found 2026-11-12). **Revisit trigger:** the response and the badge are
seen disagreeing again, or the next change to any of the three.

**Deleting a VM leaves its `backup-status.json` entry.** Container deletes prune theirs
(`forgetBackupStatus`, 2026-11-12); VM deletes don't. **Revisit trigger:** a stale VM
entry confuses the backups view, or the next work on VM delete.

**Help icons rely on `title`.** `HelpIcon.jsx` shows its text only as a `title` tooltip,
which never appears on touch (found in the 2026-11-12 rules audit). **Revisit trigger:**
help text is needed on a phone or tablet.

**A timed-out avahi registration is never retried.** With the 5 s bound on avahi calls
(settled 2026-11-12), a registration that times out leaves its entry unpublished;
`reregisterAll` runs only when the daemon restarts, not when a hung one recovers, so a
container stays unpublished until its next address change, a local DNS toggle or a
restart (VMs recover on the 60 s probe). **Revisit trigger:** a workload is seen
unpublished after avahi stalled.

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
the backend, so a Wisp self-update (its first step stops the service), a backend crash or
the 600 s execFile timeout can kill dpkg mid-upgrade. Fix shape: run it in its own oneshot
unit started via one fixed sudo rule (like `wisp-updater`), or at least refuse a
self-update while an upgrade runs and drop the timeout. **Revisit trigger:** an upgrade is
ever interrupted, or OS upgrades become unattended/scheduled. (re-review 2026-10-16, P2)

**Settings forms drop bad paths on the client.** `AppConfig.jsx` and `HostBackup.jsx`
send `undefined` for an empty or relative path, so the field silently keeps its old value
and the backend's 422 `INVALID_SETTINGS` (2026-11-12) never reaches the user. Fix shape:
send the trimmed value and show the 422's message. **Revisit trigger:** someone types a
path that doesn't save, or the next work on those forms.

**macOS dev backend sometimes ignores SIGTERM.** A dev backend started with plain
`nohup node src/index.js` sometimes kept running after `kill` (seen 2026-11-12, on main's
code too); `npm run dev` under a terminal was not affected. Not investigated: possibly a
shutdown step that waits on a darwin stub. **Revisit trigger:** it gets in the way of dev
work or a script that restarts the dev backend.

**A failed SMB check leaves its mount point.** `wisp-mount smb check` runs under `set -e`, so a mount that fails (a wrong password, an unreachable host, now also the helper's own timeout) exits before the `rmdir`, leaving a `/mnt/wisp/smb-check-*` directory behind (seen 2026-11-13). Fix shape: remove the check mount point in an `EXIT` trap. **Revisit trigger:** stray `smb-check-*` directories under `/mnt/wisp`, or the next work on the helper.

**SMB shares without a password can't be mounted.** With no password in the credentials file, `mount.cifs` prompts on stdin; the helper never answers, so the mount waits until the helper's mount bound kills it (seen 2026-11-13). A guest share probably can't be mounted at all. Fix shape: pass `guest` (or an explicit empty `password=`) when no password is set. **Revisit trigger:** someone adds a guest share, or the next work on SMB mounts.

**`PATCH /api/containers/:name` has no body schema.** CODING-RULES §9 wants request
validation at the boundary; the manager validates fields piecemeal instead (found in the
2026-11-12 repairs inventory). **Revisit trigger:** a malformed PATCH body is stored, or
the next work on that route.

**Migration history in the UI.** The journal (`journalctl -u wisp-updater`) and the ledger
(`config/migrations.json`) are the only record of what an update's state migrations
changed. **Revisit trigger:** the user asks "what did the last update change?"

**Setup strategy: one update-safe path.** The installer (`push.sh` → `install.sh` →
`setup-server.sh`) and the self-update (`wisp-updater`) run different setup steps, so a
step added to setup reaches new installs but not updated ones. `common-steps.sh` is the
seam both run today; an audit found most setup steps safe to re-run on a live update.
Letting the updater run all of setup still needs: a `--strict` mode, because `run_step`
always returns 0 and the updater would lose its rollback trigger; `packages.sh` non-fatal
even under strict, since an overlapping `apt-daily-upgrade` holds the dpkg lock; and the
packages and containerd installs consolidated. Shapes considered: an update mode for
`setup-server.sh`, per-step metadata, re-runnable scripts, an update-hooks directory.
**Revisit trigger:** a second drift bug ships, or a setup addition must reach existing
installs.

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

**Check the code against the rules adopted with the template sync (2026-11-12).** Rules
the code was not checked against when they were adopted: CODING-RULES §4, config read
strictly (invalid persisted `backupSchedule` values fall back to defaults on read,
`specs/CONFIGURATION.md`); §6, every outbound request and subprocess has a timeout; §7, a
lint enforcing the external-system fences (`npm run check-imports` checks only that
imports resolve); FRONTEND-RULES Data (growing collections bounded; loading, empty and
error states), Phones and touch (16px fields, no programmatic focus on touch, hover only
under `@media (hover: hover)`) and Layers (the page under a modal inert, Tab kept inside,
focus returned; Wisp's modals still close on a backdrop click). **Revisit trigger:** the
next audit (`docs/reviews/`), or earlier work in an area one of these rules covers.
