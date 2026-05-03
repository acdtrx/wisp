# Changelog

## 2026-05-03

### Refactor
- **Networking module carved out of the flat `lib/` surface** — new `lib/networking/` (facade, `bridgeNaming`, plus `linux/{hostBridges,managedBridges}` and `darwin/` stubs). Removes the only true `containerManager` → `vmManager` cross-import (`getDefaultContainerParentBridge`); `listHostBridges` and `getDefaultBridge` follow as cohesive siblings. Step 1 of the modules-boundaries refactor campaign.
- **mDNS module carved out** — new `lib/mdns/` (facade `index.js`, platform-agnostic `hostname.js` + `serviceTypes.js`, `linux/{avahi,forwarder}.js`, `darwin/avahi.js`). Replaces the flat `mdnsManager.js`/`mdnsHostname.js`/`linux/mdnsForwarder.js`/`linux/mdnsServiceTypes.js` constellation with one named module + one facade. `vmMdnsPublisher` and `containerMdnsReconciler` stay at `lib/` top-level as Wisp app-level glue (codified in `WISP-RULES.md` § Architecture: glue between extractable modules is intentionally outside both modules to keep them independently reusable). Step 2 of the modules-boundaries refactor campaign.

## 2026-05-03 (v1.2.0)

### New Features
- **Container backup + restore** — single `data.tar.gz` of the container directory plus a `manifest.json` sidecar under `<dest>/containers/<name>/<ts>/`. Restore extracts under a new name, rewrites `container.json` with a fresh MAC, re-pulls the image if missing, and recreates the containerd record (snapshot re-prepares on first start; rootfs is ephemeral by design). New `POST /api/containers/:name/backup` + progress SSE, plus `/api/container-backups` (list/restore/delete) parallel to `/api/backups`. `BackupModal` moves to `shared/` and is reused for VMs and containers via a `subjectLabel` prop.
- **Container rename** — stopped containers can be renamed by editing the Name field in General. `PATCH /api/containers/:name` runs `renameContainer` first (Containers.Delete+Create, `fs.rename`, snapshot drop, section assignment move, mDNS/netns cleanup), then applies the rest of the patch under the new name.
- **Host Software: OS package list + restart-now** — Wisp and OS update cards share a single `UpdateCard` shell (Check/Update buttons, count badge, unified status row, "Checked hourly" footer) and a single `UpdateDetailsModal`. OS card adds "View packages" (new `wisp-os-update list` action + `GET /api/host/updates/packages`) and a "Restart now" button on the reboot-required banner that opens the existing host Restart dialog.

### Bug Fixes
- **CNI default route detection in setup** — `cni.sh` ran immediately after `bridge.sh`, but `netplan apply` only swaps the default route to br0 *after* DHCP. Detection failed and the script bailed before writing the conflist + `cni-dhcp.service`, so fresh installs silently shipped without DHCP IPAM and containers came up with no IP. Now polls up to 30s for the default route to land on a Linux bridge.
- **VM list cache stale on mutate** — refresh directly on `createVM` / `cloneVM` / `deleteVM` (mirrors containerManager). The libvirt `DomainEvent` listener stays as a secondary trigger but was dropping `DEFINED` often enough that newly created VMs stayed out of the LeftBar until manual page refresh.
- **VM guest IP skipped real DHCP address** — guest agent's interface list could surface a 169.254.x.x (e.g. Wisp's own mDNS stub on br0 when Wisp is installed inside the VM) before the real DHCP address. Skip `169.254/16` for IPv4 and `fe80::/10` for IPv6 when picking `guestIp`.
- **Software-tab badge: inline + folded** — moved from absolute corner to inline-right of the label (matches the Host row in the sidebar) and folded reboot-required into the same dot. Tooltip joins all active reasons (Wisp update / N OS packages / Reboot required).

### Refactor
- **Shared modal primitives** — `Modal` / `AlertDialog` so backdrop, escape, and styling stop drifting per call site. Replaces native `alert` / `confirm` in section sidebar flows. Row Save buttons now use a primary variant so the commit affordance reads at a glance like the header add buttons.
- **Dropped unused `sectionId` decoration from list APIs** — `/api/vms`, `/api/containers`, and both list SSE streams. The LeftPanel never read it (it always bucketed from `sectionsStore`); the misleading "overlay" comment that implied optimistic UI is rewritten to reflect reality.
- **Single-commit releases** — `scripts/release.sh` now accepts `CHANGELOG.md` as the only dirty file in the working tree and folds it into the `release: vX.Y.Z` commit alongside the version bumps + retitling. No more separate "update CHANGELOG" commit.

### Docs
- **`CLAUDE.md`: self-update mechanism wired into project rules** — `UPDATES.md` added to the Docs and Spec Sync table; new Deployability bullet enumerating the `wisp-updater` contract (rsync excludes, helper registration, `wisp.service` re-templating, on-disk shape compatibility, release tarball contents) so future sessions consider it when changing install layout, persisted state, or privileged helpers.

## 2026-05-01 (v1.1.0)

### Breaking Changes
- **Frontend Node server merged into the backend.** Wisp now runs as a single systemd unit (`wisp.service`) on a single port (`WISP_PORT`, default 8080). The separate `wisp-frontend.service` and the `WISP_BACKEND_PORT` / `WISP_FRONTEND_PORT` env vars are gone. **Upgrades from 1.0.x are not handled by the in-app updater — manual reinstall is required.**

  On each existing host:
  ```bash
  # 1. Stop and remove the old units
  sudo systemctl stop wisp-backend wisp-frontend
  sudo systemctl disable wisp-backend wisp-frontend
  sudo rm /etc/systemd/system/wisp-backend.service /etc/systemd/system/wisp-frontend.service
  sudo systemctl daemon-reload

  # 2. Update runtime.env if present — replace WISP_BACKEND_PORT and
  #    WISP_FRONTEND_PORT with a single WISP_PORT=8080 (or delete the file
  #    to fall back to defaults).
  sudo -u <deploy-user> nano /opt/wisp/config/runtime.env

  # 3. Reinstall from the v1.1.0 release tarball (or via push.sh)
  ./scripts/install.sh /opt/wisp --restart-svc
  ```
  After reinstall: `systemctl status wisp` should be active; nothing listens on the old backend port.

