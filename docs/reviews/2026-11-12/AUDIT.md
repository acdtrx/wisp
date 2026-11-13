# Rules conformance audit — 2026-11-12

Checks the code at `27ecdce` against the rules adopted with the 2026-11-12 template sync
(feature `docs/features/rules-conformance.md`): CODING-RULES §4 (strict config), §6
(timeouts), §7 (import fences, enforced by a lint), and FRONTEND-RULES Data, Phones and
touch, Layers. Scope: `backend/` (incl. `backend/scripts/` helpers and the migration
runner), `frontend/`, `scripts/`. Read-only: no code changed. Five read-only sweeps, one per
rule group; every finding below was re-checked against the code before it was written down.

Each finding: **ID** — file:line — what — fix sketch — **clear** (the rule settles the fix) or
**decision** (needs the user's call; a recommendation follows). Paths are repo-relative;
`be/` = `backend/src/`, `fe/` = `frontend/src/`.

| Rule | Findings | Clear | Decision |
|---|---|---|---|
| §4 Config read strictly | 12 | 8 | 4 |
| §6 Timeouts | 17 | 11 | 6 |
| §7 Import fences + lint | 8 | 3 | 5 |
| Data | 18 | 16 | 2 |
| Phones and touch | 5 | 3 | 2 |
| Layers | 8 | 5 | 3 |
| **Total** | **68** | **46** | **22** |

---

## CODING-RULES §4 — config is read strictly

Rule: reject unknown keys and wrong types at startup, so a typo fails, never silently
defaults. No reader of any config file rejects an unknown key today, and `wisp-config.json`
is never validated at startup.

- **CFG-1** — `be/lib/config.js:68-92` (`getConfigSync`, read at startup by
  `be/index.js:105` and `be/lib/managerBootstrap.js:29`, and again on every `paths.js` lookup
  and `resolveMount`). Invalid JSON only warns (`:90`) and returns `DEFAULTS`, so the backend
  boots on `/var/lib/wisp/vms` with no trusted proxies; a wrong-typed or relative path becomes
  the default (`validatePath :25-27`); `mounts` passes through unvalidated (`:78`);
  `serverName` / `backupMountId` of the wrong type become `null`; unknown keys are ignored.
  `settings.js:329` rethrows the same parse error, so the two readers disagree.
  *Fix:* one schema (`parseWispConfig(data)`) shared by both readers, throwing
  `CONFIG_INVALID` naming the key on an unknown key, a wrong type or invalid JSON; run it once
  in `index.js` before `configureManagers()` and exit on failure. A missing file still means
  defaults. — **clear**
  **Fixed:** `lib/configSchema.js` is the one schema; `getConfigSync` and
  `readSettingsFile` parse through it, and `index.js` reads it before anything else,
  exiting with the message (e.g. `wisp-config.json → backupSchedule.time: …`). The
  merged migration `0007-repair-config-and-records` repairs what older releases left
  (retired keys, mounts outside `/mnt/wisp/`, dangling backup references), the migrations
  before it read paths tolerantly, and the runner refuses an invalid config after the
  migrations (exit 2).
- **CFG-2** — `be/lib/config.js:44-62` (`parseTrustedProxies`) skips an invalid entry with a
  warning, deliberately ("a typo must not crash-loop the systemd service";
  `docs/specs/CONFIGURATION.md:147`). A dropped entry silently changes cookie `Secure` and the
  rate-limit key. — **decision.** *Recommendation:* fail at startup like every other key: the
  field is hand-edited, read at startup, and a crash-loop is visible (`systemctl status`; on
  update the health check fails and the updater rolls back, `backend/scripts/wisp-updater:84-105`).
  **Fixed:** an invalid entry fails startup, naming it; CONFIGURATION.md reworded.
- **CFG-3** — `be/lib/settings.js:322-387` (`readSettingsFile`, uncached: every
  `getSettings`, bearer-token check `be/lib/apiTokens.js:70`, OIDC routes, scheduler ticks,
  auto-mount retries) normalizes instead of rejecting: `backupSchedule`
  (`normalizeBackupSchedule :197-218`, every bad field → default — the feature's own example);
  `mounts` (`normalizeMounts :291-320`, bad entries dropped, bad `fsType` → `''`);
  `oidc` (`:172-186`, `enabled: true` on an incomplete block → `false`); `apiTokens`
  (`:269-287`, invalid tokens dropped — a token silently stops authenticating);
  `updateChannel` (`:377`, anything but `'beta'` → `'stable'`); `discoveryEnabled` (`:371`,
  non-boolean → `true`); `advertisedUrl` (`:373`, not checked on read); `sections` /
  `assignments` / `homepage` (`:55-170`). Unknown keys are ignored on read **and deleted by the
  next UI save** (`persistSettings :649-699` writes only known keys).
  *Fix:* validate with the CFG-1 schema at startup (fail to boot); on later reads, parse the
  same schema and throw rather than normalize. — **clear**
  **Fixed:** every key is checked strictly on every read; unknown keys at any level are
  rejected, so none survives to be dropped by a save.
- **CFG-4** — same reader: dangling references left by a legitimate UI delete (a
  `backupMountId` / `backupSchedule.destinationIds` naming a removed mount, an assignment to a
  deleted section) are dropped silently. — **decision.** *Recommendation:* these aren't typos:
  keep them self-healing, and make the deletes cascade so they don't arise (`removeMount`
  `:862-875` already clears `backupMountId`; also prune `destinationIds`).
  **Fixed, reversed (settled 2026-11-13):** a dangling `backupMountId` or schedule
  destination fails the read, naming the key; deleting or swapping the backup mount prunes
  both in the same write, and migration 0007 prunes what older releases left.
  An assignment to a removed section still falls back to Main.
- **CFG-5** — values the UI itself wrote that a stricter read would reject. —
  **decision.** *Recommendation:* they block boot like a hand edit: make the write-side
  validators (`backupSchedule :225-264`, `oidc :546-565`, `advertisedUrl :525-544`) the single
  schema the read uses, so the two sides can't drift and a UI write can't produce a
  boot-blocking file.
  **Fixed:** the write paths use the schema's field checks (`checkBackupScheduleField`,
  `checkOidc`, `checkAdvertisedUrl`, `checkMountPath`, the name/URL checks), and
  `persistSettings` writes only what `parseWispConfig` accepts.
