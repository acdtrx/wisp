# Changelog

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