### Refactor
- **Single Node process serves both API and SPA.** Backend gains `@fastify/static` (serves `frontend/dist` + `/vendor/` for noVNC), CSP/security headers (`onSend` hook), and a SPA fallback (`setNotFoundHandler` returns `index.html` for non-`/api` / non-`/ws` paths so client-side routing survives deep-link refresh). Auth hook bypasses non-API/WS paths so the bundle and login page load without a session. The `frontend/server.js` reverse-proxy + http-proxy + 503-when-backend-down shim is gone — same machine, no loopback hop, one event loop, one log stream.
- **Release tarball trimmed.** `frontend/` ships only `dist/` + `public/` (the static-serve payload); no `package.json`, lockfile, or runtime code. `wisp-updater` no longer runs `npm ci` in `frontend/`.
- **`wispctl` collapsed to single-unit:** `local logs` and `svc logs` no longer take a `[backend|frontend|all]` argument; `local start/stop/status` operate on one process; `svc install/uninstall/start/stop/restart` operate on `wisp.service`.

## 2026-05-01 (v1.0.12)

### Refactor
- **Frontend bundle: split `node_modules` into a `vendor` chunk + lazy-load `WispUpdateSection`** — main bundle dropped from 578 kB to 258 kB (gzip 161 → 62 kB) and the chunk-size-warning noise is gone. Heavy lazy-only deps (`react-markdown` for release notes, `@xterm/*` for the console) deliberately stay out of `vendor` so they only ship when the user opens that view; `vendor` (react + router + zustand + lucide-react ≈ 200 kB) caches across most releases.

## 2026-05-01 (v1.0.11)

### Refactor
- **Self-update: own systemd unit (`wisp-updater.service`)** — stop trying to make a process that's about to die orchestrate its own replacement. The applier is now a `Type=oneshot` unit triggered by the backend via `sudo -n systemctl start --no-block wisp-updater.service`. Lives in its own cgroup, with its own journald-attached stdio — when it stops `wisp-backend.service` as its first real step, nothing connecting the two breaks. Sidesteps every failure mode the v1.0.6→v1.0.10 series chased (cgroup teardown, scope slice, SIGPIPE, `exec >/dev/null`, mysterious post-stop hang).
- **Hand-off contract:** backend writes the staging path to `/var/lib/wisp/updates/target` (atomic via `rename(2)`); the unit's `WISP_INSTALL_DIR` env (templated at install time) provides the install dir — staging path is validated to start with `/var/lib/wisp/updates/staging-`.
- **Sudoers:** `<deploy-user> ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block wisp-updater.service` (argv exact-match). Same blast radius as the previous `wisp-update <staging> <install>` rule but tighter: install dir is hardcoded at install time, deploy user can no longer point an update at an arbitrary path.
- **Code shrinkage:** dropped the `systemd-run --scope --slice=system.slice` re-exec block, the `trap '' PIPE`, the `exec >/dev/null 2>&1` after stop-services, the `systemd-cat`-mirroring `log()`/`logerr()` helpers, the `WISP_UPDATE_DETACHED` re-entry, the cgroup-self-detect log line, and Node's `detached: true / unref / stdio: 'ignore'` spawn. `applyUpdate()` is ~15 lines.
- **Renames:** `backend/scripts/wisp-update` → `backend/scripts/wisp-updater`; `/usr/local/bin/wisp-update` → `/usr/local/bin/wisp-updater`. `install-helpers.sh` removes the obsolete files on next run.
- **Migration note for existing v1.0.10 installs:** the v1.0.10 in-app updater is the broken one, so it cannot bootstrap v1.0.11. Refresh helpers manually first — `./scripts/wispctl.sh helpers` from a checked-out repo, or `./scripts/push.sh user@server /opt/wisp` — to land the new unit + sudoers + script. Subsequent self-updates work normally.

### Bug Fixes
- **`push.sh` was shipping a partial install tree** — `package.sh` zipped only `frontend/`, `backend/`, `scripts/`, `systemd/`, `config/*.example`, and `copy.sh` only copied that same set, so root `package.json` (and `CHANGELOG.md`, `LICENSE`, `README.md`, `CLAUDE.md`, `docs/`) never landed on the target. The user-visible symptom: `wispUpdate.js`'s `getCurrentVersion()` reads `<install>/package.json` first; missing it, the install silently misreported its version from `backend/package.json`. Aligned both with the GitHub release tarball — push.sh now installs the same file set that self-update lays down.
- **README Installation:** swapped the "clone the repo" path for the recommended user flow — grab the latest release tarball (prebuilt `frontend/dist/` shipped, no Node build on the install host), extract, run `./scripts/install.sh /opt/wisp --restart-svc`. The clone path is documented separately as the dev workflow.

## 2026-05-01 (v1.0.10)

### Refactor
- **Self-update: detach the helper, drop SSE, poll for completion** — five sequential fixes (cgroup detach, slice pinning, SIGPIPE trap, stdio-to-/dev/null, atomic-rename of running script) landed correctly but in-app installs still hung in some unidentified corner of the bash↔sudo↔scope process tree (manual invocation worked since v1.0.8). Switched architecture: backend spawns the helper with `detached: true, stdio: 'ignore'` and returns 202 immediately; UI polls `GET /api/host wispVersion` every 5 s until it matches the target, then reloads. After 12 failed polls (1 min) it surfaces "may be slow"; after 60 polls (5 min) it tells the user to check `sudo journalctl -t wisp-update`. Removed `wispUpdateJobStore`, the WISP_UPDATE job kind, the `/api/updates/progress/:jobId` SSE route, and all stdout parsing on the backend. Helper itself keeps all its hardening — useful for direct-from-terminal operator runs

## 2026-05-01 (v1.0.9)

### Bug Fixes
- **Release tarball missed `frontend/loadRuntimeEnv.js`**: workflow used a selective allowlist that listed only server.js + package.json; the runtime sibling import was silently omitted. Frontend service crash-looped with `ERR_MODULE_NOT_FOUND` after self-update. Switched workflow to exclusion-based rsync (mirrors backend) so any new runtime file at `frontend/` root is auto-included
- **Self-update: SIGPIPE killed the helper one step after backend died** — `systemctl stop wisp-backend` (run by the helper) closed the read-ends of the helper's stdio pipes, so the next `printf` SIGPIPE'd bash. EXIT trap fired but rollback's stderr write SIGPIPE'd too — services stayed dead. Trap PIPE up front and `exec >/dev/null 2>&1` after stop-services; journald via `systemd-cat` is now the only output channel past that point
- **Self-update: install-helpers.sh corrupted the running wisp-update file** — `cp src dst` rewrites dst in place under any currently-running process. install-helpers loops over every `wisp-*` helper and re-installs it, including wisp-update — and that wisp-update *was* the script we were running. Bash reads scripts line-by-line; the in-place overwrite caused a silent non-zero exit a few lines later with no `fail` message. `helper.sh` now writes to a temp file then `mv -f` (rename(2) — old inode stays open for running processes, new invocations pick up the new file)

