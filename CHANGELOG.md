# Changelog

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
