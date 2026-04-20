# Container Management

Wisp supports running OCI containers alongside VMs using containerd as the runtime. Containers appear in the same unified list as VMs, with filtering options.

## Architecture

```
Frontend (containerStore) ──REST+SSE──▶ containers.js route ──▶ containerManager facade
                                                                       │
                                                    ┌──────────────────┼──────────────────┐
                                                    ▼                  ▼                  ▼
                                         containerManagerConnection  containerManagerSpec  containerManagerNetwork
                                            (gRPC to containerd)     (OCI spec builder)    (bridge CNI exec)
```

Containers follow the same architectural patterns as VMs:

- **Backend**: `backend/src/lib/containerManager.js` is a platform facade (loads `linux/containerManager/` on Linux or `darwin/containerManager/` on macOS). Linux modules live under `backend/src/lib/linux/containerManager/`; only those import `@grpc/grpc-js`.
- **Communication**: gRPC to containerd (via `@grpc/grpc-js`) instead of DBus to libvirt
- **Frontend**: Dedicated Zustand store (`containerStore.js`), SSE for live data
- **API routes**: `backend/src/routes/containers.js` mirroring VM routes

## containerd Connection

- Socket: `/run/containerd/containerd.sock` (override: `WISP_CONTAINERD_SOCK`)
- Namespace: `wisp` (set via gRPC metadata header `containerd-namespace: wisp`)
- Required version: containerd 2.0+
- Proto files: `backend/src/protos/containerd/` (loaded by `@grpc/proto-loader`). **Field numbers must match the installed containerd** (e.g. `types/mount.proto`: `target` is field 3, `options` is field 4 as in containerd 2.x; an older `options = 3` definition decodes overlay options incorrectly and task create fails with empty overlay `data`).
- gRPC services used: Version, Namespaces, Containers, Tasks, Images, Content, Snapshots, Events, Leases, Transfer

## Data Model

Each container has a directory at `/var/lib/wisp/containers/<name>/`:

```
/var/lib/wisp/containers/<name>/
  container.json        # Source-of-truth config
  files/                # Per-mount backing paths: files/<mountName> (file) or files/<mountName>/ (directory)
  runs/
    <runId>.log         # stdout/stderr for one task run
    <runId>.json        # sidecar metadata for that run
```