## 2026-05-01 (v1.0.8)

### Bug Fixes
- **Self-update helper STILL killed by parent stop in v1.0.7**: re-exec into `systemd-run --scope` worked but the new scope was placed under `wisp-backend.service`'s cgroup tree by default, so `KillMode=control-group` on the parent stop tore it down anyway. Pinned the scope to `system.slice` (sibling of `wisp-backend.service`) so the parent stop can't reach it. Also mirrored every step:* to journald via `systemd-cat` and logged the actual cgroup the helper landed in, so post-mortems are no longer two opaque "Started/Deactivated" lines. v1.0.7 → v1.0.8 self-update on existing installs needs `/usr/local/bin/wisp-update` refreshed manually first (`wispctl helpers` or `push.sh`); the v1.0.7 helper is the still-broken one

## 2026-05-01 (v1.0.7)

### New Features
- **Sidebar Host-row dot now also lights for Wisp updates**, not only OS package updates. Same amber dot, single tooltip that names whichever signal(s) are firing
- **Release notes render as Markdown** in Wisp Update via `react-markdown` + `@tailwindcss/typography`; long notes still scroll inside the section
- Release workflow bumped to `actions/checkout@v6` + `actions/setup-node@v6` to drop the Node-20 deprecation warnings

### Bug Fixes
- **Self-update helper killed before it could snapshot**: `wisp-update` ran inside `wisp-backend.service`'s cgroup, so its first real step (`systemctl stop wisp-backend`) SIGTERM'd itself via systemd's default `KillMode=control-group`. Helper now re-execs inside a transient `systemd-run --scope` so PID 1 owns it and the stop step no longer affects it. v1.0.6 → any-newer self-update on existing installs requires manually refreshing `/usr/local/bin/wisp-update` first (`wispctl helpers` or a fresh `push.sh`)

## 2026-05-01 (v1.0.6)

### New Features
- **Self-update from GitHub Releases** — Host → Software → **Wisp Update** section: hourly check + manual button + Install button that downloads, verifies (SHA256), atomic-swaps via the new privileged `wisp-update` helper, and restarts services. The Software-tab dot also lights up for Wisp updates. Releases are produced by `.github/workflows/release.yml` on `v*` tag push (prebuilt frontend in the tarball) and tagged via `scripts/release.sh <version>`. One-deep rollback in `<install>.prev/`. Override repo with `WISP_UPDATE_REPO=` for forks. New `/api/updates/{status,check,install,progress/:jobId}` routes; `wispUpdate` field added to host stats SSE. See `docs/spec/UPDATES.md`

### Bug Fixes
- **Ubuntu 26.04 install — `qemu-kvm` package no longer exists**: replaced with `qemu-system-x86` in `packages.sh`. The transitional `qemu-kvm` was dropped in 24.04; on 26.04 the missing package made the entire apt batch fail atomically, cascading into the libvirt/groups/dirs/libvirtd failures
- **Ubuntu 22.04+ setup hang on package install**: `needrestart` silently popped an interactive service-restart menu after the libvirt install even with `apt-get -y -qq`. Suppressed via `NEEDRESTART_MODE=a` + `NEEDRESTART_SUSPEND=1` + `DEBIAN_FRONTEND=noninteractive` exports at the top of `packages.sh`
- **`sudo -E` rejected by Ubuntu 26.04 sudo**: `install.sh` used it only to smuggle `WISP_SKIP_BRIDGE=1`; replaced with a `--skip-bridge` CLI flag on `setup-server.sh`
- **libvirt modular-daemon support**: `libvirt.sh` now socket-activates `virtqemud` + `virtnetworkd` + `virtstoraged` + `virtproxyd` + sidecars on distros that ship modular daemons (Fedora 35+, recent Arch). Ubuntu 26.04 still packages libvirt monolithically so the existing `libvirtd.service` path is preserved. `wisp-backend.service` `After=` now lists both unit names
- **Login redirected back to /login on LAN-HTTP installs**: the cookie's `Secure` flag was hardcoded to `NODE_ENV !== 'development'`, but browsers silently drop `Secure` cookies received over plain HTTP for non-`localhost` origins — login returned 200 + `Set-Cookie`, the cookie never persisted, the next API call 401'd, the SPA bounced to /login. Now derived from `request.protocol` with `trustProxy: ['127.0.0.1', '::1']` on backend + frontend, and the frontend proxy injects `X-Forwarded-Proto`/`X-Forwarded-Host`/`X-Forwarded-For` on the `/api` hop. HTTP-on-LAN works; an HTTPS-terminating reverse proxy in front still triggers `Secure` correctly via the forwarded scheme

## 2026-05-01 (v1.0.5)

### New Features
- **Sidebar sections** — group VMs and containers in the left panel under user-defined sections. Synthetic Main section holds unassigned workloads; new workloads default to Main. Persisted in `wisp-config.json` (`sections[]` + `assignments` map). New `/api/sections` routes (GET/POST/PATCH/DELETE/PUT assign); `sectionId` added to VM and container list payloads (REST + SSE)
- **Organize mode** — single full-width toggle at the bottom of the sidebar that swaps each workload's start/stop actions for a Move-to-section picker, suppresses row click navigation, and enables drag-and-drop of rows onto whole section blocks. Section headers gain inline up/down reorder, rename, and delete affordances while organizing (Main stays pinned to the top). A dashed **Create Section** ghost zone at the bottom of the list and a **+ New section…** entry in the move-to picker both mint a new section by routing through the same `createAndAssign` flow (default-named, auto-rename input opens). New `POST /api/sections/reorder` endpoint takes a full-list permutation
- **Sign out moved to the top bar** as an icon-only button to the right of the background-jobs indicator
- **Background-jobs indicator now always visible** in the top bar — dimmed and non-interactive when no jobs exist, badge + dropdown otherwise

## 2026-04-30