- **CFG-6** — `be/lib/settings.js:576-625` (`buildUpdatedSettings`) coerces on write: a bad
  path or `updateChannel` → default, a bad `backupMountId` → `null` (`:588`). *Fix:* reject with
  422 through the same schema. — **clear**
  **Fixed:** `buildUpdatedSettings` answers 422 `INVALID_SETTINGS` for a relative path, an
  unknown `backupMountId`, a bad `updateChannel`; `mergeOidc` no longer silently disables
  an incomplete enabled config (422 `INVALID_OIDC`).
- **CFG-7** — `config/wisp-config.json.example:2` ships a `_comment` key, which
  `scripts/linux/setup/config.sh:46` deletes on install and `persistSettings` drops; a strict
  reader would reject a hand-copied example. *Fix:* allow `_comment` in the schema (or drop it
  from the example). — **clear**
  **Fixed:** `_comment` (a string) is allowed and never written back.
- **CFG-8** — `be/lib/loadRuntimeEnv.js:31-43`: a malformed line (no `=`, `export X=1`) is
  skipped silently (`:35`); unknown keys are loaded with no word. systemd's `EnvironmentFile=`
  reads the same file, so non-Wisp variables may legitimately be there. — **decision.**
  *Recommendation:* throw on a line that doesn't parse; reject an unknown `WISP_*` key (against
  the list the code reads); leave other keys alone.
  **Fixed:** malformed lines, a key set twice and unknown `WISP_*` keys throw, naming the
  line; other keys are left alone.
- **CFG-9** — `be/index.js:62`: `parseInt(WISP_PORT) || 8080` turns `abc` into 8080 and `80x`
  into 80; `backend/scripts/wisp-updater:94-96`, `scripts/linux/wispctl.sh:11-19,31` and
  `scripts/linux/install.sh:174-175` repeat the coercion. *Fix:* `/^\d+$/`, 1–65535, else exit;
  the scripts share the same check. — **clear**
  **Fixed:** digits, 1–65535, else startup fails; `wisp-updater`, `wispctl.sh` and
  `install.sh` apply the same check.
- **CFG-10** — other environment read without validation: `WISP_DEFAULT_BRIDGE`
  (`be/lib/networking/linux/hostBridges.js:20-21,54-55`, a nonexistent bridge ignored in one
  place and used blindly in the other), the `*_SCRIPT` overrides and `WISP_CNI_*_DIR` (fail at
  use). *Fix:* validate in the CFG-8 env schema at startup. — **clear**
  **Fixed:** `checkRuntimeEnv` checks every `WISP_*` value at startup (paths absolute,
  scripts executable, origins, repo, flag); `WISP_DEFAULT_BRIDGE` must name a host bridge
  (networking `checkDefaultBridgeOverride`, Linux).
- **CFG-11** — `be/lib/auth.js:28-54`: `config/wisp-password` is format-strict but read lazily
  on every sign/verify/login, never at startup, though its comment (`:26`) says the backend
  refuses to start; an unreadable file means "not configured" (`:31-35`). *Fix:* read it once
  in startup; EACCES is fatal. — **clear**
  **Fixed, with one difference:** checked at startup (EACCES or a bad format is fatal) and
  an unreadable file is an error, not "not configured" — but still read on each use rather
  than once, so `wispctl password` (which restarts nothing) applies live.
- **CFG-12** — doc drift: `docs/specs/CONFIGURATION.md:13-25` lists env vars but not
  `WISP_ALLOWED_WS_ORIGINS`, `WISP_CONTAINERD_SOCK`, `WISP_CNI_BIN_DIR`, `WISP_CNI_CONF_DIR`,
  `WISP_UPDATE_REPO`, `WISP_ROUTE_ACCESS_REPORT`. *Fix:* add them with the CFG-8 list. —
  **clear**
  **Fixed:** the six variables are in the table.

Fine as is: `config/migrations.json` (`backend/scripts/migrate.mjs:105-125` already exits 2 on
a malformed ledger; machine-written). `config/backup-status.json` (`be/lib/backupStatus.js:31-45`)
is a deletable last-outcome cache, not configuration — the rule doesn't apply.

