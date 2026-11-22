# Backlog

Deferred bugs and ideas (see `AGENTS.md`, Scope).

Entry format: a bolded title, what it is in a sentence or two, and the **revisit
trigger** — the observed condition that would make it worth building (features earn
their place). Date rulings inline: `(ruled YYYY-MM-DD: wait to see if needed.)`.
Group entries under headings as themes emerge.

**`wisp-port.sh` stays in the helpers folder for older updaters.** The updater of
releases up to v2.8.0-beta.1 sources `backend/scripts/wisp-port.sh` from the tree it has
just installed, to health-check the new backend on its port, and falls back to 8080
without it: a host with another `WISP_PORT` would fail every update and roll back. The
installer is its only other reader, so it can move into `install-root.sh` once no host
can be updated by an updater that reads it (scripts/check-shell.mjs's `NOT_HELPERS` names
it until then; found in the privileged helpers milestone 2 review, 2026-11-22).
**Revisit trigger:** the first release cut after one whose updater no longer reads it.

**The version is still written in three package.json files.** The root's is the one
source since privileged helpers milestone 2 (2026-11-22): the running release's version and
a staged tree's are read there only. `backend/package.json` and `frontend/package.json`
still carry it, `scripts/release.sh` writes all three (and their lockfiles), and the
release workflow asserts the three agree, because a release before that one checks a
staged tree's `backend/package.json` and would refuse an update without it. **Revisit
trigger:** the first release cut after the one that ships the root-only staging check:
then the two versions, their writes and their assertion can go.

**There is no complete uninstall.** Nothing removes what an install put on a host:
`wisp.service` and `wisp-updater.service`, the `wisp-*` helpers and their sudo rules, the
container DNS stub's netplan file, the CNI plugins and `cni-dhcp.service`; and nothing
says what an uninstall keeps (`/var/lib/wisp`, the bridge). `wispctl svc uninstall`, which
removed `wisp.service` alone, is gone (privileged helpers, milestone 2, 2026-11-22).
**Revisit trigger:** a user asks to remove Wisp from a host.

**A container's DHCP lease is never released to the LAN's server.** At every CNI DEL
the `cni-dhcp` daemon logs "releasing lease", then "failed to release DHCP lease: unable
to get interface information: route ip+net: no such network interface", and no
DHCPRELEASE leaves the host: it drops the lease from its own state, and the LAN's server
keeps it until it expires. Seen on tini's journal for every container delete on
2026-11-22, the release before this feature and with it (found building the privileged
helpers, milestone 1). **Revisit trigger:** a LAN whose DHCP pool runs short of addresses
held by deleted containers.

**The OS update list's download size is always 0.** `wisp-os-update list` reads the size
from apt's "Need to get … of archives." line, which `apt-get -s dist-upgrade` never
prints, so `TOTAL` is 0 and `downloadBytes` with it (seen on Ubuntu 26.04 with 213
packages to upgrade, 2026-11-22, the release before this feature too). **Revisit
trigger:** the update card shows, or needs, the download size.

**The import check misreads a destructured dynamic import with a name holding
"import".** `scripts/check-imports.mjs` marks a `const { … } = await import('…')` as read
by the position of the first `import` in the statement, so a destructured name such as
`importSshKeys` points it at the name and the real `import(` is reported as unreadable;
`backend/src/lib/settingsSshKeys.test.js` reads the module by member for that reason
(found building workload pages milestone 4, 2026-11-21). **Revisit trigger:** the next
test or module that needs such a name destructured.

**No check refuses a duplicate JSX prop.** A component given the same prop twice keeps
the last one silently: that is how a doubled `saveDisabledReason` on the VM General card
let its Save on while its CPU or RAM had a problem (found in the frontend data flow
milestone 4 run, 2026-11-21). ESLint's core rules have none for JSX, and no React plugin
is installed (`eslint-plugin-react`'s `jsx-no-duplicate-props` would be one, a new dev
dependency). **Revisit trigger:** another duplicate prop found in review or as a bug.

**A VM rename does not rebuild its cloud-init seed.** The seed ISO keeps the hostname it
was built with, so a VM renamed after its cloud-init was set keeps the old name until
the seed is rebuilt; and a VM whose stored cloud-init has no hostname (one written
through the API) takes the VM's current name each time the seed is built, so an
unrelated cloud-init save renames the guest. The manager's side (phase 5). **Revisit
trigger:** phase 5, or a guest found named other than its VM.