### New Features
- **Container GPU passthrough** — generic `devices: [{ type, device }]` field on `container.json` exposes a host character device into the container. v1 supports Intel + AMD DRM render nodes (`/dev/dri/renderD<N>`); NVIDIA needs CDI and is not implemented. OCI spec emits `linux.devices`, the matching cgroup v2 allow rule, and pushes the host `render` GID onto `process.user.additionalGids` so the in-container process can open the `0660 root:render` node. The host kernel driver still owns the device — this is not VFIO-style PCI passthrough; multiple containers and the host share the GPU concurrently
- New `GET /api/host/gpus` enumerates supported render nodes via sysfs (vendor, PCI slot, model); NVIDIA filtered at the source so users can't pick an unsupported GPU. macOS stub returns `[]`
- New **Devices** section in Container Overview — vendor-labelled picker; icon-only confirm/cancel matching the Mounts pattern; "device not present on host" warning when the configured node disappears (e.g. driver pull, hardware change). Restart required on every change
- Pre-start hard-fail: `CONTAINER_DEVICE_MISSING` (503) when the configured device path is absent or not a chardev — symmetric to `assertBindSourcesReady` for Storage mounts. Avoids silently disabling acceleration for users who configured an app to use it
- App modules opt into device passthrough by returning `derived.devices` from `generateDerivedConfig` (same plumbing as `derived.env` / `derived.mounts`); generic Devices section and app-driven devices share one config path
- **Jellyfin container app** — wraps `jellyfin/jellyfin:latest` with managed `/config` + `/cache` Local mounts, optional Storage-backed `/media` library (any wisp Storage source + sub-path), and a Hardware acceleration toggle that auto-picks the first available host GPU. Runs as the wisp deploy user (no `runAsRoot`) — Local mount auto-ownership and the new render-group `additionalGids` cover the cases that traditionally drove people to root with raw Docker. `_http._tcp` mDNS service seeded at create so `<name>.local` is discoverable out of the box. User still enables hardware acceleration inside Jellyfin's Dashboard → Playback after first start

### Bug Fixes
- Container stats SSE: containerd returns `Tasks.Metrics` as a binary-proto `google.protobuf.Any`; `unpackAny` only handled JSON, so decoding silently failed and the status bar always read 0%. Register the cgroup v1 / v2 `Metrics` proto types and dispatch in `unpackAny` on `type_url`, with JSON as a fallback for non-proto Anys
- VM console **Paste** button: QEMU's built-in VNC has no clipboard bridge to the guest, so the standard cut-text path (`clipboardPasteFrom`) silently went nowhere. Replaced with keystroke synthesis via `rfb.sendKey` — works in any guest. US keyboard / ASCII; uppercase and shifted symbols wrapped in Shift_L; `\n`/`\r` → Enter, `\t` → Tab
- Host stats SSE no longer hammers libvirt: `getRunningVMAllocations()` was issuing one `GetXMLDesc` per running domain every 3 s just to re-read static vCPU/memory config, driving constant `libvirt-dbus` CPU that scaled with VM count whenever the web UI was open. Aggregated from the existing event-driven `vmListCache` instead — zero DBus traffic per tick; the cache still refreshes on every libvirt `DomainEvent`
- Per-VM stats SSE (`/api/vms/:name/stats`) dropped its per-tick `GetXMLDesc(0)`: the only fields it pulled from the parsed XML — vCPU count, guest-agent presence, localDns — are static and now come from `vmListCache` via new `getCachedVcpus`/`getCachedGuestAgent` helpers (`localDns` was already cached). `guestAgent: boolean` added to the cached entry shape
- Per-VM stats SSE: per-domain proxy cache (`connectionState.domainProxyCache`) so `getDomainObjAndIface` no longer triggers a DBus `Introspect` round-trip on every tick — libvirtd was regenerating the domain interface XML for every getProxyObject call. Cache invalidated on bus disconnect and on `VIR_DOMAIN_EVENT_UNDEFINED` so redefined domains get a fresh proxy
- Per-VM stats SSE: fast-path for non-running VMs via new `getCachedStateCode(name)` — the handler now returns the stopped payload with **zero DBus calls** when the cached state is shutoff/crashed/etc., so opening a stopped VM's page no longer drives any libvirt traffic. The cache is refreshed on every `DomainEvent`, so the moment the VM starts the next tick takes the live path
- Per-VM stats SSE: dropped `DomainLookupByName` and `GetState` from the running-VM hot path. The domain path is now captured during cache population (added `domainPath` to the cached entry shape, exposed via `getCachedDomainPath(name)`); state is read from the existing `getCachedStateCode(name)` (kept current by `DomainEvent`). On a running VM with no guest agent, the entire 3 s tick is a single `GetStats` round-trip
- Per-VM stats SSE: 30 s TTL cache (`guestInfoCache`) around the qemu-ga `InterfaceAddresses` / `GetHostname` calls. These hit libvirtd → virtio-serial → guest agent process inside the VM and were the heaviest per-tick cost; the data they return (primary IP, hostname) only changes on DHCP renewal or guest reconfiguration, so 9 in 10 ticks now read from cache. Entries are dropped when the cached state turns non-running so a stop/start cycle always re-fetches from the live agent
- Per-VM stats SSE: `GetStats` now passes a narrowed bitmask (`VM_STATS_MASK = CPU_TOTAL | VCPU | INTERFACE | BLOCK = 58`) instead of `0` (default set). Drops `BALLOON` — which forces libvirtd to query the qemu monitor socket for memory-balloon driver state every tick — and `STATE`, neither of which were consumed. Added the relevant `virDomainStatsTypes` constants to `libvirtConstants.js`
- Stats SSE tick interval bumped from 3 s to 5 s on both `/api/stats` and `/api/vms/:name/stats`. Disk/net throughput pills are smoothed averages so the slower update is barely perceptible; libvirtd CPU when the UI is open drops by ~40% on top of the per-tick savings above. Doc references updated (`docs/spec/HOST-MONITORING.md`, `docs/spec/API.md`, `docs/spec/UI.md`)

## 2026-04-29

### New Features
- **Tiny Samba container app** — declarative SMB file server. Server / Users / Shares form UI; per-share host source picker (Local container files or any wisp storage mount + sub-path); per-user RW/RO access dropdowns; Apple-extensions toggle. Live reload via `tiny-samba reload`; restart required only for server-level changes or when the share mount layout changes
- App registry gains two flags: `requiresRoot: true` (auto-sets `runAsRoot` at create) and `defaultServices: [...]` (seeds `container.services[]` at create so `<container>.local` advertises the right mDNS records out of the box, e.g. `_smb._tcp` for tiny-samba)
- App modules can export `requiresRestartForChange(oldAppConfig, newAppConfig)` to mark specific changes as restart-only; backend ORs that with a structural mount-layout-changed check so adding/retargeting a bind mount on a running app container always triggers `pendingRestart`
- App `getDefaultAppConfig(ctx)` and `validateAppConfig(new, old)` now receive context — `containerName` for sensible defaults, prior config for merging unchanged secrets forward
- Single-line `pino-pretty` log output in dev (`NODE_ENV=development`); production keeps default Pino JSON
- Atomic JSON writes for `wisp-config.json`, `container.json`, and `oci-image-meta.json` (stage to `*.tmp.<pid>.<ts>.<rand>`, fsync, rename); orphan temp files cleaned at backend startup
- **JWT moved to HttpOnly cookies** with double-submit CSRF (`wisp_session` HttpOnly + `wisp_csrf` non-HttpOnly, `SameSite=Lax`, 24 h). `Authorization: Bearer …` and `?token=…` paths removed; frontend stops touching `localStorage` for auth. New `POST /api/auth/logout` endpoint and a Sign out button at the bottom of the left panel. Multi-tab logout via a `wisp_logout` localStorage signal
- Container start auto-pulls the image if it was removed under us (`ctr -n wisp image rm`); container mDNS reconciler refreshes the `<container>.local` A record every 60 s so DHCP-renewal IP changes don't strand a stale record
- 5-minute periodic retry for SMB auto-mounts that failed at boot (server unreachable / NIC up later)
- USB section: warning row when an attached host device disappears (no auto-detach — operator decides what to do with the stale `<hostdev>`)

