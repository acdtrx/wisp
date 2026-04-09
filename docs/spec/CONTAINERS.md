# Container Management

Wisp supports running OCI containers alongside VMs using containerd as the runtime. Containers appear in the same unified list as VMs, with filtering options.

## Architecture

```
Frontend (containerStore) ──REST+SSE──▶ containers.js route ──▶ containerManager facade
                                                                       │
                                                    ┌──────────────────┼──────────────────┐
                                                    ▼                  ▼                  ▼
                                         containerManagerConnection  containerManagerSpec  containerManagerNetwork
                                            (gRPC to containerd)     (OCI spec builder)   (macvlan CNI exec)
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
  container.json    # Source-of-truth config
  files/            # Per-mount backing paths: files/<mountName> (file) or files/<mountName>/ (directory)
  container.log     # stdout/stderr from the container task
```

Task `stdout` / `stderr` are set to a `file://` URI pointing at `container.log` so **containerd-shim-runc-v2** opens the file and copies process output (same idea as containerd’s `LogFile` helper). Do not use `binary:///usr/bin/tee?…` here: the shim builds logger argv from query **key/value pairs**, not a bare path, so tee would not receive the log file argument as intended.

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
| `env` | object | `{}` | Key-value environment variables |
| `mounts` | array | `[]` | Bind mount definitions (see Mount entry); backing data lives under `files/<name>` |
| `network` | object | `{ "type": "macvlan" }` | Network configuration (see below) |
| `exposedPorts` | string[] | `[]` | Ports declared by the image (`EXPOSE` directives), e.g. `["80/tcp", "443/tcp"]`. Set at create time from the OCI image config; informational only (macvlan exposes all ports) |
| `createdAt` | string | (auto) | ISO 8601 creation timestamp |
| `iconId` | string \| omitted | omitted | Optional UI icon key (same ids as VM icons in the app; default client icon when omitted) |

### `network` object

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `macvlan` — container gets a LAN-facing interface (DHCP) |
| `interface` | string \| omitted | Optional: host bridge as CNI `master` (else use `/etc/cni/net.d/10-wisp-macvlan.conflist`). At **create**, defaults to the first Linux bridge whose name is not VLAN-style (`br0-vlanN` / `iface.VID`); if none, the first listed bridge. |
| `ip` | string \| omitted | Set by the backend after a successful CNI **ADD** (IPv4 with mask, e.g. `192.168.1.50/24`). Not writable via PATCH while the task is running (ignored in the merge). |
| `mac` | string | **Macvlan:** Required. Locally administered unicast format (`aa:bb:cc:dd:ee:ff`). Assigned at create (random if omitted), persisted in `container.json`, and passed to the CNI macvlan plugin on each **ADD** so the address stays stable across stop/start. User-editable via PATCH when the container is **not** running (`running` / `paused` / `pausing` block MAC or interface changes). Legacy configs without a MAC get one on first **GET** (`/api/containers/:name`) or before **start**. |

