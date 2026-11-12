# Architecture

> The system's shape: processes, subsystems and their boundaries, data flow, where state
> lives, how it runs. It names a technology only to describe the shape.

## Run shape

- A **single Node process** (`wisp.service`) on the host it manages, beside the libvirt
  daemon and containerd: it serves the API, the consoles, background work, the built
  frontend from `frontend/dist/` and the vendored noVNC under `/vendor/`.
- API and stream routes live under `/api`, console WebSockets under `/ws`, the MCP
  endpoint at `/mcp`; every other path serves the client. In development the Vite dev
  server serves the client and proxies `/api` and `/ws` to the backend; on macOS the
  backend runs stub managers (no libvirt, no containerd).
- At startup the backend connects to libvirt and avahi over DBus and to containerd over
  gRPC, and mounts the configured SMB mounts. On shutdown it closes the open streams and
  disconnects the managers.

### The client

- The URL is the source of truth for the active view and tab: tab buttons and list items
  navigate rather than set store state, so a refresh restores the same view (routes:
  [`specs/UI.md`](specs/UI.md), View Switching).
- **Boot probe:** protected routes gate on one `GET /api/host`, aborted after 5 s — a dead
  VPN swallows the connection rather than refusing it — and any failure renders the Server
  Unreachable screen ([`specs/UI.md`](specs/UI.md)). Once ready the gate stops probing; a
  mid-session drop is the streams' own reconnect.

### Offline shell (`frontend/public/sw.js`)

Wisp is usually reached over a VPN, so it is often launched with the server unreachable;
launched from a phone's home screen there is no browser chrome to show a "cannot connect"
page. The service worker keeps the app shell so a launch always boots React.

- **Navigations** are network-first with a 4 s timeout, falling back to the cached shell,
  then to a self-contained HTML page. Never cache-first: `wisp-updater` swaps
  `frontend/dist/` in place, and a cache-first shell would pin the user to a stale build.
- **`/assets/*`** is cache-first: Vite content-hashes those names.
- **`/api`, `/ws`, `/vendor`** are never intercepted: API responses must not be served
  stale, streams must not pass through a cache, and noVNC is unhashed.
- The eager chunk graph is precached on `install`, resolved at build time from Vite's
  build manifest (`frontend/scripts/generate-sw-precache.js`): browsers may serve
  subresources from their own HTTP cache without a fetch event, which would leave the
  worker's cache too sparse for an offline launch. Cache names carry a build id, so
  `activate` purges the previous build's entries.
