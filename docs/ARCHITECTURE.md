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
- **The start runs in one order** (`main()` in `src/index.js`): `runtime.env` (loaded as
  the first import, its retired keys skipped), then the pending state migrations, then the
  strict checks of the config, then the managers configured, the app and its routes
  built, the boot work (connections, mounts, container autostart), and the port opened
  last; then the backend tells systemd it is ready (`Type=notify`), which ends the start.
  A start whose migrations or checks fail exits non-zero without listening.
  **No module reads stored state or connects when it loads**: whatever it needs is read
  by a function this order calls, so nothing has read the state before the migrations
  have brought it up to date (settled 2026-11-18).
- At startup the backend connects to libvirt and avahi over DBus and to containerd over
  gRPC, and mounts the configured SMB mounts. On SIGTERM it stops accepting connections,
  ends the open streams, disconnects the managers and exits within a bounded time. An
  unhandled rejection or exception is logged and ends the process (settled 2026-11-15:
  restored from the template).

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

- Persistent state lives in three places; write runtime state nowhere else:
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
- **Secrets are write-only and live in their owner's record** `[PROJECT]`: SMB passwords
  and the OIDC client secret in `wisp-config.json`, secret env values and secret file
  mounts in `container.json` (both `0600`), the cloud-init password as a hash in
  `cloud-init.json`. The API never returns one, only a flag that it is on file, and an
  edit that omits or blanks a secret keeps the stored one; each secret's exact rules are
  in its spec (settled 2026-11-15: kept over the template's one `secrets.json`, whose
  edits clear a secret they don't carry).
- Write JSON state atomically (`writeJsonAtomic`: stage, fsync, rename); boot removes
  orphan temp files a crash left mid-rename.
- What an earlier release wrote is brought to the current shape by state migrations, which
  the backend runs at every start before anything else reads the state, and nothing else
  runs (`CODING-RULES.md` §16).

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

## Backend: events `[PROJECT]`

There is no central bus: each manager and module publishes its own events, and the
stream to the client (Transport) subscribes like any other consumer (settled 2026-11-15:
kept over the template's one in-memory bus; the per-facade surfaces below serve every
consumer, and nothing has called for more).

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
- **Record change cues** feed the `changes` topic (Transport). Unlike the surfaces
  above they fire per write, not per difference, and never replay: a cue to read the
  record again, not its state. A write that changed nothing still fires, and one
  change can fire twice (cloud-init's own cue after vmManager's).
  - `vmManager.subscribeVMChange(handler)` — `(name)` after each successful config,
    disk, CD-ROM, USB, graphics-listen or restart-flag write through the facade,
    hot-plug included (libvirt sends no `DomainEvent` for it), under the new name after
    a rename.
    Create, delete and restore don't fire: the VM list carries them. Out-of-band
    changes (`virsh edit`) fire nothing. The macOS stub never fires.
  - `containerManager.subscribeContainerChange(handler)` — `(name)` after every
    `container.json` write (config, mounts, services, the restart flag, a rename under
    the new name, the network probe's address) and every write of a mount's content
    (upload, zip extract, content edit, init, data delete, file mode). The macOS stub
    never fires.
  - `lib/cloudInit.js` `subscribeCloudInitChange(handler)` — `(vmName)` after a VM's
    cloud-init config is saved, disabled or removed.
  - `lib/settings.js` `subscribeSettingsChange(handler)` — after every write that
    changes what `GET /api/settings` returns.
  - `lib/settings.js` `subscribeMountsChange(handler)` — after every host mount add,
    edit and removal, on top of the settings cue.
  - `storage.subscribeMountStateChange(handler)` — after every successful disk or SMB
    mount and unmount, the auto-mounts included.
  - `networking.subscribeNetworkBridgesChange(handler)` — when a managed bridge create or
    delete settles, a failed one included (netplan may have written part of it).
  - `vmManager.subscribeVMBackupDeleted(handler)` and
    `containerManager.subscribeContainerBackupDeleted(handler)` — after a backup was
    deleted by any caller (the routes, the scheduler's retention); `lib/backupStatus.js`
    passes them on to the `backups` topic, which carries every backup-list cue.
  - `containerManager.subscribeImagesChange(handler)` — on containerd's
    `/images/create`, `/images/update` and `/images/delete` in the `wisp` namespace:
    every pull, update and delete, outside ones included, and once more when the event
    stream resubscribes (events missed meanwhile). The macOS stub never fires.
  - `library.subscribeLibraryChange(handler)` — after every upload, rename, delete and
    finished download into the library, and after a failed upload or download removed
    its partial file.
  - `lib/apiTokens.js` `subscribeApiTokensChange(handler)` — after a token is created or
    revoked.
  - `lib/wispUpdate.js` `subscribeWispUpdateChange(handler)` — after every self-update
    check settles (manual, hourly, failed): each rewrites the cached status.
- **Managers are configured, not reaching out**: `lib/managerBootstrap.js` calls each
  manager's `configure()` with its paths and callbacks (`resolveMount`,
  `tryAcquireOperationLock`) before any route registers. The start's state migrations
  configure and connect them first, with the tolerant config reader and
  `{ watchEvents: false }`: no event subscriptions or timers, so none of the event-driven
  writes (restart-flag clearing, the network probe), and uncached lists that are complete
  or throw. They disconnect when done, and the start connects again with events for
  normal work. Reads write nothing in either mode.
- **Mechanism is decoupled from trigger.** Any background or maintenance mechanism (the
  update poll, apt checks, job-TTL cleanup, reconcilers, scheduled backups) is an
  invocable unit; its triggers — boot, a schedule, events, a manual run — are wired
  separately, and any trigger can invoke any mechanism. A manual run always works, for
  testing or because it is needed now. Log for every execution what triggered it and the
  result.

## Transport

- **One multiplexed SSE stream per tab, `/api/events`**, carries every always-on feed as
  `{ topic, data }` frames: `stats` (sampled every 5 s), and the event-driven `vms`,
  `containers`, `sections`, `discovery`, `home`, `backups`, `jobs` and `changes` (references to
  saved records no other topic carries, which a client showing them GETs again). One
  connection, not one per feed, because browsers cap plain HTTP/1.1 at 6 connections per
  origin: a new always-on feed is a new topic, never a new endpoint
  ([`specs/API.md`](specs/API.md), Events stream).
- **Each connect opens with the current state**: a new subscriber gets each topic's last
  frame, and the client replaces its list with it, so one reconnect replaces any stale
  state. `changes` is the exception: its frames are references, not state, and are not
  replayed to late subscribers; its connect frame `{ kind: "all" }` tells the client to
  GET what it shows.
- **A topic's frame is its whole current state** `[PROJECT]`, on connect and on every
  change, and a topic may be shaped for the screen that shows it (`home`) (settled
  2026-11-15: kept over the template's one-record events and "records, not screens";
  with one user the lists are small). `changes` is the exception: it carries a reference
  to the changed record, which a client showing it GETs ([`specs/API.md`](specs/API.md),
  `changes` topic payload).
- **What one view needs gets a scoped stream** `[PROJECT]`, open only while the view is
  on screen: per-workload stats and logs, the disk and USB streams. **Job progress**
  streams emit until the job completes or fails, then close. No repeated-GET polling for
  live data (settled 2026-11-15: kept over the template's by-reference GETs and its one
  connection per tab; logs, live stats and job progress are streams by nature, and the
  scoped ones stay few enough for HTTP/1.1's six connections per origin).
- **A stream that goes quiet is reopened**: the server writes a `: keepalive` comment
  every 25 s; the client re-arms a 60 s read watchdog on every chunk and reconnects with
  backoff when it fires. A frozen page can't run its watchdog, so every stream also
  resyncs on `visibilitychange → visible` and on `online` when it has had no bytes for
  longer than the keepalive. A lost session (`AUTH_REQUIRED` or `AUTH_INVALID`) sends the user to sign in; a 404 (the stream's subject
  is gone, e.g. a deleted container's logs) stops the stream instead of retrying.
- **Commands answer once the work has started; the outcome comes through the stream.** A
  command responds as soon as its input is valid and the work is underway, never waiting
  for it to finish. It answers with an ack that names what to follow (the job or the
  record), or with the error that kept it from starting (validation, a conflict, a
  failed start). Everything after that (progress, the new state, a later failure)
  reaches clients as events on the records they follow. A request that changes no state,
  such as a check or a preview, answers with its result; so does a secret shown only
  once. An instant command, a settings save included, answers with the ack too, never
  its result (settled 2026-11-15, sharpening the template line restored 2026-11-13).
- **Consoles are WebSockets under `/ws`**: VNC bridges the browser to QEMU's VNC port over
  TCP on `127.0.0.1` ([`specs/CONSOLE.md`](specs/CONSOLE.md)); the container shell drives
  containerd's exec with a PTY. Both authenticate with the session cookie the browser
  sends on the upgrade — no token in the URL.

## Repo layout & subsystem boundaries

- `backend/` (the server: `src/index.js` the start, `src/app.js` the app it builds, `src/routes/`, `src/lib/`; `scripts/` holds the
  privileged helpers and the updater; `migrations/` the state migrations, which
  `src/lib/stateMigrations.js` runs at the start), `frontend/` (the client), `scripts/`
  (install, setup, push, release), `systemd/` (unit templates), `config/` (examples).
  Each package has its own `package.json`.
- Backend subsystems are named modules under `src/lib/`, each behind a facade `index.js`,
  with platform implementations under `<module>/linux/` and `<module>/darwin/`. App glue —
  Wisp's own orchestration — stays flat at the top of `src/lib/`, and routes do HTTP
  concerns and call the facades and the glue. The fences between them are CODING-RULES
  §7: one caller per external system, and managers free of Wisp glue. The import graph
  stays acyclic, enforced by a lint (settled 2026-11-15: restored from the template).
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
- `library` — the image library's files: it owns every write to the library directory
  (upload, rename, delete, and the downloads, through `downloads`, that land a file
  there) and announces each ([`specs/IMAGE-LIBRARY.md`](specs/IMAGE-LIBRARY.md)).
- `mcp` — the MCP endpoint: tools over the same facades and glue as the routes, secrets
  masked ([`specs/MCP.md`](specs/MCP.md)).
- App glue — auth and API tokens, settings, cloud-init, backups (scheduler, retention,
  destinations), the job store and its starter (`lib/jobs`: every job, whatever starts
  it), operation locks, the update checks' jobs and their hourly trigger
  (`lib/updateChecks.js`), the mDNS reconcilers, LAN discovery, the home page and
  self-update.