**Per-run log files.** Every start that creates a new task (`startExistingContainer`) allocates a fresh **runId** — a filesystem-safe ISO-8601 timestamp (`2026-04-18T12-34-56-789Z`, colons and dots replaced with hyphens). Task `stdout` / `stderr` are both set to a `file://` URI pointing at `runs/<runId>.log` so **containerd-shim-runc-v2** opens the file and copies process output (same idea as containerd's `LogFile` helper). Do not use `binary:///usr/bin/tee?…` here: the shim builds logger argv from query **key/value pairs**, not a bare path, so tee would not receive the log file argument as intended.

Alongside each log file, the backend writes a JSON sidecar with run metadata:

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Matches the filename stem. |
| `startedAt` | string | ISO 8601 time the run was allocated (immediately before `tasks.create`). |
| `endedAt` | string \| null | ISO 8601 time the task exited (set in `cleanupTask` after `tasks.delete` returns). Null while the run is active. |
| `exitCode` | number \| null | Process exit status from the `Tasks.Delete` response. Null while the run is active, or when the exit code is unavailable. |
| `imageDigest` | string \| null | Library image digest the container was running at the time of the run, if known. |

**Retention.** The newest **10** runs are kept; older log+sidecar pairs are pruned on every new-run allocation. No separate GC job. Container delete removes the whole container directory, including all runs.

**Finding the current run.** The active run is the one whose sidecar has `endedAt === null`. `cleanupTask` — called from `stopContainer` / `killContainer`, and also as a stale-task cleanup inside `startExistingContainer` before re-creating — captures the `exit_status` field from the `Tasks.Delete` response and writes both `endedAt` and `exitCode` to the sidecar in a single `finalizeRun` call. Already-finalized sidecars are not rewritten. Backend restart is safe: the "current" run is not tracked in memory, so a container mid-run looks identical across restarts.

### container.json Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Container name (alphanumeric, 1-63 chars) |
| `image` | string | (required) | OCI image reference (e.g. `nginx:latest`) |
| `command` | string[] \| null | null | Command override (default: image entrypoint+cmd) |
| `cpuLimit` | number \| null | null | CPU limit in cores (e.g. 2.0) |
| `memoryLimitMiB` | number \| null | null | Memory limit in MiB |
| `restartPolicy` | string | `"unless-stopped"` | One of: `never`, `on-failure`, `unless-stopped`, `always` |
| `autostart` | boolean | false | Start on backend boot |
| `runAsRoot` | boolean | false | Run the container process as UID/GID 0 instead of the Wisp deploy user. Required for images that write to root-owned directories (e.g. OpenWebUI). When true, bind-mount files under `files/` are root-owned; container deletion may require `sudo` for those paths. Requires restart. |
| `localDns` | boolean | false | Enable mDNS registration for this container on the LAN. New containers default to `true`; existing containers without this field are treated as `false` for upgrade safety. |
| `env` | object | `{}` | Environment variables. Structured shape: `{ KEY: { value: string, secret?: true } }`. Entries without `secret` are plaintext; `secret: true` marks the entry as write-only — see **Secret env vars** below. |
| `mounts` | array | `[]` | Bind mount definitions (see Mount entry); backing data lives under `files/<name>` |
| `network` | object | `{ "type": "bridge" }` | Network configuration (see below) |
| `exposedPorts` | string[] | `[]` | Ports declared by the image (`EXPOSE` directives), e.g. `["80/tcp", "443/tcp"]`. Set at create time from the OCI image config; informational only (containers expose all listening ports on the LAN) |
| `createdAt` | string | (auto) | ISO 8601 creation timestamp |
| `iconId` | string \| omitted | omitted | Optional UI icon key (same ids as VM icons in the app; default client icon when omitted) |
| `app` | string \| omitted | omitted | App registry ID (e.g. `”caddy-reverse-proxy”`). When set, the container uses a dedicated app module for config management. See [CUSTOM-APPS.md](CUSTOM-APPS.md). |
| `appConfig` | object \| omitted | omitted | Structured config for the app. Shape is app-specific. Only present when `app` is set. Source of truth — `env`, `mounts`, and mount files are derived from it. |
| `pendingRestart` | boolean \| omitted | omitted | Set `true` when `appConfig` changes while the container is running and the app cannot live-reload. Cleared on start/restart. Not writable via PATCH. (Image-version drift is surfaced via the derived `updateAvailable` field on API responses; it's not persisted.) |
| `imageDigest` | string \| omitted | omitted | Server-managed: top-level manifest/index digest (`sha256:…`) of the library image the container's rootfs was last built from. Written at **create** and refreshed on every start when the library digest has changed. Used by the image update checker to detect drift. Not writable via PATCH. |
| `imagePulledAt` | string \| omitted | omitted | Server-managed: ISO 8601 timestamp of the last `imageDigest` change (i.e. when the container last adopted a new image). Not writable via PATCH. |
| `updateAvailable` | boolean (derived) | omitted | Not stored on disk — derived at read time when the list/detail endpoints build their response. `true` when the container's task is RUNNING or PAUSED **and** its stored `imageDigest` no longer matches the library's current digest for `image` (looked up from `oci-image-meta.json`). Stopped containers always read as `false`; they adopt the new digest automatically on next start. Not writable via PATCH. |

### `network` object

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `bridge` — container is attached as a veth port on a host Linux bridge (LAN DHCP) |
| `interface` | string | Host Linux bridge used as the parent for the container's veth pair (e.g. `br0` or a VLAN sub-bridge `br0-vlan10`). Required at start; a setup-time probe rejects anything that is not an existing Linux bridge. At **create**, defaults to the first bridge whose name is not VLAN-style (`br0-vlanN` / `iface.VID`); if none, the first listed bridge. |
| `ip` | string \| omitted | Set by the backend after a successful CNI **ADD** (IPv4 with mask, e.g. `192.168.1.50/24`). Not writable via PATCH while the task is running (ignored in the merge). |
| `mac` | string | Required. Locally administered unicast format (`aa:bb:cc:dd:ee:ff`). Assigned at create (random if omitted), persisted in `container.json`, and passed to the CNI bridge plugin on each **ADD** so the DHCP client identity (and therefore the lease) stays stable across stop/start. User-editable via PATCH when the container is **not** running (`running` / `paused` / `pausing` block MAC or interface changes). Legacy configs without a MAC get one on first **GET** (`/api/containers/:name`) or before **start**. |

### Mount entry

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"file"` — bind a single host file; `"directory"` — bind a host directory |
| `name` | string | Single path segment: storage key; host path is `files/<name>` (file) or `files/<name>/` (directory). Must be unique among mounts. |
| `containerPath` | string | Absolute path inside the container (unique among mounts) |
| `readonly` | boolean | Bind mount read-only when true |

After **PATCH** persists **`mounts`**, or after **POST** `/api/containers/:name/mounts` adds one mount, the backend creates any **missing** backing file or directory under `files/<name>` automatically (empty file or empty directory) so new rows are usable without a separate **Init** call.

### Secret env vars

Individual env vars can be marked `secret: true` to hide their values from the UI. Secret values are persisted in `container.json` like any other env var (the OCI process needs them at runtime), but:

- **`GET /api/containers/:name`** strips the value and returns `{ value: null, secret: true, isSet: boolean }` for every secret entry. `isSet` is `true` when a value is stored on disk.
- **`PATCH /api/containers/:name`** only accepts env-var changes through the **`envPatch`** delta (a plain `env` field is rejected with `CONFIG_ERROR`). See API.md for the delta shape.
- Flipping a key from `secret: true` to `secret: false` without providing a new value clears the stored value server-side. This is intentional: since the UI never received the old value, there is nothing to preserve. The UI warns the user before flipping the toggle.
- Creating a brand-new secret key without a `value` is rejected with `CONFIG_ERROR` (`Secret env var "X" requires a value`).

Legacy `container.json` files with a flat `env: { KEY: "value" }` dict are normalized on first **GET** `/api/containers/:name` (written back to disk as `{ KEY: { value: "value" } }`) — existing entries become non-secret.

## Backend Modules

All under `backend/src/lib/`:

| Module | Purpose |
|--------|---------|
| `containerManager.js` | Facade re-exporting all container operations |
| `containerManagerConnection.js` | gRPC client setup, proto loading, connect/disconnect |
| `containerManagerList.js` | `listContainers()`, `getContainerConfig()`, `getRunningContainerCount()` (running count for host stats SSE) |
| `containerManagerLifecycle.js` | `startContainer()`, `stopContainer()`, `restartContainer()`, `killContainer()`, `getTaskState()`, `startAutostartContainersAtBackendBoot()`, `normalizeTaskStatus()`, `containerTaskStatusToUi()` (gRPC task enums may arrive as names, indices, or string digits — normalize before API/UI) |
| `containerImageRef.js` | `normalizeImageRef()` — docker.io/library/ prefix rules (shared with pull/delete) |
| `containerManagerCreate.js` | `pullImage()`, `createContainer()`, `deleteContainer()` |
| `containerManagerImages.js` | `listContainerImages()`, `deleteContainerImage()` (containerd Images service; delete blocked if any Wisp container references the image) |
| `containerManagerOciSize.js` | `compressedBlobSizeForImageName()` — sums compressed config + layer sizes from the resolved Linux image manifest (not the top-level manifest blob size) |
| `containerManagerConfig.js` | `updateContainerConfig()` |
| `containerManagerStats.js` | `getContainerStats()` |
| `linuxProcUptime.js` | `processUptimeMsFromProc(pid)` — container uptime from `/proc` (survives backend restart; in-memory `containerStartTimes` is only a fallback) |
| `linuxProcIpv4.js` | `ipv4CidrFromProcFibTrie(pid)` — read primary IPv4 from `/proc/<pid>/net/fib_trie` when the task PID is known (no sudo) |
| `containerManagerLogs.js` | Per-run log files under `runs/`: `listContainerRuns()`, `getContainerRunLogs()`, `streamContainerRunLogs()`, `createNewRun()`, `finalizeRun()`, `findCurrentRunId()`, `resolveRunId()`, `createRunLogReadStream()` |
| `containerManagerMounts.js` | `validateAndNormalizeMounts()`, `findMount()`, `ensureMountArtifactIfMissing()`, `ensureMissingMountArtifacts()`, `assertBindSourcesReady()` |
| `containerManagerMountCrud.js` | `addContainerMount()`, `updateContainerMount()`, `removeContainerMount()` — row-scoped bind mount CRUD |
| `containerManagerMountsContent.js` | `uploadMountFileStream()`, `uploadMountZipStream()` (system **`unzip`**, paths checked with **`unzip -Z1`** before extract), `initMountContent()`, `getMountFileTextContent()`, `putMountFileTextContent()`, `deleteMountData()`, `deleteMountBackingStore()` |
| `containerManagerNetwork.js` | `setupNetwork()`, `teardownNetwork()`, `mergeNetworkLeaseIntoConfig()` (persist DHCP IP / MAC to `container.json`) |
| `containerManagerSpec.js` | `buildOCISpec()` |
| `containerPaths.js` | Path helpers for container directories |
| `containerManagerExec.js` | `execInContainer()`, `resizeExec()` — interactive shell via containerd `Tasks.Exec` + PTY (FIFO stdio), used by the container console WebSocket |

## Interactive console (exec)

The **Console** tab on the container overview opens an in-browser terminal (**xterm.js**) connected to **`GET /ws/container-console/:name`**. The backend:

1. Requires the container **task** to be **running** (`Tasks.Get` → `RUNNING`).
2. Creates a per-session directory under **`${containersPath}/.exec-sessions/`** with **named pipes** for stdin/stdout (not `os.tmpdir()` / `/tmp`, so systemd **PrivateTmp** on the Wisp service does not hide FIFOs from containerd). Passes **absolute paths** (not `file://` URIs) as `stdin`/`stdout` on **`Tasks.Exec`** — the shim resolves paths with `os.Stat`/`open` and does not strip URL schemes. Then `terminal: true` and an OCI **Process** spec (`args: ["/bin/sh"]`, env includes `TERM=xterm-256color`). **`Tasks.Start`** for the exec id runs **concurrently** with opening the backend’s FIFO read/write streams; doing Start first and opening FIFOs after deadlocks named pipes until containerd’s console copy times out (`DEADLINE_EXCEEDED`).
3. Opens the FIFOs and bridges **binary WebSocket frames** to the streams; **text** frames with `{ type: "resize", cols, rows }` call **`Tasks.ResizePty`**.
4. On WebSocket close, **`Tasks.Kill`** (SIGKILL) + **`Tasks.DeleteProcess`** for the exec id, then removes the temp directory.

The exec process uses the same **UID/GID** as the main container task (`runAsRoot` in `container.json` vs deploy user). macOS dev builds have no containerd — the console WebSocket is unavailable (same as other container operations).

## OCI Runtime Spec

`buildOCISpec()` generates an OCI 1.1.0 runtime spec from `container.json` + image config:

- Default Linux namespaces: pid, ipc, uts, mount, network, cgroup. For **`network.type: bridge`**, the network namespace uses **`path: /var/run/netns/<name>`** so the process joins the netns CNI configured (a bare `network` namespace without `path` would be a new empty netns and ignore the CNI-created veth).
- Default capabilities: standard container set (chown, net_bind, etc.)
- Default mounts: proc, dev, devpts, shm, mqueue, sysfs, cgroup, run
- **Process user:** `process.user` uses the **backend process UID/GID** (the systemd deploy user) by default, so files created on bind mounts under `files/<name>/` remain owned by that user and the backend can delete them. If the backend runs as root (unusual), UID/GID stay 0. When **`runAsRoot: true`** is set in `container.json`, UID/GID are forced to 0 — required for images that write to root-owned directories inside the container (e.g. OpenWebUI writing `.webui_secret_key` to `/app`). Bind-mount data created while running as root will be root-owned; container deletion may require sudo for those paths.
- User bind mounts: `files/<mountName>` per `mounts[].name` (`type` determines file vs directory)
- CPU quota/period from `cpuLimit`, memory limit from `memoryLimitMiB`
- `/etc/resolv.conf` bind-mounted from host. When the container's bridge has the Wisp stub IP (`169.254.53.53/32` on `br0`, installed by `scripts/linux/setup/container-dns.sh`), the shared `/var/lib/wisp/container-resolv.conf` is used — a single `nameserver 169.254.53.53` line — so containers reach the in-process DNS forwarder in `wisp-backend` (see **Local DNS** below). Without the stub IP (e.g. VLAN sub-bridges, or setup skipped), fall back to the host's upstream resolvers (`/run/systemd/resolve/resolv.conf` on resolved hosts, else `/etc/resolv.conf`) — resolved's `127.0.0.53` stub is unreachable from a container netns

## Networking

Containers are attached as **veth ports on a host Linux bridge** (`br0`, or a VLAN sub-bridge `br0-vlanN`) via the **CNI bridge plugin**, exactly the same topology libvirt uses for VM NICs. Each container gets its own MAC, its own DHCP-assigned LAN IP, and — critically — **is reachable from the host** because the host already has an IP on the same bridge. This replaced an earlier macvlan setup, which isolated containers from the host by kernel design.

- **No Docker-style `-p` publish:** The container is on the LAN like a small VM. If nginx listens on port 80 inside the image, browse to `http://<container-ip>/` from any machine on the same LAN — including the Wisp host itself. Firewall rules on the host or image still apply. The Network section shows `ExposedPorts` from the OCI image config (Dockerfile `EXPOSE` directives) as informational badges so users know which ports the image intends to serve.
- **Stable MAC:** Wisp assigns a locally administered MAC at create time, persists it in `container.json`, and passes it to the CNI bridge plugin on every **ADD** as the top-level `mac` field. `cni-dhcp` keys leases by MAC, so a container keeps the same IP across stop/start.
- **Interface selection:** `network.interface` must be an existing Linux bridge (`br0`, `br0-vlan10`, etc.). The UI picks from the host bridge list (`/api/host/bridges`). Interface changes require the container to be stopped. For a VLAN-specific container, create a managed VLAN bridge (e.g. `br0-vlan10`) in Host Mgmt and point the container at it.
- **Host ↔ container reachability:** Free on the untagged bridge — no `promiscMode`, no extra routing. Host reachability **on VLAN sub-bridges** is a host-config concern (the host needs an IP on that sub-bridge); Wisp itself does not configure it.
- **Pre-ADD bridge validation:** `setupNetwork()` asserts `/sys/class/net/<iface>/bridge` exists before every CNI ADD. Without this, the bridge CNI plugin would silently create an orphan bridge under the given name.
- **IP in the UI:** After each successful CNI **ADD**, the backend stores `network.ip` in `container.json` (and may fill `mac` from the CNI result only when no MAC was already persisted). With **`ipam.type: dhcp`**, the CNI result often has **no `ips[]`** (the `cni-dhcp` daemon assigns the address shortly after). When the container **task PID** is known, Wisp prefers reading the address from **`/proc/<pid>/net/fib_trie`** (no sudo). Before the task exists (e.g. polling right after CNI **ADD**), or if `/proc` parsing finds no address, Wisp falls back to **`sudo wisp-netns ipv4 <name> eth0`**. **`GET /api/containers/:name`** also probes if the task is running but `network.ip` is still empty — so the UI catches up after DHCP is slow.
- Re-run **`install-helpers.sh`** after upgrading so `/usr/local/bin/wisp-netns` includes the **`ipv4`** subcommand (needed for fallback when PID is unavailable or `/proc` has no lease yet).
- CNI plugins installed to `/opt/cni/bin/` by `scripts/linux/setup/cni.sh`
- Systemwide conflist at `/etc/cni/net.d/10-wisp-bridge.conflist`: `type: bridge`, `isGateway: false`, `ipMasq: false`, `hairpinMode: false`, `promiscMode: false`, `forceAddress: false`, `ipam.type: dhcp`. The `bridge` field is overridden per container from `network.interface` before each invocation.
- DHCP IPAM via `cni-dhcp.service` systemd unit (plugin-agnostic; key on MAC)
- Network namespace per container at `/var/run/netns/<name>`
- CNI plugins are invoked via the **`wisp-cni`** privileged helper and **`sudo -n`** when the backend runs as the deploy user (`User=` in systemd). Stdin netconf merges **`.conflist` top-level `cniVersion` and `name` into the bridge `plugins[0]` object** (the fragment alone is not valid for a direct plugin exec). **`wisp-netns`** creates `/var/run/netns/<name>` with `ip netns add`. Install both with **`install-helpers.sh`** / **`wispctl.sh helpers`** (same pattern as `wisp-mount`). **`cni-dhcp.service`** must be running when using `ipam.type: dhcp`.
- Before **ADD**, if the netns file already exists, **`setupNetwork`** runs **CNI DEL** and **`ip netns delete`** so a leftover **`eth0`** from a failed stop does not cause `ADD` to error on "device exists".

## Local DNS (mDNS)

Two independent pieces. **Publishing** advertises a container as `<name>.local` on the LAN so peers can find it. **Resolution** lets an app *inside* the container query `foo.local`.

### Publishing (avahi-daemon via DBus)

- Controlled by **`localDns`** in `container.json`
- Name source: container name, sanitized to a DNS label (lowercase alnum + `-`, max 63 chars)
- Address source: `network.ip` (CIDR mask stripped before registration)
- Register points: create/start after IP is known; running detail fetch if DHCP lease arrives late
- Deregister points: stop, kill, delete, or `localDns` toggle set to false
- UI: Network section has a **Local DNS** toggle; stats bar shows the registered `.local` hostname when active
- Best-effort behavior: if avahi-daemon is unavailable, container operations continue unchanged and mDNS is skipped
- **Avahi restart recovery:** `mdnsManager.js` subscribes to DBus `NameOwnerChanged` on `org.freedesktop.Avahi`. When avahi-daemon disappears (package upgrade, manual restart), the in-memory entry map is kept but each entry's `group` handle is cleared. When avahi reappears, every stored registration is re-added. Without this, restarting avahi would silently drop all container publications until wisp-backend was restarted too

### Resolution (in-process DNS forwarder on 169.254.53.53)

Container apps that `getaddrinfo("foo.local")` need a resolver that speaks mDNS. Rather than install mDNS infrastructure inside every container — or stand up a second mDNS daemon on the host — Wisp runs a small **DNS forwarder inside the wisp-backend process** (`backend/src/lib/linux/mdnsForwarder.js`) that containers query via unicast DNS. The forwarder translates `.local` queries into avahi DBus calls and relays everything else to the host's upstream DNS.

- `scripts/linux/setup/container-dns.sh` assigns link-local **`169.254.53.53/32`** to `br0` and writes `/var/lib/wisp/container-resolv.conf` (a single `nameserver 169.254.53.53` line)
- `mdnsForwarder.js` binds **UDP + TCP port 53** on `169.254.53.53`. Binding to privileged port 53 requires `CAP_NET_BIND_SERVICE`, granted to `wisp-backend.service` via `AmbientCapabilities=CAP_NET_BIND_SERVICE` (the service otherwise runs unprivileged as the deploy user)
- When the container's bridge carries the stub IP, `resolveContainerResolvConf()` returns the shared `container-resolv.conf` and the OCI spec bind-mounts it at `/etc/resolv.conf`
- After CNI ADD, `setupNetwork` installs `169.254.53.53/32 dev eth0` inside the container's netns via `wisp-netns route-add`. Without this on-link /32, the container's kernel would send DNS to the LAN gateway (its DHCP default route) and queries would black-hole; the route makes the kernel ARP directly on the veth so br0 answers
- Containers on bridges without the stub IP (VLAN sub-bridges, setup skipped) fall back to the host's upstream resolvers and get no `.local` resolution — same as before the feature
- Boot-time recovery: `169.254.53.53/32` is a runtime-only address (dropped on every reboot). `wisp-backend.service` carries an `ExecStartPre=+` line (privileged exec via `+`, even though the service runs as the deploy user) that re-asserts it idempotently. The unit also declares `After=network-online.target Wants=network-online.target` so `br0` actually exists by then

**Forwarder dispatch logic:**

| Query | Handling |
|---|---|
| `*.local` forward (A / AAAA) | `resolveLocalName` → avahi `ResolveHostName` over DBus. Returns the IP from avahi's local record cache (for names Wisp published) or from a multicast query (for LAN peers). Same-host lookups work because the DBus call bypasses multicast entirely, sidestepping avahi's same-host loop prevention |
| `*.in-addr.arpa` / `*.ip6.arpa` (PTR) | `resolveLocalAddress` → avahi `ResolveAddress` over DBus. Falls through to upstream on miss so real reverse zones still resolve |
| Everything else | Raw UDP relay to the first IPv4 `nameserver` from `/etc/resolv.conf` (on systemd-resolved hosts, that is `127.0.0.53` — resolved handles real forwarding). `UPSTREAM_TIMEOUT_MS=5000`, SERVFAIL on timeout |

The forwarder hand-rolls minimal DNS packet parse/build (A/AAAA/PTR answers only; responses use a name-compression pointer back to the question section). It never blocks the node event loop: avahi DBus calls and upstream UDP relays are async, with bounded timeouts. If port 53 can't be bound (missing capability, stub IP not on br0), the forwarder logs a warning and the backend continues to run — VM/container management works, only `.local` inside containers is unavailable.

**Why this instead of `systemd-resolved` as the stub:** systemd-resolved with `MulticastDNS=resolve` and avahi-daemon both want to bind UDP 5353 and conflict in practice (resolved's mDNS queries time out because avahi owns the multicast group). An earlier design used resolved at the stub address and worked around the conflict with a bind-mounted `/etc/hosts` in every container; the forwarder replaces both pieces with a single path that goes directly to avahi.

## Image Management

- Image references without a registry prefix default to `docker.io/library/`
- **Local-image shortcut:** before normalization + pull, `createContainer` calls `Images.get({ name: spec.image })` against containerd. If the exact literal ref already exists (for example an image loaded with `ctr -n wisp image import foo.tar`, or one picked verbatim from the image library), it is used as-is — no normalization, no pull — and the create SSE emits a `using-local` step instead of `pulling`. This is what lets locally built images such as `myapp:v1` or `localhost/myapp:dev` work: the normalize step would otherwise rewrite them to `docker.io/library/…` and the registry pull would fail. Registry-named refs (`nginx:latest` and friends) still go through the normalize + pull path unchanged.
- **Picker:** the Create Container form has a **Browse…** button next to the Image field that opens the shared image library modal pre-filtered to the **OCI** tab. Any image visible to `GET /api/containers/images` (anything in the `wisp` containerd namespace) is selectable; picking one populates the Image field verbatim so the local-image shortcut above applies.
- Image pulling uses the Transfer gRPC service with protobuf-encoded Any fields
- Transfer `source` (OCIRegistry) and `destination` (ImageStore) are packed via `packProtoAny` using `protobufjs` for binary encoding (required because `@grpc/proto-loader` only exposes descriptor objects, not encodable Types)
- Multi-platform images (OCI index / Docker manifest list) are resolved to **Linux + host architecture** (`process.arch` → OCI architecture) before reading the image config. There is **no** fallback to the first index entry (registry order may list Windows or other OS first). If no matching Linux manifest exists for the host arch, image resolution fails with a clear error listing available platforms. Nested indexes are walked until a concrete image manifest is reached.
- The Transfer `ImageStore` destination sets **`platforms`** (download filter) **and** `unpacks` (snapshot unpack) to the same host platform (`linux/<arch>`). Without `platforms`, containerd downloads layers for **all** listed platforms (including Windows), which makes multi-arch pulls like `caddy:latest` extremely slow. With `arm64`, `variant: v8` is included on both fields.
- Image config (Entrypoint, Cmd, Env, WorkingDir, rootfs.diff_ids) read from content store
- The Transfer `ImageStore` destination includes an `unpacks` field (proto field 10) so containerd unpacks layers into overlayfs snapshots during pull
- Snapshot parent key is the chain ID computed from `rootfs.diff_ids` using full digest strings including the `sha256:` prefix (matches Go's `identity.ChainID` which concatenates `digest.Digest` values directly)
- Images are stored in containerd's content store, not in Wisp's filesystem
- Create progress is delivered over **SSE** (`/api/containers/create-progress/:jobId`). Large pulls may run for many minutes without real **percentage** (containerd Transfer does not expose it through the current unary API); the UI shows **elapsed time** every 15s during pull. The production **frontend** proxy disables idle **body timeout** on `/api` so long-lived SSE streams are not cut off (older installs that only updated the backend could see `BodyTimeoutError` in `wisp-frontend` logs).

### Image updates

Wisp checks every OCI image in the library for upstream changes and flags containers running stale bits.

- **Trigger:** a background sweep runs **60 seconds after backend boot** and **every hour** thereafter. The UI also exposes two manual triggers from the Image Library OCI tab — a bulk **Check for updates** button and a per-row **Check this image** button.
- **How the check works:** for each image, the current top-level digest is recorded, the image is re-pulled via the existing Transfer service, and the new digest is compared. The pull is idempotent — when the upstream digest is unchanged, containerd does **HEAD** only and skips layer downloads. When the digest differs, new layers are downloaded and stored alongside the old ones (containerd keeps whichever are still referenced by a snapshot).
- **Skipped images:** locally built or unreachable refs (no registry, auth required, network down) emit a `skipped` event and continue — one failure never aborts the sweep.
- **Surfacing updates on containers:** nothing is written to container.json. The container list/detail endpoints derive `updateAvailable` per container from (`container.imageDigest` ≠ library digest for its ref) + (task is RUNNING/PAUSED). The library digest comes from `oci-image-meta.json`, refreshed by every `listContainerImages()` call (including the background sweep above). Stopped containers always read as `false` — they adopt the new digest on their next start via `startExistingContainer`. The check's SSE `flagged-container` events and `imagesUpdated` count are computed from the same derivation, so the UI surfaces matching counts without persistent flags.
- **Apply on start (and restart):** `startExistingContainer` always removes the existing rootfs snapshot and re-prepares it from the current library image before creating the task — rootfs is ephemeral and any state must live in bind mounts. If containerd's current digest for the reference differs from the stored `imageDigest`, both `imageDigest` and `imagePulledAt` are refreshed. `updateAvailable` is always cleared on start (whether or not it was set). No registry I/O happens here; the restart consumes whatever the most recent check-updates pull (or create-time pull) left in the local image store. No rollback logic: if `prepareSnapshot` fails, the container fails to start and the user must recreate.
- **Cached summary:** `GET /api/containers/images/update-status` returns `{ lastCheckedAt, imagesChecked, imagesUpdated }` from the last bulk or single-image run (in-memory, lost on restart).
- **Modified timestamp stability:** containerd's Transfer service bumps the image's `updatedAt` on every pull, including idempotent re-pulls. To keep the Image Library's **Modified** column meaningful, Wisp pins each image's displayed timestamp in a sidecar `oci-image-meta.json` next to `wisp-config.json` (shape: `{ ref: { digest, updatedAt } }`). The sidecar tracks all OCI images regardless of whether any container uses them. `listContainerImages` returns the pinned value while the digest is unchanged, adopts containerd's current `updatedAt` when the digest changes or the entry is new, and prunes refs no longer present in containerd.
- **Pinned digests:** containers whose `image` is `ref@sha256:…` never flag updates — correct behavior (immutable by design).
- **Module:** `backend/src/lib/linux/containerManager/containerManagerImageUpdates.js` (bulk/single entry points + `startImageUpdateChecker`/`stopImageUpdateChecker`). The background timer and SIGTERM-safe AbortController mirror `osUpdates.js`.

### Debugging slow or stuck image pulls (on the server)

- **Wisp logs:** `journalctl -u wisp-backend -u wisp-frontend -f` — backend shows pull/snapshot errors; frontend shows proxy errors (e.g. undici `BodyTimeoutError` if an old frontend build is still running).
- **containerd images (namespace `wisp`):** `sudo ctr -n wisp images ls` — confirm the image reference appears after a successful pull.
- **Active pull:** `sudo ctr -n wisp tasks ls` is usually empty until the container is started; during pull, watch backend logs or `ctr -n wisp content ls` (large output) only if deep debugging is needed.

## Container Lifecycle

1. **Create**: Pull image (with unpack) → Prepare snapshot → Build OCI spec → Define container in containerd (**stopped** — no CNI, no task). User configures mounts and settings, then **Start**.
2. **Start** (stopped): Ensures each mount’s backing path exists under `files/` and matches `type`. If the path is missing, the backend creates an empty file or empty directory automatically (same as **Init**). If a **STOPPED** task still exists in containerd, **Tasks.Delete** it first (otherwise **Tasks.Create** returns `already exists`). Enum status from gRPC may be numeric — normalize before comparing. Remove old rootfs snapshot → Refresh `imageDigest`/`imagePulledAt` and clear `updateAvailable` → Rebuild OCI spec → Prepare fresh snapshot from current library image → Setup networking → Create new task → Start task. `startExistingContainer` also best-effort deletes any stale task before create.
3. **Stop**: SIGTERM → Wait 10s → SIGKILL if needed → Delete task
4. **Kill**: SIGKILL → Wait 5s → Delete task
5. **Restart**: Stop then Start
6. **Delete**: Kill task → Tear down networking → Remove snapshot → Remove containerd container → Delete files on disk (`fs.rm` on the container directory). The main process runs as the **deploy user’s UID/GID** (see OCI section), so bind-mount data under `files/` is normally removable. Leftover **root-owned** paths from before that behavior (or from images that escalate to root) are **not** migrated or chowned by the app; fix on the host once (e.g. `sudo chown -R <deploy-user>:…` or remove that subtree) if delete fails with permission errors.

### Backend process startup (host boot / `wisp-backend` restart)

When the Wisp backend process starts (`backend/src/index.js`), after libvirt and containerd connection attempts and after mDNS manager connect:

1. **Configured mounts** — `ensureMounts()` runs to completion (awaited) so Host Mgmt SMB shares (and, later, removable-drive adoptions) are mounted before any autostart container starts (avoids bind mounts whose host paths live under those shares). The same pass also hard-converges: any mount under `/mnt/wisp/` not present in settings is unmounted.
2. **Container autostart** — `startAutostartContainersAtBackendBoot()` lists containers from disk + containerd; for each with `autostart: true` that is not already `running`, it calls `startContainer()`. Failures are logged per container and do not block other containers.
3. **mDNS warm-up** — For each running container (including any just started), if `localDns` is true and `network.ip` is set, the backend registers the `.local` address.

The HTTP server listens **after** these steps, so hosts with mounts configured may accept API traffic slightly later; when no mounts are configured, `ensureMounts` returns immediately.

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `CONTAINER_NOT_FOUND` | 404 | Container doesn't exist |
| `CONTAINER_RUN_NOT_FOUND` | 404 | Referenced `runId` does not exist in `runs/` |
| `CONTAINER_ALREADY_RUNNING` | 409 | Start called on running container |
| `CONTAINER_NOT_RUNNING` | 409 | Stop/kill called on stopped container |
| `CONTAINER_EXISTS` | 409 | Name conflict on create |
| `IMAGE_PULL_FAILED` | 422 | Failed to pull OCI image |
| `INVALID_CONTAINER_NAME` | 422 | Name validation failed |
| `INVALID_CONTAINER_MOUNTS` | 422 | Mounts array invalid |
| `CONTAINER_MOUNT_DUPLICATE` | 422 | Duplicate mount `name` or `containerPath` |
| `CONTAINER_MOUNT_NOT_FOUND` | 404 | No mount with that `name` in config |
| `CONTAINER_MOUNT_TYPE_MISMATCH` | 422 | Operation does not match mount `type` |
| `CONTAINER_ZIP_INVALID` | 422 | Zip archive missing or corrupt |
| `CONTAINER_ZIP_UNSAFE` | 422 | Zip path escapes target directory |
| `CONTAINER_MOUNT_SOURCE_MISSING` | 422 | Backing path missing when reading mount file content in the editor (GET content) |
| `CONTAINER_MOUNT_FILE_TOO_LARGE` | 422 | Mount file exceeds 512 KiB (editor GET/PUT) |
| `CONTAINER_MOUNT_FILE_NOT_UTF8` | 422 | Mount file is not valid UTF-8 (editor GET) |
| `BAD_MULTIPART_TOO_MANY_FILES` | 400 | More than one file part in a mount upload request |
| `CONTAINER_MOUNT_SOURCE_WRONG_TYPE` | 422 | Backing path is not a file/directory as required |
| `CONTAINERD_ERROR` | 500 | Generic containerd error |
| `NO_CONTAINERD` | 503 | containerd not reachable |

## Frontend

### Store

`containerStore.js` (Zustand) mirrors `vmStore.js`:

- `containers` list from SSE, `selectedContainer`, `containerConfig`, `containerStats`
- SSE: `startContainerListSSE()`, per-container stats SSE
- Actions: `startContainer()`, `stopContainer()`, `restartContainer()`, `killContainer()`, `deleteContainer()`

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `ContainerListItem` | `container/` | Left panel row with icon, name, image tag, state, hover actions |
| `ContainerOverviewPanel` | `container/` | Detail view with Overview and Logs tabs |
| `CreateContainerPanel` | `container/` | Create flow: name + image only; container stays stopped until user configures and starts |
| `ContainerStatsBar` | `container/` | Bottom stats bar (CPU%, memory, uptime) |
| `ContainerGeneralSection` | `sections/` | Name, image, command, CPU/memory limits, restart policy |
| `ContainerEnvSection` | `sections/` | Key-value editor for environment variables |
| `ContainerMountsSection` | `sections/` | **Mounts**: table (bridges-style); type icon column; container path (wider column) and mount name; read-only; per-row Save (PATCH full list), icon upload (file/zip) with optional multipart **`mounts`** for atomic save+upload, file editor modal |
| `MountFileEditorModal` | `sections/` | UTF-8 text editor for file-mount backing content (GET/PUT content API) |
| `ContainerNetworkSection` | `sections/` | Network type, interface, IP, MAC (editable when stopped + randomize), status |
| `ContainerLogsSection` | `sections/` | Live-scrolling log viewer for one **run** at a time. Top bar has a **run picker** (newest first; green dot = running, red = non-zero exit, gray = clean exit), a filter input, and icon-only actions: **Clear** viewer (client-side only — does not touch files), **Mark** (inserts a divider line with an optional label), **Download** (streams the selected run's log file), **Auto-scroll**. SSE via `/logs?runId=…`; run list via `GET /runs` and refetched when the container's state transitions. |

### UI Integration

- Left panel shows unified list (VMs + containers) with type filter: All | VMs | Containers
- Containers use a Box icon (distinct from VM monitor icons)
- Container list items show the image name as subtitle
- State colors consistent with VMs (green=running, gray=stopped)
- "container" badge shown in the overview header