- Service workers need a secure context: on a plain-HTTP install registration is skipped
  and Wisp runs without the offline shell
  ([`specs/CONFIGURATION.md`](specs/CONFIGURATION.md#reverse-proxy--https-trustedproxies)).

## State

- Persistent state lives in three places, and nothing writes runtime state elsewhere:
  - **`config/`** at the install root: `wisp-config.json` (application settings, API
    token hashes), `wisp-password` (the scrypt hash the session secret derives from),
    `migrations.json` (the migration ledger) and the optional `runtime.env`. The updater
    preserves them across a swap ([`specs/UPDATES.md`](specs/UPDATES.md)).
  - **libvirt's domain definitions**: a VM's configuration *is* its domain XML, with
    Wisp's own settings in its `wisp:prefs` metadata.
  - **`/var/lib/wisp/`**: the image library, per-VM directories, local backups and
    per-container directories, below.
- **The server is the source of truth**: VM metadata lives in domain XML, a container's
  configuration in its `container.json`, settings in `wisp-config.json` — never in the
  browser. containerd holds only runtime state (task status, metrics).
- JSON state is written atomically (`writeJsonAtomic`: stage, fsync, rename); boot removes
  orphan temp files a crash left mid-rename.
- What an earlier release wrote is brought to the current shape by state migrations during
  the update (`CODING-RULES.md` §16).

```
/var/lib/wisp/
├── images/                       # Image library (ISOs, disk templates)
├── vms/
│   └── <vm-name>/                # Per-VM directory
│       ├── disk0.qcow2           # Primary disk
│       ├── disk1.qcow2           # Secondary disk (optional)
│       ├── cloud-init.iso        # Cloud-init seed ISO (optional)
│       ├── cloud-init.json       # Cloud-init config (optional)
│       └── VARS.fd               # UEFI NVRAM (optional)
├── backups/                      # Local backup destination (layout: specs/BACKUPS.md)
└── containers/
    └── <name>/
        ├── container.json        # Container config (source of truth)
        ├── files/                # Per-mount backing paths (see specs/CONTAINERS.md)
        └── runs/                 # Per-run log file + sidecar metadata
            ├── <runId>.log       # stdout/stderr for one task run
            └── <runId>.json      # run metadata (startedAt, endedAt, exitCode, imageDigest)

/mnt/wisp/smb/                    # Typical SMB mount parent for network storage mounts
```

## Backend: events

There is no central bus: each manager and module publishes its own events, and the
stream to the client (Transport) subscribes like any other consumer.

- **Events are push, not pull**: subscribe-and-replay surfaces on each facade — they fire
  only on change, replay the current state to a new subscriber, and keep platform
  plumbing private. A new event surface follows the same pattern.
- **Manager network events** feed the app glue that publishes `.local` names:
  - `vmManager.subscribeVMNetworkChange(handler)` — `(name, snapshot)`, with
    `{ stateCode, ip, hostname }` while running and `null` when stopped.
  - `containerManager.subscribeContainerNetworkChange(handler)` — `(name, snapshot)`,
    with `{ state, ip, ip6 }` while running on a bridge and `null` when stopped or
    removed. The manager writes new addresses into `container.json` before firing: it
    owns the durable record, the glue only reacts.
  - `containerManager.subscribeContainerNetnsRemoved(handler)` — `(name)` after Wisp
    deleted a container's netns, with no replay; the glue re-publishes probing groups,
    since avahi 0.8 strands entry groups probing on a removed interface.
  - Both network-change events replay on subscribe, so glue that starts after the
    managers still catches up. The macOS stubs never fire.
  - Every A-record registration lives in the reconcilers
    (`lib/{vm,container}MdnsReconciler.js`); the managers make none.
- **Managers are configured, not reaching out**: `lib/managerBootstrap.js` (shared by the
  backend and the migration runner) calls each manager's `configure()` with its paths and
  callbacks (`resolveMount`, `tryAcquireOperationLock`) before any route registers. The
  migration runner connects with `{ watchEvents: false, repairOnRead: false }`: no event
  subscriptions, uncached lists that are complete or throw, and reads that write nothing.
- **Mechanism is decoupled from trigger.** Any background or maintenance mechanism (the
  update poll, apt checks, job-TTL cleanup, reconcilers, scheduled backups) is an
  invocable unit; its triggers — boot, a schedule, events, a manual run — are wired
  separately, and any trigger can invoke any mechanism. A manual run always works, for
  testing or because it is needed now. Every execution logs what triggered it and the
  result.

## Transport

- **One multiplexed SSE stream per tab, `/api/events`**, carries every always-on feed as
  `{ topic, data }` frames: `stats` (sampled every 5 s), and the event-driven `vms`,
  `containers`, `sections`, `discovery` and `home`. One connection, not one per feed,
  because browsers cap plain HTTP/1.1 at 6 connections per origin: a new always-on feed is
  a new topic, never a new endpoint ([`specs/API.md`](specs/API.md), Events stream).
- **Each connect opens with the current state**: a new subscriber gets each topic's last
  frame, and the client replaces its list with it, so one reconnect replaces any stale
  state.
- **What one view needs gets a scoped stream**, open only while the view is on screen:
  per-workload stats and logs, the disk and USB streams. **Job progress** streams emit
  until the job completes or fails, then close. No repeated-GET polling for live data.
- **A stream that goes quiet is reopened**: the server writes a `: keepalive` comment
  every 25 s; the client re-arms a 60 s read watchdog on every chunk and reconnects with
  backoff when it fires. A frozen page can't run its watchdog, so every stream also
  resyncs on `visibilitychange → visible` and on `online` when it has had no bytes for
  longer than the keepalive. A 401 sends the user to sign in.
- **Commands are REST calls under `/api`**; the state they change also reaches every
  client through the stream.
- **Consoles are WebSockets under `/ws`**: VNC bridges the browser to QEMU's VNC port over
  TCP on `127.0.0.1` ([`specs/CONSOLE.md`](specs/CONSOLE.md)); the container shell drives
  containerd's exec with a PTY. Both authenticate with the session cookie the browser
  sends on the upgrade — no token in the URL.

## Repo layout & subsystem boundaries

- `backend/` (the server: `src/index.js`, `src/routes/`, `src/lib/`; `scripts/` holds the
  privileged helpers, the updater and the migration runner; `migrations/` the state
  migrations), `frontend/` (the client), `scripts/` (install, setup, push, release),
  `systemd/` (unit templates), `config/` (examples). Each package has its own
  `package.json`.
- Backend subsystems are named modules under `src/lib/`, each behind a facade `index.js`,
  with platform implementations under `<module>/linux/` and `<module>/darwin/`. App glue —
  Wisp's own orchestration — stays flat at the top of `src/lib/`, and routes do HTTP
  concerns and call the facades and the glue. The fences between them are CODING-RULES
  §7: one caller per external system, and managers free of Wisp glue.
- `frontend/src/`: `api/` (the fetch wrappers and the SSE client), `store/` (one Zustand
  store per subsystem), `components/` by domain, `apps/` (container-app config UIs),
  `pages/`, `hooks/`, `lib/`, `utils/`.

## Subsystems

```text
  browser ──REST /api──▶ routes ──▶ app glue ──▶ vmManager ────DBus──▶ libvirt ──▶ QEMU/KVM
     │ ▲   ──WS /ws────▶ consoles ──TCP / exec──▶   │
     │ │                               │       ──▶ containerManager ──gRPC──▶ containerd
     │ │                               │       ──▶ containerApps ──▶ containerManager
     │ │                               │       ──▶ host · storage · networking · mdns
     │ └──SSE /api/events◀── topics ◀── manager and module events
  agents ──/mcp──▶ mcp tools ──▶ the same facades and glue as the routes
```

- `vmManager` — VMs on libvirt over DBus, the only libvirt caller; a VM's domain XML is
  its record ([`specs/VM-MANAGEMENT.md`](specs/VM-MANAGEMENT.md)).
- `containerManager` — containers on containerd over gRPC, the only containerd caller, in
  the `wisp` namespace. Each container is a veth port on a host bridge with its own LAN
  IP by DHCP; `container.json` is its record
  ([`specs/CONTAINERS.md`](specs/CONTAINERS.md)).
- `containerApps` — the app recipe layer, a consumer of containerManager: it turns "a
  Jellyfin with these libraries" into containerManager calls. App identity lives in
  `container.json`'s `metadata`, which containerManager passes through untouched
  ([`specs/CUSTOM-APPS.md`](specs/CUSTOM-APPS.md)).
- `host` — hardware inventory, GPUs, power, the USB monitor, `/proc` stats, the
  reboot-required signal, OS updates and SMART summaries
  ([`specs/HOST-MONITORING.md`](specs/HOST-MONITORING.md)).
- `storage` — `qemu-img` disk operations, the block-device monitor, removable-disk and SMB
  mounts ([`specs/STORAGE.md`](specs/STORAGE.md)).
- `networking` — host bridges, `/proc` IPv4 and netplan-managed VLAN bridges; it never
  imports the managers.
- `mdns` — Avahi publishing and browsing, and the in-process DNS forwarder that answers
  containers' `.local` queries.
- `mcp` — the MCP endpoint: tools over the same facades and glue as the routes, secrets
  masked ([`specs/MCP.md`](specs/MCP.md)).
- App glue — auth and API tokens, settings, cloud-init, backups (scheduler, retention,
  destinations), job stores, operation locks, the mDNS reconcilers, LAN discovery, the
  home page and self-update.