### Mount entry

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"file"` — bind a single host file; `"directory"` — bind a host directory |
| `name` | string | Single path segment: storage key; host path is `files/<name>` (file) or `files/<name>/` (directory). Must be unique among mounts. |
| `containerPath` | string | Absolute path inside the container (unique among mounts) |
| `readonly` | boolean | Bind mount read-only when true |

After **PATCH** persists **`mounts`**, or after **POST** `/api/containers/:name/mounts` adds one mount, the backend creates any **missing** backing file or directory under `files/<name>` automatically (empty file or empty directory) so new rows are usable without a separate **Init** call.

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
| `containerManagerLogs.js` | `getContainerLogs()`, `streamContainerLogs()` |
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

- Default Linux namespaces: pid, ipc, uts, mount, network, cgroup. For **`network.type: macvlan`**, the network namespace uses **`path: /var/run/netns/<name>`** so the process joins the netns CNI configured (a bare `network` namespace without `path` would be a new empty netns and ignore macvlan).
- Default capabilities: standard container set (chown, net_bind, etc.)
- Default mounts: proc, dev, devpts, shm, mqueue, sysfs, cgroup, run
- **Process user:** `process.user` uses the **backend process UID/GID** (the systemd deploy user) by default, so files created on bind mounts under `files/<name>/` remain owned by that user and the backend can delete them. If the backend runs as root (unusual), UID/GID stay 0. When **`runAsRoot: true`** is set in `container.json`, UID/GID are forced to 0 — required for images that write to root-owned directories inside the container (e.g. OpenWebUI writing `.webui_secret_key` to `/app`). Bind-mount data created while running as root will be root-owned; container deletion may require sudo for those paths.
- User bind mounts: `files/<mountName>` per `mounts[].name` (`type` determines file vs directory)
- CPU quota/period from `cpuLimit`, memory limit from `memoryLimitMiB`
- `/etc/resolv.conf` bind-mounted from host

## Networking

Containers use macvlan CNI networking to appear directly on the LAN with their own IP address (via DHCP), the same way VMs do on a bridge.

- **No Docker-style `-p` publish:** The container is on the LAN like a small VM. If nginx listens on port 80 inside the image, browse to `http://<container-ip>/` from other machines on the same LAN (no host port mapping table). Firewall rules on the host or image still apply. The Network section shows `ExposedPorts` from the OCI image config (Dockerfile `EXPOSE` directives) as informational badges so users know which ports the image intends to serve.
- **MAC in CNI:** The reference macvlan plugin accepts a **`mac`** field in the netconf JSON; Wisp sets it from `container.json` on each **ADD** so DHCP sees a consistent client identity across restarts.
- **Interface selection:** Optional `network.interface` selects which host bridge/interface CNI macvlan uses as `master`. In the UI, this is chosen from the host bridge list (`/api/host/bridges`), and interface changes require the container to be stopped. VLAN-specific connectivity should use a managed VLAN bridge (for example `br0-vlan10`) created in Host Mgmt.
- **IP in the UI:** After each successful CNI **ADD**, the backend stores `network.ip` in `container.json` (and may fill `mac` from the CNI result only when no MAC was already persisted). With **`ipam.type: dhcp`**, the macvlan plugin often returns **no `ips[]` in the CNI result** (the `cni-dhcp` daemon assigns the address shortly after). When the container **task PID** is known, Wisp prefers reading the address from **`/proc/<pid>/net/fib_trie`** (no sudo). Before the task exists (e.g. polling right after CNI **ADD**), or if `/proc` parsing finds no address, Wisp falls back to **`sudo wisp-netns ipv4 <name> eth0`**. **`GET /api/containers/:name`** also probes if the task is running but `network.ip` is still empty — so the UI catches up after DHCP is slow.
- Re-run **`install-helpers.sh`** after upgrading so `/usr/local/bin/wisp-netns` includes the **`ipv4`** subcommand (needed for fallback when PID is unavailable or `/proc` has no lease yet).
- CNI plugins installed to `/opt/cni/bin/` by `scripts/linux/setup/cni.sh`
- Config at `/etc/cni/net.d/10-wisp-macvlan.conflist`. When the host default route uses a **Linux bridge** (`br0`), **`master` must be that bridge**, not the physical NIC enslaved to it — macvlan on a bridge port often fails with **device or resource busy**.
- DHCP IPAM via `cni-dhcp.service` systemd unit
- Network namespace per container at `/var/run/netns/<name>`
- CNI plugins are invoked via the **`wisp-cni`** privileged helper and **`sudo -n`** when the backend runs as the deploy user (`User=` in systemd). Stdin netconf merges **`.conflist` top-level `cniVersion` and `name` into the macvlan `plugins[0]` object** (the fragment alone is not valid for a direct plugin exec). **`wisp-netns`** creates `/var/run/netns/<name>` with `ip netns add`. Install both with **`install-helpers.sh`** / **`wispctl.sh helpers`** (same pattern as `wisp-smb`). **`cni-dhcp.service`** must be running when using `ipam.type: dhcp`.
- Before **ADD**, if the netns file already exists, **`setupNetwork`** runs **CNI DEL** and **`ip netns delete`** so a leftover **`eth0`** from a failed stop does not cause macvlan **device or resource busy**.

## Local DNS (mDNS)

Containers can be registered on the local network via mDNS (`.local`) using avahi-daemon.

- Controlled by **`localDns`** in `container.json`
- Name source: container name, sanitized to a DNS label (lowercase alnum + `-`, max 63 chars)
- Address source: `network.ip` (CIDR mask stripped before registration)
- Register points: create/start after IP is known; running detail fetch if DHCP lease arrives late
- Deregister points: stop, kill, delete, or `localDns` toggle set to false
- UI: Network section has a **Local DNS** toggle; stats bar shows the registered `.local` hostname when active
- Best-effort behavior: if avahi-daemon is unavailable, container operations continue unchanged and mDNS is skipped

## Image Management