Spec lines that change with CFG-1/2/3 (the feature allows the `CONFIGURATION.md` edit):
`:49` (backupSchedule "fall back to defaults on read"), `:92` (homepage "lenient and
self-healing"), `:124` ("If the file is missing or invalid, defaults apply"), `:147`
(trustedProxies "ignored (logged)").

---

## CODING-RULES §6 — every outbound request and subprocess has a timeout

### Inventory

Node's global `fetch` and an undici `Agent` with no options carry undici's defaults only:
connect 10 s, headers 300 s, body 300 s *between chunks* — "implicit" below.

**Subprocesses (backend/src)**

| Call | Timeout |
|---|---|
| `lib/host/linux/hostPower.js:51,53,68,70` wisp-power | 5 s |
| `lib/host/linux/osUpdates.js:106` wisp-os-update list | 120 s |
| `lib/host/linux/osUpdates.js:183` wisp-os-update upgrade | 600 s (TMO-4) |
| `lib/host/linux/smart.js:218` wisp-smartctl | 10 s |
| `lib/host/linux/hostHardware.js:419` wisp-dmidecode | 10 s |
| `lib/host/darwin/systemProfilerHardware.js:95`, `systemProfilerSoftware.js:24`, `procStats.js:80,118` | 45 s, 15 s, 5 s, 3 s |
| `lib/networking/linux/managedBridges.js:120,122` wisp-bridge | 120 s |
| `lib/storage/linux/smbMount.js:144,189` mount / check, `:207` unmount, `:223` rmdir | 30 s, 10 s, 5 s (TMO-3) |
| `lib/storage/linux/diskMount.js:108` mount, `:128` unmount | 30 s, 10 s (TMO-3) |
| `lib/containerManager/linux/containerManagerNetwork.js:202-203,214` CNI; `:266,268,297` netns add; `:349,351,358` netns delete; `:421-422` ipv4; `:528,530` route-add | 30 s, 15 s, 15 s, 8 s, 8 s |
| `lib/wispUpdate.js:365` tar -xzf release | **none** |
| `lib/wispUpdate.js:453` systemctl start wisp-updater | **none** |
| `lib/cloudInit.js:39`, `lib/containerApps/zot.js:53` openssl passwd | **none** |
| `lib/cloudInit.js:185,192` cloud-localds / genisoimage | **none** |
| `lib/storage/diskOps.js:80,163` qemu-img info; `:202` convert; `:267` resize | **none** |
| `lib/vmManager/linux/vmManagerDisk.js:140`, `vmManagerCreate.js:428` qemu-img create | **none** |
| `lib/vmManager/linux/vmManagerNvram.js:18` wisp-nvram copy | **none** |
| `lib/vmManager/linux/vmManagerBackup.js:50` cp --reflink of a disk | **none** |
| `lib/containerManager/linux/containerManagerExec.js:49` mkfifo (execFileSync) | **none** |
| `lib/containerManager/linux/containerManagerBackup.js:110` tar \| gzip backup; `:152` tar restore | **none** |
| `lib/containerManager/linux/containerManagerMountsContent.js:126` unzip -Z1; `:156` unzip | **none** |
| `lib/downloads/downloadHaos.js:51` xz -dc | **none** |

**Outbound HTTP (backend/src)**

| Call | Timeout |
|---|---|
| `lib/oidc.js:42` (discovery, JWKS, token) | 10 s incl. body |
| `lib/downloads/downloadUbuntuCloud.js:52-54` simplestreams | 8 s incl. body |
| `lib/wispUpdate.js:168-171` GitHub releases API | headers/body 30 s |
| `lib/wispUpdate.js:287` release tarball + sha256 (ssrfSafeFetch) | implicit (TMO-7) |
| `lib/downloads/downloadHaos.js:29` GitHub API | implicit (TMO-5) |
| `routes/cloudinit.js:152` github.com/<user>.keys | implicit (TMO-5) |
| `lib/downloads/downloadFromUrl.js:257` checkUrl HEAD | implicit (TMO-5) |
| `lib/downloads/downloadFromUrl.js:279`, `downloadUtils.js:136` image downloads | implicit (TMO-7) |
| `lib/downloads/downloadFromUrl.js:180` dns.lookup | resolv.conf only |

**Sockets, IPC, RPC (backend/src)**

| Call | Timeout |
|---|---|
| `routes/console.js:62` TCP to QEMU VNC on 127.0.0.1 | none; lives with its WebSocket (TMO-17) |
| `lib/mdns/linux/forwarder.js:433,460` upstream DNS; inbound TCP `:521` | 5 s; 6 s idle |
| `lib/mdns/linux/avahi.js` publishing path | 5 s (`bounded`) |
| `lib/mdns/linux/avahi.js:807` ServiceResolverNew, `:862` ServiceBrowserNew, `:997` ResolveHostName, `:1017` ResolveAddress | **none** (the forwarder races the last two at 1.5 s) |
| `lib/containerManager/linux/containerManagerConnection.js:102` callUnary, `:126` callStream (every containerd call) | **none** (some callers race their own: exec 30 s, stop/create polls) |
| libvirt over dbus-next (`lib/vmManager/linux/*`: getProxyObject, DomainLookupByName, GetXMLDesc, DomainDefineXML, Create/Shutdown/Destroy/Reboot, Undefine, stats) | **none** (connect setup races bus failure only) |

**backend/scripts, scripts/**

| Call | Timeout |
|---|---|
| `backend/scripts/wisp-mount:161,253,258,299` mount/umount; `wisp-os-update:99,129,156,169,200,204` apt/pacman; `wisp-nvram:86`; `wisp-netns`, `wisp-bridge`, `wisp-cni` | the caller's execFile timeout (TMO-3) |
| `backend/scripts/wisp-updater:110` health curl | 5 s in a 90 s loop |
| `backend/scripts/wisp-updater:181,185,190` rsync, npm ci | the unit's `TimeoutStartSec=600` |
| `backend/scripts/migrate.mjs:203` manager connections | inherits TMO-8/TMO-11 (TMO-13) |
| `scripts/linux/setup/cni.sh:45`, `containerd.sh:75`, `packages.sh:81` curl | **none** |
| `scripts/vendor-novnc.sh:18` git clone | **none** |
| `scripts/push.sh:66` scp, `:77` ssh | **none** |
| `scripts/linux/setup/cni.sh:72` bridge wait | 30 s |
| apt-get / pacman in `distro.sh`, `packages.sh`, `containerd.sh`; npm in `wispctl.sh:90,101` | the tools' own |

**Frontend**

| Call | Timeout |
|---|---|
| `fe/api/client.js:98` `api()` (every REST call) | **none** (only `shared/ProtectedRoute.jsx:69` passes a signal) |
| `fe/api/auth.js:15`, `fe/store/authStore.js:14` | **none** |
| `fe/api/sse.js:92,104,232,244` SSE | 90 s to headers, then 60 s read watchdog |
| `fe/api/upload.js:14` XHR upload | **none** |
| `fe/components/console/VNCConsole.jsx:190`, `ContainerConsole.jsx:188` WebSocket | no connect timeout |

### Findings

- **TMO-1** — short local tools with no bound: `wispUpdate.js:453`, `cloudInit.js:39`,
  `zot.js:53`, `cloudInit.js:185,192`, `diskOps.js:80,163,267`, `vmManagerDisk.js:140`,
  `vmManagerCreate.js:428`, `vmManagerNvram.js:18`, `containerManagerExec.js:49`,
  `containerManagerMountsContent.js:126`, `wispUpdate.js:365` (bounded-size tarball). *Fix:*
  execFile/spawn `timeout`: 5–15 s for openssl, mkfifo, systemctl; 30–60 s for qemu-img
  info/create/resize, ISO build, NVRAM copy; 120 s for the release tar. — **clear**
  **Fixed:** openssl 10 s; mkfifo 5 s; the updater start 15 s; the zip listing 30 s;
  qemu-img info/resize/create, the ISO build and the NVRAM copy 60 s; the release tar 120
  s.
- **TMO-2** — long, size-dependent work: `qemu-img convert` (`diskOps.js:202`), disk `cp`
  (`vmManagerBackup.js:50`), container backup `tar` (`containerManagerBackup.js:110` — the
  container stays frozen while it runs, `:186`), restore `tar` (`:152`), `xz`
  (`downloadHaos.js:51`), `unzip` extract (`containerManagerMountsContent.js:156`). A fixed cap
  either kills legitimate large jobs or is meaningless. — **decision.** *Recommendation:* a
  no-progress watchdog (kill after N minutes without output growth / byte progress — qemu-img
  `-p`, the byte counter at `containerManagerBackup.js:118`, destination size), no total cap;
  the unzip extract (bounded by the upload cap) gets a generous fixed cap.
  **Fixed:** `storage/stallWatchdog.js` (`createStallWatchdog`): no total cap, killed
  after a stall — convert (output or destination blocks, 10 min), VM backup `cp`
  (destination blocks, 10 min; a stall is not retried through `copyFile`), container
  backup tar (bytes, 5 min), restore tar (GNU checkpoint dots, 10 min), xz (output, 10
  min); the unzip extract a fixed 30 min. Reworked after the 2b review: the unzip extract
  is a job stopped after 5 min without output or bytes read, and a stalled tar is killed
  with its whole process group.
- **TMO-3** — the execFile timeout signals `sudo`, not the worker: children of the bash
  helpers (`apt-get`/`pacman` in `wisp-os-update`, `mount`/`umount` in `wisp-mount`) inherit
  the stdout pipe and keep it open, so the promise can stay pending past its timeout (apt keeps
  its lock). *Fix:* inside the helpers wrap the command in `timeout --kill-after=5 N` or `exec`
  it; settle the JS side on its own timer. To verify on the Linux test host first. — **clear**
  **Fixed:** on tini (sudo-rs with `use_pty`) the JS promise already settled on time, but
  the helper's child was orphaned and kept running. `wisp-mount` bounds mount (20 s) and
  umount (5 s), `wisp-os-update` its read-only apt/pacman steps (100 s) with `timeout
  --kill-after`; the upgrade itself is not bounded (TMO-4). The callers also settle on
  their own timer (timeout + 5 s, SIGKILL) for hosts without `use_pty`.
- **TMO-4** — OS upgrade capped at 600 s (`osUpdates.js:183`); a dist-upgrade can run longer,
  and killing dpkg midway leaves it interrupted. — **decision.** *Recommendation:* replace the
  cap with an apt-output stall watchdog (e.g. 15 min without output), or run the upgrade as
  its own systemd unit as the self-update does.
  **Fixed (reversed after the 2b review):** the upgrade is a server job, stopped after 15 min
  without apt or pacman output, with no total cap. The backlog entry "OS upgrade runs inside
  wisp.service" stays.
- **TMO-5** — small HTTP calls on implicit defaults: `downloadHaos.js:29`,
  `routes/cloudinit.js:152` (holds a request handler up to 300 s), checkUrl
  `downloadFromUrl.js:257`. *Fix:* `AbortSignal.timeout(10–15 s)`. — **clear**
  **Fixed:** the HAOS release lookup 15 s, the GitHub keys fetch 10 s, `checkUrl` 15 s.
- **TMO-6** — `downloadFromUrl.js:106-110` (`makePrivateIPGuardAgent`) relies on implicit
  defaults. *Fix:* set `connectTimeout` (10 s) and `headersTimeout` (30 s) explicitly. —
  **clear**
  **Fixed:** connect 10 s, headers 30 s on the SSRF-guard Agent.
- **TMO-7** — large downloads (`downloadFromUrl.js:279`, `downloadUtils.js:136`,
  `wispUpdate.js:287`) have only the implicit 300 s idle body timeout, no total cap. —
  **decision.** *Recommendation:* explicit idle `bodyTimeout` of 60–120 s, no total cap.
  **Fixed:** body idle 120 s on the same Agent, no total cap.
- **TMO-8** — `containerManagerConnection.js:102,126`: no gRPC deadline on any containerd
  call. *Fix:* default deadline (30 s) in `callUnary`, per-call override; content `read`
  streams through `collectStream` get one too (60 s). — **clear**
  **Fixed:** `callUnary` takes `deadlineMs` (default 30 s; DEADLINE_EXCEEDED names the
  method); content read streams 60 s.
- **TMO-9** — long containerd work: image `transfer` pull (`containerManagerCreate.js:160`;
  callers create, image-update check `containerManagerImageUpdates.js:79`, restore, MCP),
  console `tasks.wait`, the events `subscribe` stream (`containerManagerList.js:230`). —
  **decision.** *Recommendation:* pulls get a generous cap (30 min) or progress-based idle
  detection; `tasks.wait` stays open (bounded by the session); the events stream uses gRPC
  channel keepalive (`grpc.keepalive_time_ms`) instead of an idle timeout.
  **Fixed:** the image pull stopped after 5 min without progress on the transfer's progress
  stream (reworked after the 2b review, first a fixed 30 min); snapshot removal 2 min; `tasks.wait` no deadline;
  channel keepalive every 6 min with a 20 s timeout (containerd's server refuses pings
  more often than 5 min), no pings without an active call.
- **TMO-10** — `avahi.js:807,862,997,1017` unbounded: a hung daemon leaks
  `browseCreationsInFlight` and stalls `reregisterAll` (`await startBrowse`); resolves pile up
  behind the forwarder's race. *Fix:* wrap in `bounded()`; on a browser/resolver creation
  timeout, free a late-arriving path as `createGroup` does. — **clear**
  **Fixed:** ServiceResolverNew and ServiceBrowserNew bounded, a late path freed as
  `createGroup` does; ResolveHostName and ResolveAddress bounded.
- **TMO-11** — libvirt dbus-next reads and defines have no timeout (`vmManagerConnection.js:273,285,304`,
  `vmManagerList.js:47,286`, `vmManagerConfig.js:128,303,385`, `vmManagerDisk.js:96`, stats).
  *Fix:* an avahi-style `bounded()` (30 s) in vmManager. — **clear**
  **Fixed:** every libvirt DBus interface is wrapped in a Proxy that bounds each method
  call (30 s), introspection included, and `connect()`'s setup calls (the `/org/libvirt/QEMU`
  introspection and the `LibVersion` read) are bounded inside their race with the bus failing —
  first left out, caught in the 2b review.
- **TMO-12** — libvirt lifecycle calls (`vmManagerLifecycle.js:14-56` Create, Shutdown,
  Destroy, Reboot; `vmManagerCreate.js:535` Undefine; backup block jobs). — **decision.**
  *Recommendation:* the same bound with a longer value (2 min) — Create of a large VM and
  Undefine with NVRAM are the slow ones; a guest shutdown is already asynchronous in libvirt.
  **Fixed:** Create, Shutdown, Destroy, Reboot, Undefine, Suspend and Resume bounded at 2
  min through the same Proxy.
- **TMO-13** — `backend/scripts/migrate.mjs:203` hangs `install.sh:112`, `common-steps.sh:72`
  and the updater when containerd or libvirtd is wedged. Fixed by TMO-8 and TMO-11. — **clear**
  **Fixed:** follows from TMO-8 and TMO-11 — the runner uses the same managers, whose connect
  setup is bounded too: a wedged libvirt-dbus fails the connect within 60 s at worst, and the
  runner warns and goes on, as with any failed connect.
- **TMO-14** — `scripts/linux/setup/cni.sh:45`, `containerd.sh:75`, `packages.sh:81`: curl
  without bounds; `scripts/vendor-novnc.sh:18` git clone. *Fix:* `--connect-timeout 10
  --max-time 300`; `timeout 120 git clone` (or `http.lowSpeedLimit/Time`). — **clear**
  **Fixed:** setup curls `--connect-timeout 10` and abort under 1 KB/s for 60 s, no total
  (reworked after the 2b review); the noVNC clone uses git's low-speed abort (under 1 KB/s for 60 s), portable to
  the macOS dev machine.
- **TMO-15** — `scripts/push.sh:66,77`: scp/ssh without bounds. *Fix:* `-o ConnectTimeout=10
  -o ServerAliveInterval=15 -o ServerAliveCountMax=4`. — **clear**
  **Fixed:** `push.sh` passes `ConnectTimeout=10`, `ServerAliveInterval=15`,
  `ServerAliveCountMax=4` to scp and ssh.
- **TMO-16** — `fe/api/client.js:98`, `fe/api/auth.js:15`, `fe/store/authStore.js:14`: no
  timeout on REST calls. *Fix:* default `AbortSignal.any([callerSignal, AbortSignal.timeout(30 s)])`;
  long operations are jobs already. — **clear**
  **Fixed, with a different value:** `api()` combines the caller's signal with a 45 s
  deadline; `timeoutMs` per call. The operations that can outlast it (a libvirt start, an
  unmount, an OS upgrade, …) are server jobs observed over SSE (reworked after the 2b
  review). The OIDC status probe 15 s, login 45 s.
- **TMO-17** — long-lived client channels: XHR upload (`fe/api/upload.js:14`), console
  WebSockets (`VNCConsole.jsx:190`, `ContainerConsole.jsx:188`) and the VNC TCP leg
  (`routes/console.js:62`). — **decision.** *Recommendation:* an upload idle watchdog (abort
  after ~60 s without progress); a 10–15 s connect timeout until `open` on both consoles; a
  server-side WebSocket ping (in `be/lib/wsTracking.js`) that also bounds the VNC TCP leg.
  **Fixed:** upload aborts after 60 s without progress, then 35 min for the reply; both
  consoles close a socket not open within 15 s; `trackWebSocket` pings every 30 s and
  terminates a socket that missed the previous ping, which tears down the VNC TCP leg or
  exec session; the VNC TCP connect to QEMU 10 s.

---

## CODING-RULES §7 — import fences, enforced by a lint

The managers are clean: every non-stdlib import in `vmManager/**` and `containerManager/**`
targets the manager's own files or `mdns/`, `networking/`, `storage/` facades; the carved
modules import only `createAppError` from `routeErrors.js`; nothing outside a manager imports
its `linux/` internals; `dbus-next`, `@grpc/grpc-js`, `@grpc/proto-loader` and `protobufjs`
are imported only inside their fences (`vmManager/linux/vmManagerConnection.js:4`,
`vmManagerConfig.js:7`, `vmManagerCreate.js:10`, `mdns/linux/avahi.js:27`,
`containerManager/linux/containerManagerConnection.js:8-10`, `containerManagerLifecycle.js:7`).

- **FEN-1** — no lint enforces any fence: `scripts/check-imports.mjs` checks only that
  relative specifiers resolve; no eslint, no other script. *Fix:* a fence lint with no new
  dependency, reusing check-imports' scanner over `backend/src`, `backend/scripts`,
  `backend/migrations`: a rule table (package fences; strict managers may import `node:*`, their
  own directory and `lib/{mdns,networking,storage}/index.js`; carved modules may import
  `routeErrors.js` for `createAppError` only; any importer outside a facaded module targets its
  `index.js`; darwin stubs count as manager internals), an `EXCEPTIONS` list for reviewed
  one-line allowances, output `file:line specifier — violates … (CODING-RULES §7)`, exit 1. —
  **clear**
  **Fixed:** `scripts/check-fences.mjs` checks package fences, facades, strict managers
  (mdns, networking and storage only — not host) and carved modules, across static
  imports, every literal and template prefix in a dynamic `import()`, and
  `require` / `createRequire`; a computed specifier fails unless `EXCEPTIONS` allows it.
- **FEN-2** — fold the fence check into `check-imports` or add a command. — **decision.**
  *Recommendation:* a sibling `scripts/check-fences.mjs` as `npm run check-fences` (it answers
  a different question and should name §7); add it to AGENTS.md Project Facts, CODING-RULES §14
  and TECH-STACK "Testing & lint".
  **Fixed:** `npm run check-fences`, listed in AGENTS.md Project Facts, CODING-RULES §7
  and §14, and TECH-STACK.
- **FEN-3** — `be/routes/host.js:88` imports `../lib/host/darwin/systemProfilerSoftware.js`
  directly. *Fix:* expose it through `lib/host/index.js` (or fold it into the darwin
  `getHostInfo`). — **clear**
  **Fixed:** `lib/host/index.js` exports `getProfilerSoftwareOverview()` (null on Linux).
- **FEN-4** — glue bypassing a non-manager facade: `be/lib/wispUpdate.js:24-25` imports
  `downloads/downloadFromUrl.js` and `downloads/downloadUtils.js`; `be/lib/homeTiles.js:22`
  imports `containerApps/appRegistry.js` though `containerApps/index.js:35` exports
  `getAppModule`. §7 names only the managers' facades. — **decision.** *Recommendation:* the
  lint enforces every module that has an `index.js` facade (`containerApps/`, `downloads/`,
  `jobs/` as well); fix both imports.
  **Fixed:** the lint enforces every module with an `index.js`; wispUpdate.js and
  homeTiles.js import the facades.
- **FEN-5** — `undici` is imported by `lib/downloads/downloadFromUrl.js:18` and
  `lib/wispUpdate.js:21` (which builds its own `Agent` at `:168-171`); plain `fetch` is used in
  `oidc.js:42`, `downloadHaos.js:29`, `downloadUbuntuCloud.js:54`, `routes/cloudinit.js:152`.
  TECH-STACK frames undici as the SSRF-hardened fetch. — **decision.** *Recommendation:* fence
  `undici` to `lib/downloads/`; route the GitHub API call through a downloads export.
  **Fixed:** undici is fenced to `lib/downloads/`; the GitHub API call goes through
  `ssrfSafeFetch` with a 30 s deadline, so wispUpdate no longer builds its own Agent.
- **FEN-6** — `node:net` / `node:dgram` (`routes/console.js:1`, `mdns/linux/forwarder.js:30-31`,
  `containerManagerExec.js:7`) and `node:child_process` (23 importers) are unfenced. —
  **decision.** *Recommendation:* don't fence them: `child_process` is governed by the §7 exec
  allowlist, and the VNC TCP leg in `routes/console.js` is the console design ARCHITECTURE
  draws.
  **Fixed:** as recommended — the lint fences no Node builtins.
- **FEN-7** — `be/lib/mountsAutoMount.js:26` has a JSDoc type import of
  `./storage/mountTable.js`. — **decision.** *Recommendation:* the lint skips specifiers inside
  comments (type-only imports load nothing).
  **Fixed:** the lint blanks comments before scanning, so JSDoc type imports are skipped.
- **FEN-8** — doc drift: `docs/TECH-STACK.md:15-17` says dbus-next's sole caller is
  `lib/vmManager/` (it is also `mdns/linux/`), and both fences name `lib/<mgr>/` where §7 says
  `lib/<mgr>/linux/`. *Fix:* align with §7. — **clear**
  **Fixed:** TECH-STACK names both dbus-next callers and the `linux/` fences, and
  undici's.

---

## FRONTEND-RULES Data

### Growing collections

Most stores replace their data on each push; few collections grow.

- **DAT-1** — `fe/components/sections/ContainerLogsSection.jsx:9-10,121-124`: log lines capped
  at 5000 (trimmed to 4000), rendered without windowing (`:301`). — **decision.**
  *Recommendation:* keep the cap; window only if phones are seen to lag.
  **Kept:** the 5000-line cap stays, unwindowed (settled).
- **DAT-2** — `fe/components/console/ContainerConsole.jsx:170`: xterm's scrollback is
  bounded only by its default (1000). *Fix:* pass `scrollback` explicitly. — **clear**
  **Fixed:** `scrollback: 1000` is explicit.
- **DAT-3** — `fe/store/workloadActions.js:10-15`: an error entry stays until dismissed, also
  for a workload deleted elsewhere. *Fix:* on each list push, drop entries whose name is gone.
  — **clear**
  **Fixed:** each list frame drops the settled error entries of workloads no longer listed.

Bounded already: background job tray (`fe/store/backgroundJobsStore.js:6,55-76`, 5 min TTL),
`fe/api/events.js:24` (one frame per topic).

### Loading, empty and error states

- **DAT-4** — `fe/components/layout/LeftPanel.jsx:567-571`: no loading or error state —
  "No workloads" shows before the first frame; list error frames are dropped
  (`fe/store/vmStore.js:115`, `containerStore.js:129`). *Fix:* `loaded` + `listError` in both
  stores; skeleton, then an error row with retry. — **clear**
  **Fixed:** both stores keep `listLoaded` and `listError`; the sidebar shows a skeleton, then an error row with retry.
- **DAT-5** — `fe/components/home/HomePanel.jsx:144`: no loading or error state (`homeStore.js:47`
  ignores error frames). *Fix:* skeleton while `!loaded`; store and show the error. — **clear**
  **Fixed:** a skeleton until loaded; the store keeps the error frame and the panel shows it.
- **DAT-6** — `fe/store/containerStore.js:190-191`: a failed `getContainer` keeps the seed config,
  so the body renders empty env/mount/network sections. *Fix:* clear the config on error as the
  VM store does (`vmStore.js:166`). — **clear**
  **Fixed:** a failed select clears the seed config; the panel shows the error.
- **DAT-7** — `fe/components/sections/ContainerLogsSection.jsx:76-77`: a failed runs fetch shows
  "No runs yet". *Fix:* an error state. — **clear**
  **Fixed:** a failed runs fetch is an error state and keeps the runs shown.
- **DAT-8** — `ContainerLogsSection.jsx:117-128,296-299`: "No logs for this run." while
  connecting; the stream's `{ error }` frame (`be/routes/containers.js:691`) is ignored. *Fix:*
  a `streamState` (connecting / error / ready) and handle `data.error`. — **clear**
  **Fixed:** a connecting / ready / error stream state; error frames and a lost stream show.
- **DAT-9** — `fe/components/sections/CloudInitSection.jsx:68-76,282`: no loading state; a fetch
  failure shows "No cloud-init configuration" and **Configure**, inviting an overwrite of a
  real config. *Fix:* `loading` + `loadError`; no Configure on error. — **clear** (highest
  priority)
  **Fixed (first):** loading and load-error states; on error a retry, never Configure.
- **DAT-10** — `fe/components/sections/USBSection.jsx:44`: an attached-devices failure reads as
  "nothing attached"; `:92,158`: "Loading USB devices…" forever if the stream never delivers.
  *Fix:* error states for both. — **clear**
  **Fixed:** attached-devices and stream errors show; the spinner gives way to the stream error.
- **DAT-11** — `fe/components/vm/XMLModal.jsx:74`: the error text renders as the XML body.
  *Fix:* its own error state. — **clear**
  **Fixed:** its own error state; Copy is disabled without XML.
- **DAT-12** — `fe/components/host/HostOverview.jsx:346`, `fe/components/layout/HostStatsBar.jsx:15-18`:
  a stats stream that sends only errors (`fe/store/statsStore.js:20`) spins forever. *Fix:*
  `lastError` in the store; "Stats unavailable". — **clear**
  **Fixed:** `lastError` in the store; "Stats unavailable".
- **DAT-13** — `HostOverview.jsx:884-889`: "Loading…" forever when `getHostInfo` fails; `:875`
  merges loading and empty ("No hardware inventory listed (or still loading)"). *Fix:* separate
  loading / empty / error. — **clear**
  **Fixed:** separate loading, empty and error for the inventory; the software block has an error with retry.
- **DAT-14** — `fe/components/host/HostStorage.jsx:407-411`: "Connecting to device stream…"
  forever if the disk stream fails. *Fix:* show `diskStore` connection errors. — **clear**
  **Fixed:** the disk store keeps stream errors and the section shows them.
- **DAT-15** — `fe/store/settingsStore.js:16`: `error` is set but never rendered
  (`fe/components/layout/AppLayout.jsx:29` swallows the failure); `AppConfig.jsx:78`,
  `HostStorage.jsx:227`, `HostBackup.jsx`, `HostBackupScheduler.jsx`, `OidcSettings.jsx` and the
  storage pickers in `fe/apps/jellyfin/JellyfinAppSection.jsx:89`,
  `fe/apps/tinySamba/TinySambaAppSection.jsx:111` show blank or default forms. *Fix:* a loading
  line while `settings == null` and the store error in each section. — **clear**
  **Fixed:** `SettingsGate` shows loading, or the store error with retry, in each listed section instead of a default form.
- **DAT-16** — `fe/components/settings/ApiTokensSettings.jsx:45-47,168`: "Loading…" forever under
  the error banner. *Fix:* an error row with retry. — **clear**
  **Fixed:** an error row with retry.
- **DAT-17** — a false empty state under an error: `fe/components/backups/BackupsPanel.jsx:173-178,611-613`
  (a failed refetch also wipes a loaded list), `fe/components/library/ImageLibrary.jsx:361-363`,
  `fe/components/host/HostNetworkBridges.jsx:41-42,106-110`,
  `fe/components/sections/ContainerDevicesSection.jsx:36-38,115-117`,
  `fe/apps/jellyfin/JellyfinAppSection.jsx:99,144,313` ("No supported GPU" also while loading).
  *Fix:* keep the previous data on a failed refetch; no empty state when `error`. — **clear**
  **Fixed:** a failed refetch keeps the data; no empty state renders under an error (GPU "checking" while loading).
- **DAT-18** — supporting lookups that fall back silently: bridges → `[]`
  (`VmNetworkInterfacesSection.jsx:69`, `ContainerNetworkSection.jsx:254`), an invented
  `['virbr0']` (`fe/components/vm/CreateVMPanel.jsx:92`), mount usage and status → `[]`
  (`ContainerMountsSection.jsx:143,158`, `HostStorage.jsx:84`), backup destinations → Local
  (`OverviewPanel.jsx:205`, `ContainerOverviewPanel.jsx:194`, `BackupsPanel.jsx:214`), job-tray
  hydration swallowed (`AppLayout.jsx:47`). — **decision.** *Recommendation:* keep the
  fallbacks, add a muted inline "couldn't load …" hint; drop the invented `virbr0`.
  **Fixed as recommended:** the fallbacks stay with a muted "Couldn't load …" hint (`LoadHint`); the invented `virbr0` is gone (an empty source lets the server use its default bridge); the tray says a failed hydration may miss jobs.

---

## FRONTEND-RULES Phones and touch

None found: **16px fields** — every input, select and textarea renders at ≥16px on touch
devices through the unlayered rule at `fe/index.css:249-265`, which beats the `text-xs/sm`
utilities (xterm's helper textarea included). **Pinch zoom** — `frontend/index.html:10` has no
`maximum-scale` / `user-scalable`. **Hover** — Tailwind 4 wraps `hover:` / `group-hover:` in
`@media (hover: hover)` by default (no override in `index.css`), and there are no raw `:hover`
rules or JS hover handlers.

- **TCH-1** — no central focus module and no touch check: 17 `autoFocus` sites
  (`fe/pages/Login.jsx:87`, `LeftPanel.jsx:95`, `home/HomeGroup.jsx:75`, `home/HomeTile.jsx:114`,
  `settings/ApiTokensSettings.jsx:192`, `ContainerLogsSection.jsx:334`, and the modal first
  fields `DiskEditorModal.jsx:229,276`, `NicEditorModal.jsx:103`, `ManualLinkModal.jsx:91`,
  `SecretMountContentModal.jsx:111`, `EnvVarEditorModal.jsx:189`,
  `ContainerMountEditorModal.jsx:297`, `SmbShareEditorModal.jsx:185`,
  `RemovableDriveEditorModal.jsx:166`, `BridgeCreateModal.jsx:119`,
  `apps/jellyfin/JellyfinLibraryEditorModal.jsx:88`) and 2 `.focus()` calls
  (`library/ImageLibrary.jsx:172`, `shared/IconPickerModal.jsx:20` — pops the keyboard when the
  icon picker opens on a phone). FRONTEND-RULES § Modal form editor itself prescribes "First
  field gets `autoFocus`". *Fix:* `fe/lib/focus.js` (`focusField`, `useAutoFocus`) that does
  nothing on touch; route every site through it; reword the FRONTEND-RULES line. — **clear**
  **Fixed:** `lib/focus.js` (`focusField`, `focusElement`, `autoFocusField`); every site goes through it; the FRONTEND-RULES line is reworded.
- **TCH-2** — how the focus module detects touch. — **decision.** *Recommendation:*
  `matchMedia('(hover: none) and (pointer: coarse)')`, the same query as the 16px rule, so the
  two agree; focusing a non-field element (a dialog container) stays unconditional.
  **Settled as recommended:** the 16px rule's query; non-field focus stays unconditional.
- **TCH-3** — hover-revealed row actions are invisible on a touch device ≥1024px (iPad
  landscape): `lg:opacity-0` hides them unconditionally while the `group-hover` that reveals them
  is hover-gated — `fe/components/vm/VMListItem.jsx:83`, `container/ContainerListItem.jsx:82`
  (`shared/DataTableChrome.jsx:121` at least adds `group-focus-within`). *Fix:* a
  `@custom-variant hoverable (@media (hover: hover))` and `hoverable:lg:opacity-0`. — **clear**
  **Fixed:** a `hoverable` variant; the reveal applies only under `(hover: hover)`, and the list rows also reveal on focus-within.
- **TCH-4** — tap targets that don't grow at phone widths: `p-0.5` (~19px) at
  `LeftPanel.jsx:108,117,135,145,155,165`, `HomeTile.jsx:127,136`, `ImageLibrary.jsx:206,209`;
  `p-1` (~22–24px) at `sidebar/SectionPickerButton.jsx:72`, `shared/Modal.jsx:117` (close X),
  `ApiTokensSettings.jsx:142`, `ContainerNetworkSection.jsx:520`, `host/HostMgmt.jsx:19`,
  `ContainerOverviewPanel.jsx:328`; `p-1.5` with no step at `layout/TopBar.jsx:62`,
  `layout/ThemeToggle.jsx:22`, `ContainerLogsSection.jsx:226,248,257,267`. *Fix:* `p-2 lg:p-…`
  as the row actions already do (`DataTableChrome.jsx:105-113`), or a shared `iconBtn` token.
  — **clear**
  **Fixed:** `p-2` at phone widths, the old padding from `lg`.
- **TCH-5** — the 16px rule keys on `pointer: coarse`, so an iPad with a trackpad
  (`pointer: fine`) still zooms on small fields. — **decision.** *Recommendation:* accept; the
  rule targets phones.
  **Accepted** (settled).

Minor, for the backlog rather than this feature: `fe/components/shared/HelpIcon.jsx:10` relies
on `title`, which never shows on touch.

---

## FRONTEND-RULES Layers

- **LAY-1** — `fe/components/shared/Modal.jsx:91-100`: the page under a modal is not inert,
  Tab isn't kept inside, focus isn't returned to the opener on close, and there is no
  `role="dialog"` / `aria-modal` / `aria-labelledby`. ConfirmDialog and AlertDialog
  (`shared/ConfirmDialog.jsx:24`, `shared/AlertDialog.jsx:29`) inherit all of it. *Fix:* see
  LAY-3. — **clear**
  **Fixed:** see LAY-3; the card is a `role="dialog"` `aria-modal` named by its title.
- **LAY-2** — Esc closes every open layer, not only the top one: `fe/hooks/useEscapeKey.js:11-20`
  adds a bubble-phase listener per modal with no stack; nesting works only by the parent's
  `closeOnEscape={false}` convention. Broken cases: `home/ManualLinkModal.jsx:68` with
  `IconPickerModal` open (`:126`) — one Esc closes both; the rename input's Esc in
  `library/ImageLibrary.jsx:202` also closes the enclosing ImageLibraryModal; the phone drawer
  (`layout/LeftPanel.jsx:367-374`) closes together with the ConfirmDialog / AlertDialogs opened
  from it (`:177,185,643`); every popover's Esc also reaches the drawer or the VM/container
  route's Esc handler (`vm/VmRoute.jsx:29`, `container/ContainerRoute.jsx:31`). *Fix:* one layer
  stack (LAY-3). — **clear**
  **Fixed:** one stack; inline editors claim their Escape with `preventDefault()`; route handlers stand down while a layer is open.
- **LAY-3** — how to implement inert / Tab trap / focus return / top-layer Esc without a
  library. — **decision.** *Recommendation:* a small `fe/lib/layers.js`: a module-level stack
  every modal, drawer and popover pushes onto; one capture-phase Escape handler closes only the
  top layer (the `closeOnEscape={false}` convention goes); modals render through a portal into
  `document.body` and set `inert` on `#root` while any is open; a Tab / Shift+Tab wrap over the
  card's focusables; the opener (`document.activeElement`) is saved on open and refocused on close
  through the TCH-1 focus module. Rejected alternative to weigh: native
  `<dialog>.showModal()` gives inert, trap, top layer and Esc for free but changes how the
  backdrop and stacking are styled, and doesn't cover the drawer or popovers.
  **Fixed as recommended:** `lib/layers.js` (window-level Escape after the target's handlers, Tab wrap, `inert` on `#root` and lower layers, opener refocused through the focus module); modals render in a portal.
- **LAY-4** — modals close on a click that starts and ends on the backdrop
  (`shared/Modal.jsx:75-85,92-93`), the `[PROJECT]` exception to "never dismiss a modal on a
  click beside it". — **decision.** *Recommendation:* bring the modals to the rule — drop
  backdrop close (Esc, Cancel and the X stay), remove `closeOnBackdrop`, the `[PROJECT]` note in
  FRONTEND-RULES § Layers and its backlog mention; a stray click can't discard a form's edits.
  **Fixed as recommended:** no backdrop close; `closeOnBackdrop` and the `[PROJECT]` note are gone, and so is the backlog mention.
- **LAY-5** — the phone sidebar drawer (`layout/LeftPanel.jsx:458-468`) is an ad-hoc overlay:
  not on any stack, no inert, no focus move/trap/return. *Fix:* it joins the LAY-3 stack. —
  **clear**
  **Fixed:** below `lg` the drawer is a layer: Escape, Tab kept inside, the page beside it inert, focus back to the menu button.
- **LAY-6** — popovers (`sidebar/SectionPickerButton.jsx:21-34`, `home/TileGroupPicker.jsx:20-32`,
  `layout/ServerSwitcher.jsx:41-55`, `library/PresetImageDownloadMenu.jsx:19-33`,
  `layout/BackgroundJobsIndicator.jsx:55-62` — the last has no Esc at all) neither move nor
  return focus and aren't on a stack. *Fix:* join the LAY-3 stack; outside-click on
  `pointerdown`. — **clear**
  **Fixed:** `lib/popover.js` (layer, outside `pointerdown`, focus in and back); the jobs tray gets Escape.
- **LAY-7** — no popover is clamped to the viewport: `SectionPickerButton.jsx:81` (`right-0
  top-full w-44`), `TileGroupPicker.jsx:79` (`left-0 bottom-full w-44` — spills off the right
  edge for a right-column tile on a phone), `ServerSwitcher.jsx:80`,
  `PresetImageDownloadMenu.jsx:54`, `BackgroundJobsIndicator.jsx:90` (width capped, position
  not); none flips near the bottom. — **clear**
  **Fixed:** see LAY-8.
- **LAY-8** — how to clamp. — **decision.** *Recommendation:* a shared
  `useClampToViewport(anchorRef, popRef)` that measures in a layout effect and shifts or flips,
  with the popover in a portal (which also escapes the sidebar's overflow clipping). CSS anchor
  positioning (`position-try`) is the no-JS alternative where the target browsers support it.
  **Fixed as recommended:** `useClampToViewport` measures in a layout effect, flips above or below, clamps both axes, in a portal.