### Bug Fixes (audit campaign — see `docs/review/2026-04-28/`)
- Backup `POST /api/vms/:name/backup`: dropped the unrestricted `destinationPaths` body field; require `destinationIds` (closed a write-anywhere primitive that combined with prior path-traversals)
- VM `attachDisk` / `attachISO` / create-time CDROM and disk source paths constrained to the image library or per-VM directory; libvirt can no longer open arbitrary host files (e.g. `/etc/shadow`) as block / CDROM devices
- SMB credentials passed to the kernel via `mount.cifs credentials=` file (mode 0600); password no longer appears on `mount` argv / `/proc/<pid>/cmdline`. `wisp-mount` no longer `source`s the JS-generated config — strict allow-listed key=value parser. JS layer rejects `\n`/`\r`/`,` in `share`, `mountPath`, `username`, `password`
- WebSocket consoles enforce same-origin via `Origin` header allow-list (CORS doesn't apply to WS); rejection close `1008`
- Image library upload cleans up partial files on truncation (`data.file.truncated`) or pipeline error — closes a disk-fill DoS
- Login rate-limit map now sweeps expired entries every 60 s and caps at 10 000 distinct IPs (was unbounded)
- Auth hook matches public paths by post-routing `request.routeOptions.url` (was raw URL; trailing-slash / percent-encoded variants used to bypass)
- `/api/github/keys/:username`: manual redirect handling (rejects 3xx) and 10/min per-IP rate limit
- Plaintext password fallback removed; backend refuses to start on a non-scrypt `wisp-password` file (run `wispctl password` to repair)
- `routeErrors.handleRouteError` redacts absolute paths and UUIDs from response `detail` and caps at 500 chars; raw stderr still logged server-side
- `wisp-netns ipv4 <name> [ifname]` validates `ifname` (matches the existing `route-add` regex)
- Caddy app `target` validated as `host[:port]` or `scheme://host[:port][/path]` (rejects `\n` / `\r` / `{` / `}` — was raw-interpolated into the Caddyfile)
- Snapshot create / revert / delete share `validateSnapshotName` (`^[a-zA-Z0-9 ._-]+$`, max 64 chars)
- Container mount PUT: per-route `bodyLimit` set just above `MOUNT_FILE_CONTENT_MAX_BYTES` (rejects oversized payloads at the parser, not just the handler)
- Image library DELETE / PATCH refuses with 409 when any VM still references the file (`<disk source>` matches absolute path); operator detaches first
- `removeMount` refuses with 409 when any container's `mounts[*].sourceId` references it (mirrors `assertBridgeNotInUse`)
- `/api/stats` and `/api/containers/stream` SSE now emit `{ error, detail, code? }` frames on failure (was silent skip)
- Frontend `api/client` uses `data.error` before `data.message` (matches the documented WISP-RULES contract)
- `auth.js` and `diskSmart.js` throw via `createAppError` with stable codes (no plain `new Error`)
- `containerManagerNetwork.discoverIpv4InNetns` switched to exponential backoff (matches sibling `waitForStop` / `waitUntilTaskStoppedOrGone`)
- `IconPickerModal` focuses the search input via `useLayoutEffect` (was `setTimeout(50)`)
- `XMLModal` surfaces the error message in the displayed text instead of silently swallowing
- Password change closes all live SSE / WebSocket connections and re-issues fresh cookies against the new secret — pre-rotation tokens can no longer keep streaming, and the user who changed their password isn't bounced to /login
- 22 backend `console.*` log sites routed through Pino (`connectionState.logger` / `containerState.logger` / `mdnsManager.state.logger`); three boot-time fallbacks left with comments where Pino isn't available yet
- Container response schemas: added to `GET /api/containers` (rest deferred — Fastify silently strips non-declared response fields, high blast radius)

### Bug Fixes (post-audit follow-ups, same day)
- **VM delete on UEFI domains** failed with `cannot undefine domain with nvram` — `VIR_DOMAIN_UNDEFINE_NVRAM` / `KEEP_NVRAM` were declared as `0x2` / `0x4` but the libvirt enum is `1 << 2` / `1 << 3` (`0x4` / `0x8`). The wrong flag was being set on every UEFI delete; KEEP_NVRAM was even worse — it was actually `NVRAM` (delete the file), the opposite of what the operator picked
- **Frontend WS proxy** now forwards `Origin` and `Host` across the upgrade hop. `@fastify/http-proxy`'s default `defaultWsHeadersRewrite` carries only `cookie`, dropping Origin and Host — the backend's same-origin check then saw no Origin and rejected with close `1008` ("origin not allowed"). Manifested in noVNC as a connection failure on the VM Console tab
- **Newly-created VM Overview no longer freezes at "stopped"** even after the sidebar correctly tracks state. The list SSE listener used to call `deselectVM` whenever the selected name was missing from the latest frame — fired during the brief race after `selectVM` set `selectedVM` but before `getVM` resolved (and before the libvirt domain event for the new VM had reached the SSE), nulling `selectedVM` and stranding `vmConfig` outside the SSE listener's `prev.selectedVM && prev.vmConfig` gate. Fix: gate auto-deselect on `!configLoading && !actionLoading`. Symmetric fix in `containerStore`
- `api/sse.js`: `setTimeout(() => controller.abort(), 90s)` referenced an outer `controller` that `close()` nulls. If the timeout fired after a close, `null.abort()` threw `Cannot read properties of null (reading 'abort')`. Fix: capture controller per-attempt; `clearTimeout` in `finally`

### Bug Fixes
- Form fields render at consistent height — `.input-field` now sets explicit `h-[34px]` so native `<select>` chevron padding doesn't make selects taller than inputs
- Validate container names on every `/api/containers/:name/*` route (path-traversal hardening); run-log download uses RFC 5987 `Content-Disposition`
- Validate VM body names on `POST /api/vms` and `POST /api/vms/:name/clone`; reject unknown body fields (`additionalProperties: false`); align name max length at 128
- Redact `?token=` from request URLs in logs (Pino `req` serializer + custom not-found handler) — JWTs from SSE/WebSocket URLs no longer reach `journald` / `stdout`
- `wisp-bridge` validates `--file-name` against the netplan filename pattern and asserts the resolved path stays under `/etc/netplan/` (defense in depth)
- SSRF hardening: pin DNS resolution via `undici.Agent`, follow redirects manually with re-validation on every Location, expand private IPv4/IPv6 ranges (CGNAT, multicast, IPv4-mapped IPv6, etc.); applies to user URL downloads and preset image downloaders
- Cloud-init password no longer silently downgrades to the literal `***` when re-saving an unchanged password — the hashed password is now persisted as `passwordHash` in `cloud-init.json` and re-emitted when the placeholder is sent back
- Cloud-init `user-data` / `meta-data` emitted via `js-yaml` (was hand-rolled template literals); route schema also rejects CR/LF in user-controlled fields
- Settings file writes serialise read-modify-write inside the mutex (was prone to lost updates on concurrent `PATCH /api/settings`)
- SSRF: also detect IPv4-mapped IPv6 in Node's normalized hex form (`::ffff:7f00:1` ≡ `127.0.0.1`)
- Storage mounts: `mountPath` must resolve under `/mnt/wisp/`; `wisp-mount` re-asserts it via `realpath -m` (admin-to-root hardening)
- VM rename now relocates the on-disk directory in lockstep with the libvirt rename, rewrites every absolute path in the domain XML (disks, NVRAM, loader), and redefines snapshot memory file paths. The source dir is **inferred from the XML's actual file paths**, not from `getVMBasePath(oldName)` — converges legacy state where a prior pre-fix rename left files at a directory whose name no longer matches the libvirt domain name. Refuses to rename when the target dir already exists
- VM clone now copies disks into the **new** VM's directory (was writing into the source VM's dir), so subsequent rename/delete of the clone behaves predictably; clone also copies the source NVRAM file into the new dir so the clone never shares NVRAM with the source
- VM delete only passes `VIR_DOMAIN_UNDEFINE_NVRAM` when the NVRAM file lives inside the VM's own directory; legacy/shared NVRAM files are kept (`KEEP_NVRAM`) so deleting one VM cannot corrupt another
- VM delete with `deleteDisks=false` now leaves the per-VM directory completely untouched (was selectively removing cloud-init artefacts but keeping disks, leaving half-cleaned state)