- Image references without a registry prefix default to `docker.io/library/`
- Image pulling uses the Transfer gRPC service with protobuf-encoded Any fields
- Transfer `source` (OCIRegistry) and `destination` (ImageStore) are packed via `packProtoAny` using `protobufjs` for binary encoding (required because `@grpc/proto-loader` only exposes descriptor objects, not encodable Types)
- Multi-platform images (OCI index / Docker manifest list) are resolved to **Linux + host architecture** (`process.arch` → OCI architecture) before reading the image config. There is **no** fallback to the first index entry (registry order may list Windows or other OS first). If no matching Linux manifest exists for the host arch, image resolution fails with a clear error listing available platforms. Nested indexes are walked until a concrete image manifest is reached.
- The Transfer `ImageStore` destination sets **`platforms`** (download filter) **and** `unpacks` (snapshot unpack) to the same host platform (`linux/<arch>`). Without `platforms`, containerd downloads layers for **all** listed platforms (including Windows), which makes multi-arch pulls like `caddy:latest` extremely slow. With `arm64`, `variant: v8` is included on both fields.
- Image config (Entrypoint, Cmd, Env, WorkingDir, rootfs.diff_ids) read from content store
- The Transfer `ImageStore` destination includes an `unpacks` field (proto field 10) so containerd unpacks layers into overlayfs snapshots during pull
- Snapshot parent key is the chain ID computed from `rootfs.diff_ids` using full digest strings including the `sha256:` prefix (matches Go's `identity.ChainID` which concatenates `digest.Digest` values directly)
- Images are stored in containerd's content store, not in Wisp's filesystem
- Create progress is delivered over **SSE** (`/api/containers/create-progress/:jobId`). Large pulls may run for many minutes without real **percentage** (containerd Transfer does not expose it through the current unary API); the UI shows **elapsed time** every 15s during pull. The production **frontend** proxy disables idle **body timeout** on `/api` so long-lived SSE streams are not cut off (older installs that only updated the backend could see `BodyTimeoutError` in `wisp-frontend` logs).

### Debugging slow or stuck image pulls (on the server)

- **Wisp logs:** `journalctl -u wisp-backend -u wisp-frontend -f` — backend shows pull/snapshot errors; frontend shows proxy errors (e.g. undici `BodyTimeoutError` if an old frontend build is still running).
- **containerd images (namespace `wisp`):** `sudo ctr -n wisp images ls` — confirm the image reference appears after a successful pull.
- **Active pull:** `sudo ctr -n wisp tasks ls` is usually empty until the container is started; during pull, watch backend logs or `ctr -n wisp content ls` (large output) only if deep debugging is needed.

## Container Lifecycle

1. **Create**: Pull image (with unpack) → Prepare snapshot → Build OCI spec → Define container in containerd (**stopped** — no CNI, no task). User configures mounts and settings, then **Start**.
2. **Start** (stopped): Ensures each mount’s backing path exists under `files/` and matches `type`. If the path is missing, the backend creates an empty file or empty directory automatically (same as **Init**). If a **STOPPED** task still exists in containerd, **Tasks.Delete** it first (otherwise **Tasks.Create** returns `already exists`). Enum status from gRPC may be numeric — normalize before comparing. Rebuild OCI spec → Get snapshot mounts → Setup networking → Create new task → Start task. `startExistingContainer` also best-effort deletes any stale task before create.
3. **Stop**: SIGTERM → Wait 10s → SIGKILL if needed → Delete task
4. **Kill**: SIGKILL → Wait 5s → Delete task
5. **Restart**: Stop then Start
6. **Delete**: Kill task → Tear down networking → Remove snapshot → Remove containerd container → Delete files on disk (`fs.rm` on the container directory). The main process runs as the **deploy user’s UID/GID** (see OCI section), so bind-mount data under `files/` is normally removable. Leftover **root-owned** paths from before that behavior (or from images that escalate to root) are **not** migrated or chowned by the app; fix on the host once (e.g. `sudo chown -R <deploy-user>:…` or remove that subtree) if delete fails with permission errors.

### Backend process startup (host boot / `wisp-backend` restart)

When the Wisp backend process starts (`backend/src/index.js`), after libvirt and containerd connection attempts and after mDNS manager connect:

1. **SMB network mounts** — `ensureNetworkMounts()` runs to completion (awaited) so Host Mgmt SMB shares are mounted before any autostart container starts (avoids bind mounts whose host paths live under those shares).
2. **Container autostart** — `startAutostartContainersAtBackendBoot()` lists containers from disk + containerd; for each with `autostart: true` that is not already `running`, it calls `startContainer()`. Failures are logged per container and do not block other containers.
3. **mDNS warm-up** — For each running container (including any just started), if `localDns` is true and `network.ip` is set, the backend registers the `.local` address.

The HTTP server listens **after** these steps, so hosts with SMB auto-mount configured may accept API traffic slightly later; when no SMB mounts are configured, `ensureNetworkMounts` returns immediately.

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `CONTAINER_NOT_FOUND` | 404 | Container doesn't exist |
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
| `ContainerLogsSection` | `sections/` | Live-scrolling log viewer with filter |

### UI Integration

- Left panel shows unified list (VMs + containers) with type filter: All | VMs | Containers
- Containers use a Box icon (distinct from VM monitor icons)
- Container list items show the image name as subtitle
- State colors consistent with VMs (green=running, gray=stopped)
- "container" badge shown in the overview header
