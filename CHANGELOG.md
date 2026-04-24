# Changelog

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