### Bug Fixes (audit campaign — plan-3 Low / Info / state-sync Low)
- Frontend serves CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` on every response (`style-src 'unsafe-inline'` only, to keep xterm/noVNC working); HSTS deliberately left to the upstream proxy
- Mount API never returns the SMB password (the masked `***` placeholder is gone). Response now carries `hasPassword: boolean` so the UI can render a "saved" affordance without holding any secret-shaped string. Update PATCH semantics: omit / empty `password` preserves the stored value; the frontend only sends `password` when the user actually typed one
- WebSocket consoles (VNC + container shell) close with a small set of generic reasons (`invalid name`, `vnc unavailable`, `exec failed`) instead of leaking `err.message` text — full detail still logged server-side
- Container delete deregisters mDNS *after* `Tasks.delete`, not before — closes the brief "name gone, container still serving" window
- `oci-image-meta.json` read-modify-write in `listContainerImages` serialises through a single-writer mutex (the periodic update checker and the UI both hit this path concurrently)
- `listBackgroundJobs` tolerates a single store throwing — the aggregator returns the others instead of blanking the panel
- SMB and disk mount tmp dirs no longer touch `process.umask` (was process-global and would race with concurrent file-create sites); `mkdtemp({mode: 0o700})` plus per-file `mode: 0o600` writes are sufficient
- Library download write stream opens with `O_EXCL` (`createWriteStream({flags:'wx'})`) so a symlink swapped between `findUniqueFilename`'s `access` check and the write fails the open instead of following the link
- Backend warns on stderr at boot when `config/runtime.env` permissions exceed `0o600` (the install/setup pipeline already chmods 0600; this is the safety net for hand-edited deploys)
- Docs: `AUTH.md` documents the `trustProxy` requirement for `request.ip`-based rate limiting; `VM-MANAGEMENT.md` documents out-of-band rename behaviour; `BACKUPS.md` documents `vmBasePath` portability across `vmsPath` changes; `STORAGE.md` documents the new `hasPassword` response field

## 2026-04-28

### New Features
- **Container mounts: new tmpfs mount type** (in-memory, no host backing). Configurable size cap (1–2048 MiB, default 64); rejected fields: `sourceId`, `subPath`, `readonly`, `containerOwnerUid`, `containerOwnerGid`. Contents are wiped on stop/restart — useful for runtime-state directories like Samba's `/var/lib/samba`, scratch caches, lock/socket dirs. Available via the new `+ tmpfs` button in the Mounts section
- **VM and container sidebars update instantly on backend events** instead of polling on a 5 s timer. `/vms/stream` now pushes on libvirt `DomainEvent` and qemu binary replacement (apt upgrade); `/containers/stream` pushes on containerd events (`tasks/start`, `tasks/exit`, `containers/create`, etc.), every `container.json` write, and image-update job completion. The list cache shape was trimmed to only what the sidebar renders (drops `pid`, `cpuLimit`, `memoryLimitMiB`, `restartPolicy`, `autostart`, `uptime`, `pendingRestart` from the container list payload, `autostart` from the VM list payload — all still served by the detail endpoints)
- All `container.json` writes now go through a single `writeContainerConfig` helper (twelve scattered call sites consolidated, two duplicate private helpers removed); fans out a config-write notification consumed by the new container list cache
- Removed the **Refresh interval** setting from App Config and the `refreshIntervalSeconds` field from `wisp-config.json` — the SSE streams it drove are now event-driven. Existing config files with the field are silently ignored

### Bug Fixes
- **Container Mounts "Restart required" badge no longer sticks after restart.** The section's badge was driven by client-side state that was never reconciled with the backend; mount CRUD now persists `pendingRestart: true` server-side (cleared on container start, mirroring the app-container pattern) and the section reads that flag directly
- **VM Advanced settings (Boot Menu, Firmware, Video Driver, Graphics, Boot Order, vTPM, VirtIO RNG, Mem Balloon, Guest Agent, Machine Type, CPU Mode, Nested Virt) now reflect saved values immediately on running VMs.** `getVMConfig` was reading **active** XML for everything except `iconId`/`localDns`, while `DomainDefineXML` writes to **inactive** XML — so saved edits to a running VM looked like they didn't stick until the next start, and the toggle would visually snap back after the auto-refresh. Switched the detail view to read inactive XML for all persisted config; `getVNCPort` keeps its active-XML read for the runtime VNC port
- **Deleted containers no longer linger in the sidebar.** The containerd `/containers/delete` event fires before `rm -rf` of the container directory, so the cache refresh it triggered still saw the file on disk. Added a final cache refresh after `rm` completes so the sidebar reflects the deletion
- **VM and container detail panels now show the error message instead of an infinite spinner** when a missing entry is selected (e.g. clicking a sidebar entry whose container/VM was just deleted). Previously a 404 left `loading: false, config: null`, but the panel returned a spinner for `!config`, so the error was swallowed

## 2026-04-27

### New Features
- VM detail page status line now shows a **Guest agent: connected/disconnected** pill when the domain has a qemu-ga channel configured

### Bug Fixes
- **VM Local DNS hostnames stop resolving after backend restart until the VM page is opened.** mDNS publishing for VMs was driven by the per-VM stats SSE stream — re-registration only ran while a user had the VM detail page open. After a backend restart no warm-up ran for VMs (containers had one), so hostnames went dark until someone navigated to the VM and the SSE stream re-published them as a side effect. Replaced with a backend reconciler (`vmMdnsPublisher`) that subscribes to libvirt `DomainEvent` + per-domain `AgentEvent` signals, runs an initial reconcile at boot, and keeps a 45 s safety-net interval; the SSE stats stream is now side-effect free for mDNS
- **`systemctl restart avahi-daemon` no longer recovers Local DNS entries.** The `NameOwnerChanged` watch in `mdnsManager` called `bus.addMatch(...)` — a method that doesn't exist as a public API in dbus-next 0.10.x. Watch installation threw at startup with `bus.addMatch is not a function`, the error was caught and only logged, and the signal listener was never attached. So `reregisterAll` never fired when avahi restarted. Removed the broken call: dbus-next auto-installs the match rule when you attach a listener on the proxy iface (`iface.on('NameOwnerChanged', ...)`), so the listener attachment alone is sufficient

## 2026-04-26

### Bug Fixes
- Container Mounts: saving a new row no longer leaves a duplicate draft alongside the persisted one (regression from earlier same-day edit-mode-preservation fix; the just-saved draft is now skipped from preservation when its name/path matches a row that just appeared on the server)
- Escape key inside an input / textarea / select / contenteditable no longer triggers the global "navigate to Host overview" handler on the Container/VM routes; only Escape on non-form elements navigates

## 2026-04-26

### New Features
- Container bind mounts under **runAsRoot** now get a per-mount **idmapped mount** (size:1) so files written by the configured in-container UID/GID land on the host owned by the wisp deploy user — no more `sudo` needed to clean up root-in-container artifacts
- New **Owner uid:gid** column in the container Mounts table (visible only when runAsRoot is on, Local mounts only): pick which in-container UID/GID is the "writer" through this mount; defaults to `0:0` (root). Writes by other in-container UIDs fail with `EOVERFLOW` — exactly one writer per mount by design
- `containerd.sh` setup probes the installed `runc` version and warns when `< 1.2.0` (required for per-mount idmapped mounts)

### Bug Fixes
- Container Mounts: row no longer exits edit mode mid-edit when an SSE tick from the container store hands the section a fresh `config` object; reset is now keyed to container switches and content changes, not object identity
- Data tables: action icon row no longer wraps to multiple lines on narrow widths (affected mounts, env, USB, networks, snapshots, disks, storage, bridges, backups)
- Bump frontend `postcss` to 8.5.10 via `npm audit fix` (transitive advisory)

## 2026-04-24

### New Features
- README gains a Screenshots section with VM, container, and host views; VM overview shown up top

### Bug Fixes
- Ubuntu cloud image download now resolves the latest LTS dynamically from Canonical's simplestreams catalog instead of a hardcoded list, so new LTS releases are picked up automatically (with a fallback list on network failure)
- Bump `fast-xml-parser` to 5.7.1 for CDATA/comment injection fix (GHSA-gh4j-gqv2-49f6); relevant because `buildXml` is fed user-controlled values before `DomainDefineXML`

## 2026-04-20

### New Features
- Container directory mounts can be sourced from a Storage mount: new **Source** column (Local by default; dropdown of configured SMB shares / adopted drives) plus a **Sub-path** input. Adopted-drive content backs the bind mount directly — no extraction into `files/`. Alert badge on rows whose Storage source is missing or not currently mounted.
- Container start performs a pre-flight check on Storage-sourced mounts (referenced storage exists, currently mounted, sub-path resolves inside the storage root) and fails fast with actionable errors before hitting containerd.
- Host Mgmt → **Storage** replaces **Network Storage**: unified SMB shares and adopted removable drives in one SectionCard, with a live "Detected drives" table for unadopted block devices
- Removable drive auto-mount: adopted disks (keyed by filesystem UUID) mount on insertion, lazy-unmount on surprise removal, and reconcile at backend startup
- New `wisp-mount` privileged helper (replaces `wisp-smb`) — supports `smb mount|check`, `disk mount`, `unmount`, and `unmount-lazy`; `install-helpers.sh` removes the legacy `wisp-smb` automatically
- Disk detection via `/dev/disk/by-uuid/` + `/run/udev/data/b<maj>:<min>` (no `udisks2` dependency); hotplug via `fs.watch`, pushed to `/api/host/disks/stream` SSE
- Supported removable filesystems: `ext4`, `btrfs`, `vfat`, `exfat`, `ntfs3` (ntfs3 forced read-only)
- Hard-converge on startup: mounts under `/mnt/wisp/` that aren't in `settings.mounts` are lazy-unmounted so the on-disk state always matches the config

### Breaking
- `settings.networkMounts` → `settings.mounts` (type-discriminated: `"smb"` | `"disk"`); `settings.backupNetworkMountId` → `settings.backupMountId`; mount `path` field removed in favour of `mountPath`
- `/api/settings/network-mounts/*` moved to `/api/host/mounts/*`; full-array mount replacement via `PATCH /api/settings` is gone — use per-row POST/PATCH/DELETE
- Error codes renamed: `NETWORK_MOUNT_*` → `MOUNT_*`

## 2026-04-20

### New Features
- URL-addressable views: `/host/:tab`, `/vm/:name/:tab`, `/container/:name/:tab`, `/create/vm`, `/create/container` — browser refresh and deep links now land back on the same page and tab
- Host tabs reshuffled: OS Update moved out of "Host Mgmt" into a new top-level **Software** tab (replaces "Image Library"), stacked above the image list; pending-update badge moves with it
- Host "reboot required" signal — amber badge on the Restart button and OS Update card when `/var/run/reboot-required` is present (Debian/Ubuntu) or the running kernel differs from the installed one (Arch); triggering packages listed in the tooltip
- VM stale-qemu signal — list row and Reboot action flag VMs whose qemu binary was replaced on disk (e.g. after a qemu/libvirt upgrade) so a restart into the new binary is visible
- Image Library "Checked …" status always reports the update count found, so the Check button's effect is visible even when zero

### Bug Fixes
- Shell top bar height unified across Host / VM / Container views; left-sidebar Host row no longer stands taller than the tab row next to it
- OCI image Modified timestamps no longer reset to "just now" on every update check — pinned per (ref, digest) via a sidecar so idempotent re-pulls don't bump the column
- Container `updateAvailable` is now derived at read time from digest drift rather than persisted, so stale flags can no longer stick across start/stop cycles
- Container overview drops the redundant Restart button from the update banner; the primary Restart action sits directly above it in the header

## 2026-04-18

### New Features
- Per-run container logs: every start writes a fresh `runs/<runId>.log` + sidecar (`startedAt`, `endedAt`, `exitCode`, `imageDigest`); newest 10 runs retained per container
- Container logs UI: run picker replaces the session/all toggle — pick any recent run, green dot for the active one, red dot for non-zero exit
- Clear-viewer, insert-mark, and download-run controls in the logs toolbar; clear and mark touch only the client buffer

### Breaking
- Dropped `sessionLogStartBytes` from `container.json` and the legacy single `container.log`; `/api/containers/:name/logs` now takes `?runId=` instead of `?scope=`; new `GET /api/containers/:name/runs` and `GET /api/containers/:name/runs/:runId/log`

## 2026-04-18

### Docs
- README rewritten around the actual VM + container feature set, positioning vs Proxmox/Arcane, and the install flow

## 2026-04-18

### New Features
- In-process DNS forwarder on 169.254.53.53 for containers — wisp-backend binds UDP+TCP 53 on the stub IP (via `CAP_NET_BIND_SERVICE`), answers `.local` queries through avahi DBus, and relays everything else to the host's upstream resolver. Same-host container→container `.local` now resolves through the same path, obsoleting the shared `/etc/hosts` bind mount

### Bug Fixes
- Container `.local` publications survive avahi-daemon restarts — `mdnsManager` subscribes to DBus `NameOwnerChanged` and re-registers every entry when avahi reappears
- Containers see `/etc/hosts` updates for new mDNS registrations in real time — mdnsManager writes the shared hosts file in place instead of rename-over, so bind mounts track inode content
- `.local` resolution survives host reboots — `wisp-backend.service` re-asserts `169.254.53.53/32` on `br0` on every boot (runtime-only address, otherwise dropped at reboot)
- `install.sh` re-templates systemd units on update so unit-file changes propagate without a manual `wispctl svc install`
- Bump backend `protobufjs` to 8.0.1 / 7.5.5 for arbitrary code execution (GHSA-xq3m-2v4x-88gg)
- Bump frontend `@fastify/static` to 9.1.1 for directory-listing path traversal (GHSA-pr96-94w5-mx2h) and encoded-separator route guard bypass (GHSA-x428-ghpx-8j92)

## 2026-04-17

### New Features
- OCI image update checker: hourly background sweep plus manual bulk and per-image triggers in the Image Library
- Containers flagged with `updateAvailable` / `pendingRestart` when their image's digest moves upstream; restart re-prepares the snapshot from new layers
- `imageDigest` and `imagePulledAt` stamped on `container.json` at create time to detect future drift
- Container `.local` resolution via systemd-resolved stub on `br0` (link-local 169.254.53.53) — apps inside containers can now resolve mDNS hostnames without per-container setup

### Bug Fixes
- Container start always rebuilds rootfs snapshot from current library image and clears stale `updateAvailable` flag — fixes "Restart required" banner sticking after a restart and silently no-op restarts when a prior digest back-fill had already made the flag stale
- Same-host container `.local` resolution via shared `/etc/hosts` bind mount maintained by `mdnsManager.js` (working around avahi refusing to answer its own host's mDNS queries). No privileged helper; backend writes `/var/lib/wisp/mdns/container-hosts` directly
- Install `169.254.53.53/32 dev eth0` route in container netns after CNI ADD — without it, containers on br0 used the stub resolver via their default gateway and all DNS timed out
- Silence Caddy reverse_proxy per-disconnect WARNs that spam logs from SSE clients
- Bump backend fastify to patch content-type validation bypass (GHSA-247c-9743-5963)
- Bump frontend @fastify/http-proxy and @fastify/reply-from for connection header abuse (GHSA-gwhp-pf74-vj37) and content-type bypass (GHSA-247c-9743-5963)

## 2026-04-16

### New Features
- Custom App Containers: hardcoded app templates with dedicated config UIs instead of generic env/mounts
- App registry pattern (backend + frontend) for organizing app modules
- Caddy Reverse Proxy app: domain, wildcard TLS via Cloudflare DNS, host-based reverse proxy entries
- Eject app container to generic (one-way, preserves generated config)
- Zot OCI Registry app: private container image registry with optional htpasswd auth
- Live reload for app containers (Caddy reloads config without restart)
- Non-interactive container exec (`execCommandInContainer`) for one-shot commands
- Loopback interface brought up in container network namespaces (fixes localhost binding)

## 2026-04-15

### New Features
- Container secret env vars with structured shape and envPatch delta updates
- OCI image picker and local-image shortcut on container create
- CNI bridge networking for containers so the host can reach them
- Session vs all logs for containers (persisted session start offset)
- Interactive container shell console (xterm + containerd exec)

### Bug Fixes
- Pass container MAC under `args.cni.mac` for bridge CNI
- Icon-only Browse button on container image field
- Reliable favicon transparency on Safari
- Use upstream `resolv.conf` for container DNS on systemd-resolved hosts

### Docs
- README reframed around the homelab-focused, opinionated-simplicity intent
- Project rules migrated to `CLAUDE.md` (root + scoped `backend/src/lib` and `backend/src/routes`)
- Added changelog workflow: `CHANGELOG.md` updated before every push

## Initial release
- First commit; baseline Wisp VM and container management app.