**The test module mocks use `namedExports`, deprecated after Node 24.** Five test files
(`backend/src/lib/containerOperations.test.js`, `vmOperations.test.js`,
`containerBackupScheduler.test.js`, `cloudInit.test.js`,
`downloads/ssrfSafeFetch.test.js`) mock modules with
`mock.module(…, { namedExports })`, which later Node releases replace with `exports`
(found 2026-11-20). **Revisit trigger:** the runtime moves past Node 24, or the option
warns or breaks in the test run.

**Other wraps pass an inner Wisp error's message as its raw cause.** The five wraps of a
Wisp error go through `wrapAppError` and the managers' twins since 2026-11-20; other
sites still hand an inner error's `message` to the outer one's raw, e.g.
`copyBackupPayload`'s copy failure in `vmManagerBackup.js`, whose inner is often the
pipeline's own `BACKUP_RESTORE_FAILED`. The detail is right but the inner Wisp message
is redacted like a tool's (found while fixing the five, 2026-11-20). **Revisit trigger:**
a detail whose redacted cause hides a path or name the operator needed.

**The SSRF guard follows a downgrade, and sends the caller's headers to every hop.**
`ssrfSafeFetch` (`backend/src/lib/downloads/downloadFromUrl.js`) follows a redirect from
`https` to `http`, so a mirror's (or a path attacker's, past the first hop) redirect can
downgrade a library download to plain HTTP; and it passes the caller's `init.headers` to
each hop, another host's included. Today the headers are only `User-Agent` and `Accept`,
and nothing checks a downloaded image against a digest (found 2026-11-20, with the
outbound-HTTP review). **Revisit trigger:** a caller of `ssrfSafeFetch` sends a header
that carries a credential (a token for GitHub's API, a registry login), or a library
download is expected to be authenticated by its transport.

**Sidebar: manual within-section workload ordering.** A third sort mode alongside
alphabetical and online-first; the order lives on the section assignments so it is the
single ordering shared by every consumer. **Revisit trigger:** the existing sorts
demonstrably fight a real workflow — repeatedly hunting for a workload the sort keeps
burying.

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

**A Linux VM created with BIOS firmware has no ACPI.** `vmManagerCreate.js` gives a
Linux domain `<features><acpi/></features>` only with UEFI (`getLinuxFeatures`, used
when `isUEFI`), so a BIOS one has none: an Ubuntu 26.04 cloud image booted that way
stopped at 2.7 s into early boot and never reached its network, and switching the VM to
UEFI then answers 500 `LIBVIRT_ERROR` ("UEFI requires ACPI on this architecture")
(found in the frontend data flow milestone 3 run, 2026-11-21, on a throwaway VM).
**Revisit trigger:** a user creating a Linux VM with BIOS firmware, or changing its
firmware afterwards.

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

**The first stats tick of a VM or container shows zero rates.** With no previous sample
the CPU, disk and network rates are 0 rather than missing (`getVMStats`,
`getContainerStats`). **Revisit trigger:** a zero seen and taken for a real figure, or the
stats shapes' next change.

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

**The backups panel shows a backup's age in the browser's time zone.** A backup's
timestamp is its folder name, in UTC (`2026-07-14T03-00-05`); `backupTsToIso` in
`frontend/src/components/backups/BackupsPanel.jsx` turns it into an ISO string with no
`Z`, which the browser reads as local time, so in UTC+2 a backup made just now shows "2h
ago" in its row while the header's last attempt says "just now" (seen on tini,
2026-11-20, phase 4's milestone 1 check). **Revisit trigger:** phase 6's work on the
backups panel, or a user reading a wrong age.

**Split CONTAINERS.md and UI.md by area.** Like API.md (split 2026-11-15), both are large
enough that an agent reading one for a single area loads all of it: `specs/CONTAINERS.md`
is about 129 KB, `specs/UI.md` about 78 KB. Shape: a shared core file plus one file per
area, content moved unchanged, links fixed across the docs. **Revisit trigger:** the next
feature that works in either spec.

**A hung CIFS mount blocks Node's filesystem calls.** The readers of a share that remain
on libuv's thread pool can each be held there by an unresponsive SMB share, and about 4
held at once stall all of Wisp's file access: listings, writes and deletes on an SMB
backup destination (run as jobs, which contains the damage but does not fix it), the
container mount-usage walk (its 20 s budget answers the page, but a walk stuck in `lstat`
keeps its thread), the container mount content routes, and the bind-source check of a
container start. The Host page no longer reads a share (phase 5, milestone 2: its
filesystem usage lists local storage only). **Revisit trigger:** Wisp is seen stalled by
an unresponsive SMB share.

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

**host and storage's smaller duplicates (audit V-11), and the silent catches left (V-6).**
Left by phase 5 of the 2026-11-17 plan, which did not reach them: `smbMount.js` and
`diskMount.js` are near-twins; three error factories are byte-identical; the storage
facade's generic exports (`start`, `stop`, `getDevices`, `onChange`, `refresh`) are
renamed by every caller. Milestone 1 logged the failed host reads; the other silent
catches the audit counted in host, storage and mdns were not counted again
(docs/reviews/2026-11-17/AUDIT.md, V-6 and V-11; 2026-11-22). **Revisit trigger:** the
next change to the mount helpers, or the docs and rule sweep (phase 8).

**An unchanged app save sets "restart required" when the app has no reload command.**
`applyAppConfig` (`backend/src/lib/containerApps/index.js`) flags a running app container
whenever it has no reload command (or the env changed), even when the save changed
nothing: its mount contents are written each time and not compared with what they were
(found in phase 5, milestone 4, 2026-11-22). **Revisit trigger:** the badge seen after
re-saving an unchanged app.

**Found on tini in milestone 3's run (2026-11-20), outside this feature.** A VM created
through the API with its firmware left at the default (`bios`) from the Ubuntu 26.04 cloud
image never boots (dracut emergency shell), while the UI's defaults (`uefi`) do; a `PATCH
{"firmware":"uefi"}` on such a VM answers 500 `LIBVIRT_ERROR` "UEFI requires ACPI". And a
backup that fails inside its run on a tool error (tar exit 2) records `INTERNAL_ERROR`, not
a backup code: the managers' backup paths leave such failures uncoded (phase 5's
containerManager work). **Revisit trigger:** the next work on VM create defaults or
firmware edits, or a client that branches on a backup failure's code.

**The source checks read code with a hand lexer.** `check-imports.mjs`, `check-fences.mjs`
and `check-error-messages.mjs` find imports, calls and strings through `scripts/sourceScan.mjs`,
which strips comments by hand: a `/*` or a lone backtick in JSX text, a regex after `i++ /`,
or the word "import" in text can make them miss code or read text as code.
`check-exports.mjs` reads a real parse (ESLint's `Linter`, with a rule of its own) and fails
on a file that does not parse; the others should move to the same parsed reader. And
`check-imports.mjs` covers only `backend/src`, `backend/migrations` and `shared/`: a
frontend import of a name its module does not export is caught only by the frontend build,
which `npm run check` does not run (found 2026-11-21: views kept importing a removed
`useHeld` and the check passed). **Revisit trigger:** one of those checks passing or failing
on text rather than code, a frontend import of a missing name reaching a commit, or the
next work on the checks.

**Unused exports in `backend/src` and `shared/` are not checked.** `scripts/check-exports.mjs`
scans `frontend/src` only: an export of a backend or shared module that nothing imports
passes. The backend's facades (`lib/<module>/index.js`, bound per platform) and the
dynamic imports of the `linux/` files need the scan to follow them first. **Revisit
trigger:** dead backend code found that a check would have caught, or the next work on the
checks.

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

**The Home Assistant OS preset download finds no image.** `getLatestHaosAsset` reads the
latest release of `home-assistant/operating-system` and looks for a `haos_ova-*.qcow2.xz`
or `haos_generic-x86-64-*.qcow2.xz` asset; on 2026-11-20 the latest release (18.5) lists 8
assets and none of them is a disk image, so the preset answers `NO_ASSET` (seen running
the lookup itself; the GET through the SSRF guard succeeds). Where the images are now
published needs looking up before the fix. **Revisit trigger:** a user downloading Home
Assistant OS, or the next work on the library presets.

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

**A spec that disagrees with the code, found in the error sweep.** CONTAINERS.md says
Stop and Kill answer 200 `{ ok, restartCancelled }`, while API-CONTAINERS has Stop as a
202 job and Kill as 204 (found 2026-11-20, while naming each error's code). It needs the
code or the spec settled with the user. **Revisit trigger:** the next work on container
lifecycle.

**Help icons rely on `title`.** `HelpIcon.jsx` shows its text only as a `title` tooltip,
which never appears on touch (found in the 2026-11-12 rules audit). **Revisit trigger:**
help text is needed on a phone or tablet.

**A timed-out avahi registration is never retried.** With the 5 s bound on avahi calls
(settled 2026-11-12), a registration that times out leaves its entry unpublished;
`reregisterAll` runs only when the daemon restarts, not when a hung one recovers, so a
container stays unpublished until its next address change, a local DNS toggle or a
restart. **Revisit trigger:** a workload is seen unpublished after avahi stalled.

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
