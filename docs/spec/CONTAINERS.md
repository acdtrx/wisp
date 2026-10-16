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

- **Backend**: `backend/src/lib/containerManager/index.js` is a platform facade (loads `containerManager/linux/` on Linux or `containerManager/darwin/` on macOS). Linux modules live under `backend/src/lib/containerManager/linux/`; only those import `@grpc/grpc-js`.
- **Communication**: gRPC to containerd (via `@grpc/grpc-js`) instead of DBus to libvirt
- **Frontend**: Dedicated Zustand store (`containerStore.js`), SSE for live data
- **API routes**: `backend/src/routes/containers.js` mirroring VM routes

## Ephemeral rootfs

The writable rootfs layer of a Wisp container is **ephemeral**. On every start, `startExistingContainer` removes the existing rootfs snapshot and re-prepares it from the current library image before the task is created. Anything a container needs to persist across restarts must be stored under a Local mount (`files/<mountName>` in the container directory), a Storage-sourced mount, or a tmpfs mount (which is itself ephemeral but kernel-managed).

Consequences:

- **Image updates** are picked up automatically on next start. The container always boots from whatever the library currently holds for its image reference.
- **Package installs and `/etc` edits** done inside a running container do **not** survive a stop. Tools that customize a system after first boot must run as part of the image build, an entrypoint script reading mounted config, or an app's `appConfig`/derived mounts.
- **Identity changes** (e.g. **rename**) do not need to preserve any rootfs state — the snapshot under the old key is dropped at rename time and the next start re-prepares one under the new key.

## containerd Connection

- Socket: `/run/containerd/containerd.sock` (override: `WISP_CONTAINERD_SOCK`)
- Namespace: `wisp` (set via gRPC metadata header `containerd-namespace: wisp`)
- Required version: containerd 2.0+
- Proto files: `backend/src/protos/containerd/` (loaded by `@grpc/proto-loader`). **Field numbers must match the installed containerd** (e.g. `types/mount.proto`: `target` is field 3, `options` is field 4 as in containerd 2.x; an older `options = 3` definition decodes overlay options incorrectly and task create fails with empty overlay `data`).
- gRPC services used: Version, Namespaces, Containers, Tasks, Images, Content, Snapshots, Events, Leases, Transfer

## Name validation

Every `/api/containers/:name/*` route runs a `preHandler` that calls `validateContainerName(request.params.name)`. The validator (in `backend/src/lib/validation.js`) requires:

- length 1–63
- regex `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`
- rejects `..`, `/`, `\`

Failures map to HTTP 422 (`INVALID_CONTAINER_NAME`). This guards path-derived helpers (`getContainerDir(name)`, run-log streams, mount file paths) against traversal.

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

**Owner-only (settled 2026-10-16).** The container directory is `0700` and `container.json` is `0600`: it holds secret env values in plaintext (Caddy's DNS token, zot's OIDC secret, tiny-samba's passwords via its app config), and on a multi-user host the umask default (`0755` / `0644`) left them readable by every local account. `createContainer` makes the directory `0700`; every `container.json` write goes through `writeContainerConfig`, which writes a fresh file at `0600` and renames it into place, so every write applies the mode; restore (as new and in place) extracts into a `0700` staging directory and sets the restored container directory to `0700` whatever mode the archive recorded. Nothing but the backend reads this directory: containerd-shim (root) opens `runs/<runId>.log`, runc (root) bind-mounts the `files/` sources, and the container's process only ever sees its mount points — never `container.json` or the directory around it — whether it runs as the deploy user or `runAsRoot`. What is inside `files/` keeps its own modes (the container reads and writes there). Existing directories, `container.json` files and container backups are tightened on update by state migration `0005-container-config-modes` (`tightenContainerFileModes` / `tightenContainerBackupFileModes`) — see [UPDATES.md § State migrations](UPDATES.md#state-migrations).

**Per-run log files.** Every start that creates a new task (`startExistingContainer`) allocates a fresh **runId** — a filesystem-safe ISO-8601 timestamp (`2026-04-18T12-34-56-789Z`, colons and dots replaced with hyphens). Task `stdout` / `stderr` are both set to a `file://` URI pointing at `runs/<runId>.log` so **containerd-shim-runc-v2** opens the file and copies process output (same idea as containerd's `LogFile` helper). Do not use `binary:///usr/bin/tee?…` here: the shim builds logger argv from query **key/value pairs**, not a bare path, so tee would not receive the log file argument as intended.

Alongside each log file, the backend writes a JSON sidecar with run metadata:

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Matches the filename stem. |
| `startedAt` | string | ISO 8601 time the run was allocated (immediately before `tasks.create`). |
| `endedAt` | string \| null | ISO 8601 time the task exited (set in `cleanupTask` after `tasks.delete` returns). Null while the run is active. |
| `exitCode` | number \| null | Process exit status from the `Tasks.Delete` response. Null while the run is active, or when the exit code is unavailable. |
| `imageDigest` | string \| null | Library image digest the container was running at the time of the run, if known. |

**Live log stream** *(settled 2026-10-16)*. The logs SSE (`GET /api/containers/:name/logs`) delivers every line of the run exactly once, in order: `readRunLogHistory` returns the last 500 **complete** lines plus the byte offset just past the last newline, and `streamContainerRunLogs` tails from exactly that offset — no gap between history and tail, no line in both. Reads are serialized per stream (a watch event or the 2 s interval arriving mid-read marks a rerun instead of a second reader over the same bytes), and bytes are split into lines before decoding, so a write that ends mid-line (or mid UTF-8 sequence) is held until its newline lands. A trailing line without a newline is delivered once the run has ended (sidecar `endedAt` set), or when it exceeds 64 KiB. One file handle per stream, closed on disconnect once no read is in flight. `getContainerRunLogs` (MCP `get_container_logs`) keeps returning the last N segments including a trailing partial line.

**Retention.** The newest **10** runs are kept; older log+sidecar pairs are pruned on every new-run allocation. No separate GC job. Container delete removes the whole container directory, including all runs.

**Finding the current run.** The active run is the one whose sidecar has `endedAt === null`. `cleanupTask` — called from `stopContainer` / `killContainer`, and also as a stale-task cleanup inside `startExistingContainer` before re-creating — captures the `exit_status` field from the `Tasks.Delete` response and writes both `endedAt` and `exitCode` to the sidecar in a single `finalizeRun` call. Already-finalized sidecars are not rewritten. Backend restart is safe: the "current" run is not tracked in memory, so a container mid-run looks identical across restarts.

### container.json Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Container name (alphanumeric, 1-63 chars) |
| `image` | string | (required) | OCI image reference (e.g. `nginx:latest`) |
| `command` | string[] \| null | null | Command override (default: image entrypoint+cmd). See [Command override](#command-override) |
| `cpuLimit` | number \| null | null | CPU limit in cores (e.g. 2.0) |
| `memoryLimitMiB` | number \| null | null | Memory limit in MiB |
| `restartPolicy` | string | `"unless-stopped"` | One of: `never`, `on-failure`, `unless-stopped`, `always` (anything else is rejected with `CONFIG_ERROR`; a missing field reads as `unless-stopped`). What happens when the main process exits on its own — see [Restart policy](#restart-policy). Applies immediately, no restart needed. |
| `autostart` | boolean | false | Start on backend boot (host boot and every `wisp` restart) — the only boot mechanism; see [Restart policy](#restart-policy) for how the two relate |
| `autoBackup` | boolean | false | Include in the daily scheduled backup (see [BACKUPS.md → Scheduled backups](BACKUPS.md#scheduled-backups)). A running container is briefly paused while archived. |
| `runAsRoot` | boolean | false | Run the container process as UID/GID 0 instead of the Wisp deploy user. Required for images that write to root-owned directories (e.g. OpenWebUI). When true, **Local** bind mounts get a per-mount **idmapped mount** (size:1) that maps the configured `containerOwnerUid`/`containerOwnerGid` (defaults 0/0) to the host deploy UID/GID — so files written by that in-container UID land on disk owned by the deploy user and the backend can clean them up without `sudo`. Storage-sourced mounts never get idmappings. See [Mount entry](#mount-entry) and [Idmapped Local mounts](#idmapped-local-mounts). Requires restart. |
| `localDns` | boolean | false | Enable mDNS registration for this container on the LAN. New containers default to `true`; existing containers without this field are treated as `false` for upgrade safety. |
| `services` | array | `[]` | Optional mDNS service advertisements (SRV+TXT) tied to the container's `<name>.local` host. See [Service entry](#service-entry). Requires `localDns: true`. |
| `env` | object | `{}` | Environment variables. Structured shape: `{ KEY: { value: string, secret?: true } }`. Entries without `secret` are plaintext; `secret: true` marks the entry as write-only — see **Secret env vars** below. |
| `mounts` | array | `[]` | Bind mount definitions (see Mount entry); Local backing data lives under `files/<name>`, Storage-sourced entries resolve to `<settings.mounts[sourceId].mountPath>/<subPath>` |
| `devices` | array | `[]` | Host device passthrough (see [Devices entry](#devices-entry)). Currently only `type: "gpu"` (Intel/AMD render nodes); v1 caps the array at one entry. |
| `network` | object | `{ "type": "bridge" }` | Network configuration (see below) |
| `exposedPorts` | string[] | `[]` | Ports declared by the image (`EXPOSE` directives), e.g. `["80/tcp", "443/tcp"]`. Set at create time from the OCI image config; informational only (containers expose all listening ports on the LAN) |
| `createdAt` | string | (auto) | ISO 8601 creation timestamp |
| `iconId` | string \| omitted | omitted | Optional UI icon key (same ids as VM icons in the app; default client icon when omitted) |
| `app` | string \| omitted | omitted | App registry ID (e.g. `”caddy-reverse-proxy”`). When set, the container uses a dedicated app module for config management. See [CUSTOM-APPS.md](CUSTOM-APPS.md). |
| `appConfig` | object \| omitted | omitted | Structured config for the app. Shape is app-specific. Only present when `app` is set. Source of truth — `env`, `mounts`, and mount files are derived from it. |
| `pendingRestart` | `{ since }` \| omitted | omitted | Restart-required flag: `since` is the ISO time a change the running process can't pick up live was saved — any `RESTART_FIELDS` change while running, or an `appConfig` change the app cannot live-reload. See [Config changes that need a restart](#config-changes-that-need-a-restart). Dropped once the task is seen to have started after `since`. Server-managed: not writable via PATCH. (Image-version drift is surfaced via the derived `updateAvailable` field on API responses; it's not persisted.) |
| `imageDigest` | string \| omitted | omitted | Server-managed: top-level manifest/index digest (`sha256:…`) of the library image the container's rootfs was last built from. Written at **create** and refreshed on every start when the library digest has changed. Used by the image update checker to detect drift. Not writable via PATCH. |
| `imagePulledAt` | string \| omitted | omitted | Server-managed: ISO 8601 timestamp of the last `imageDigest` change (i.e. when the container last adopted a new image). Not writable via PATCH. |
| `scheduledRestart` | object \| null (derived) | null | Not stored on disk — on list and detail responses. `{ attempt, at }` while the restart policy has a restart scheduled for this stopped container (`attempt` counts restarts in the current crash loop, `at` is the epoch-ms time the backoff timer fires), else `null`. See [Restart policy](#restart-policy). |
| `updateAvailable` | boolean (derived) | omitted | Not stored on disk — derived at read time when the list/detail endpoints build their response. `true` when the container's task is RUNNING or PAUSED **and** its stored `imageDigest` no longer matches the library's current digest for `image` (looked up from `oci-image-meta.json`). Stopped containers always read as `false`; they adopt the new digest automatically on next start. Not writable via PATCH. |

### Command override

`command` is the process argv, stored exactly as sent; `null` (or an empty array) runs the image's entrypoint + cmd. The General section edits it as **one line of shell-style quoting** *(settled 2026-10-16)*: the stored argv is shown with each argument quoted only when needed (`sh -c 'sleep 5 && echo hi'`), and the typed line is split back with the same rules — whitespace separates arguments, `'…'` is literal, `"…"` honours `\"` `\\` `\$` `` \` `` only, `$'…'` takes ANSI-C escapes (`\n`, `\t`, `\xHH`, …; the formatter uses it for arguments holding newlines or control characters), and `\` escapes one character outside quotes. Formatting then parsing returns every argv unchanged, so a command set through the API survives a UI edit, and a re-quoted line with the same argv is not re-sent. Only the quoting is shell-like — no shell runs, so `$VAR`, globs, `|`, `&&` are literal characters (use `sh -c '…'`). An unterminated quote or a trailing backslash fails the save with an error; blank saves `null`. Rejected: one argument per line (cannot show an argument containing a newline, which multi-line `sh -c` scripts have) and whitespace splitting (breaks quoted arguments). Code: `frontend/src/utils/commandLine.js`.

### `network` object

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `bridge` — container is attached as a veth port on a host Linux bridge (LAN DHCP) |
| `interface` | string | Host Linux bridge used as the parent for the container's veth pair (e.g. `br0` or a VLAN sub-bridge `br0-vlan10`). Required at start; a setup-time probe rejects anything that is not an existing Linux bridge. At **create**, defaults to the first bridge whose name is not VLAN-style (`br0-vlanN` / `iface.VID`); if none, the first listed bridge. |
| `ip` | string \| omitted | Set by the backend after a successful CNI **ADD** (IPv4 with mask, e.g. `192.168.1.50/24`). Not writable via PATCH while the task is running (ignored in the merge). |
| `ip6` | string \| omitted | Set by the backend when the running container's netns holds a global-scope IPv6 (with prefix, e.g. `fdc0:…:ad5f/64`). Kernel SLAAC from the LAN's router advertisements — nothing in the CNI/DHCP layer requests IPv6; the address is observed from `/proc/<taskPid>/net/if_inet6` by the 60 s network probe (GUA preferred over ULA; link-local/tentative/deprecated/temporary skipped). Absent on LANs without an IPv6 prefix. Not user-writable. |
| `mac` | string | Required. Locally administered unicast format (`aa:bb:cc:dd:ee:ff`). Assigned at create (random if omitted), persisted in `container.json`, and passed to the CNI bridge plugin on each **ADD** so the DHCP client identity (and therefore the lease) stays stable across stop/start. User-editable via PATCH when the container is **not** running (`running` / `paused` / `pausing` block MAC or interface changes). Legacy configs without a MAC get one on first **GET** (`/api/containers/:name`) or before **start**. |

### Mount entry

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"file"` — bind a single host file; `"directory"` — bind a host directory; `"tmpfs"` — kernel-managed in-memory mount, no host backing (see [tmpfs mounts](#tmpfs-mounts)) |
| `name` | string | Single path segment: storage key. Must be unique among mounts. For Local entries it also names the backing directory under `files/<name>`. For Storage-sourced and tmpfs entries it is purely a config key. |
| `containerPath` | string | Absolute path inside the container (unique among mounts) |
| `readonly` | boolean | Bind mount read-only when true. Rejected on tmpfs entries (`INVALID_CONTAINER_MOUNTS`). |
| `sourceId` | string \| null | Optional; directory mounts only. When set, references an entry in **`settings.mounts`** (see [STORAGE.md](STORAGE.md)) and the bind source lives on that mount instead of `files/<name>`. `null`/absent = Local. Rejected on tmpfs entries. |
| `subPath` | string | Sub-path inside the referenced storage mount (relative; no `..`; empty = mount root). Only meaningful when `sourceId` is set. Rejected on tmpfs entries. |
| `containerOwnerUid` | integer (0–65535) | In-container UID to map to the host deploy UID via a **size:1 idmapped mount**. Default `0` (root). Only consumed when `runAsRoot` is true and the mount is **Local** — ignored on Storage-sourced mounts and rejected on tmpfs. See [Idmapped Local mounts](#idmapped-local-mounts). |
| `containerOwnerGid` | integer (0–65535) | In-container GID to map to the host deploy GID via a size:1 idmapped mount. Default `0` (root). Same activation conditions as `containerOwnerUid`. |
| `sizeMiB` | integer (1–2048) | tmpfs only. Cap on the tmpfs mount in MiB. Default `64`. Ignored / rejected on file and directory mounts. |
| `secret` | `true` \| omitted | File mounts only (`secret: true` on a directory/tmpfs entry, or a non-boolean, → `INVALID_CONTAINER_MOUNTS`). The file's content is **write-only** — see [Secret file mounts](#secret-file-mounts). Persisted only when `true`. |

**Host-path resolution** (`resolveMountHostPath`):
- Local: `<containersPath>/<name>/files/<mount.name>`
- Storage: `<settings.mounts[sourceId].mountPath>/<mount.subPath>`
- tmpfs: no host path (kernel-allocated)

**Replacing the list (`PATCH` `mounts`).** `containerManager.updateContainerConfig` never deletes mount data on its own: a Local mount that leaves the list keeps `files/<name>` and is reported back in `removedMounts`, and the caller deletes it explicitly with `deleteRemovedMountData(name, mountName)` (which refuses a name still in the list). The generic `PATCH /api/containers/:name` route does exactly that, so for API callers dropping a Local mount from `mounts` still deletes its data — the same contract as `DELETE /mounts/:name`. App flows decide per mount (see [CUSTOM-APPS.md](CUSTOM-APPS.md) § Live Reload). An optional **`mountRenames`** object (`{ "<oldName>": "<newName>" }`, only alongside `mounts`) marks entries of the new list as renamed current mounts: a Local mount's `files/<old>` moves to `files/<new>` with its contents, like a row-scoped rename. Rules: `oldName` is a current mount; `newName` is in the new list, has the same type, and is not a current mount (swaps and chains take two saves); `files/<new>` must not already exist on disk (**422** `CONTAINER_MOUNT_DUPLICATE` — `rename(2)` would replace an empty directory or overwrite a file left by an earlier mount). Violations → **422** `CONFIG_ERROR`. If a move or the config write fails, completed moves are reversed (settled 2026-10-16 — data deletion is an explicit second step so no caller can lose data by rearranging a list; the earlier implicit delete-on-diff turned a tiny-samba share rename into data loss).

After **PATCH** persists **`mounts`**, or after **POST** `/api/containers/:name/mounts` adds one mount, the backend creates any **missing** backing artifact automatically (Local: empty file/directory under `files/<name>`; Storage: `mkdir -p` of the sub-path inside the mounted storage root) so new rows are usable without a separate **Init** call.

**Pre-start checks (`assertBindSourcesReady`)** for Storage-sourced entries validate that:
- The referenced `settings.mounts[sourceId]` still exists (otherwise `CONTAINER_MOUNT_SOURCE_MISSING`).
- The storage mount is currently mounted (`/proc/mounts`; otherwise **503** `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED` — user mounts it in Host Mgmt → Storage and retries).
- `realpath(<mountPath>/<subPath>)` stays within `realpath(<mountPath>)` — symlink escapes are rejected with `CONTAINER_MOUNT_SOURCE_UNSAFE`. A missing sub-path is created one component at a time from the resolved root, each existing component checked first (a symlink is followed only when its target stays inside the root), so nothing is ever created outside the storage root.

**Re-check at task create (`resolveBindSources`).** The checks above run early in a start, before the network wait (fail fast). Immediately before the task is created every bind source — Local and Storage — is resolved again with `realpath` and re-checked against its root (and Storage's mounted state), and the OCI spec binds **that resolved path**, never the configured one. A symlink swapped into a sub-path during the DHCP wait therefore fails the start with `CONTAINER_MOUNT_SOURCE_UNSAFE` instead of being bound (settled 2026-10-16). What remains is the milliseconds between that `realpath` and runc's mount.

**Delete semantics:** removing a mount row or deleting the container itself leaves Storage-sourced sub-paths untouched (user data outside the container directory). Local backing files/directories are removed (row delete, generic `PATCH` dropping the row, container delete with files). **Rename** (row `PATCH` with a new `name`, or `mountRenames`) moves the Local backing store and refuses when `files/<newName>` already exists.

### tmpfs mounts

`type: "tmpfs"` mounts are kernel-managed in-memory filesystems. They have no host backing — contents live only in RAM (subject to the `sizeMiB` cap) for the lifetime of the container task and are wiped on stop/restart. Use them for paths that don't need to survive a restart and shouldn't write through to disk: per-session caches, runtime state directories like Samba's `/var/lib/samba`, lock/socket scratch space.

The OCI runtime spec emits tmpfs entries as `{ type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'mode=1777', 'size=<N>m'] }`. `mode=1777` mirrors `/tmp` semantics so any in-container UID can write — the on-disk-ownership concerns that drive idmap on Local mounts don't apply (nothing is on disk).

**Field rules:** `sizeMiB` is required and capped at 2048 (default 64). `sourceId`, `subPath`, `readonly`, `containerOwnerUid`, `containerOwnerGid` are rejected — providing any of them raises `INVALID_CONTAINER_MOUNTS`.

**No content endpoints:** the file-upload, zip-upload, init, and delete-data routes return `CONTAINER_MOUNT_TYPE_MISMATCH` for tmpfs mounts (there is no host artifact to read or write).

**Lifecycle:** changing any field on a tmpfs mount (size, name, container path) requires a task restart, same as file/directory mounts. Removing a tmpfs row from `mounts` or deleting the container is purely a config delete — no on-disk cleanup.

### Service entry

Each `services[]` element advertises one mDNS service for the container's `<name>.local` host record:

| Field | Type | Description |
|-------|------|-------------|
| `port` | integer (1–65535) | Service port. Unique per container — one service per port. |
| `type` | string | mDNS service type matching `^_[a-z0-9-]+\._(tcp\|udp)$` (e.g. `_smb._tcp`, `_https._tcp`). |
| `txt` | object | Flat key/value map serialized as TXT records (`key=value` pairs). Empty object when none. Values coerced to strings. |

**Validation:** `port` must be an integer in [1, 65535]; `type` must match the regex above; `txt` keys must be non-empty and must not contain `=`. Adding a service for a port that already has one returns **409** `CONTAINER_SERVICE_DUPLICATE`. All service mutations are gated on `localDns: true` (otherwise **409** `CONTAINER_LOCAL_DNS_DISABLED`).

**Mutation surface:** services are managed exclusively via the row-scoped endpoints (`POST` / `PATCH` / `DELETE` `/api/containers/:name/services[/:port]`); sending `services` to **PATCH** `/api/containers/:name` returns **422** `CONFIG_ERROR`. The whole list is replaced on each row mutation under the hood.

**Lifecycle:** services persist in `container.json` independent of run state. Live publication tracks the address registration:
- **Container start:** once the task has started (and the IP is known), every entry in `services[]` is published via Avahi `EntryGroup.AddService` against the container's `<name>.local` host — read from the latest `container.json`, so a `localDns` switched off during the start publishes nothing. A start that fails after network setup publishes nothing and deregisters any services left under the name (with the netns and snapshot teardown). A registration failure after the task started is logged; the start still succeeds.
- **Container stop / kill / delete:** every published service for the container is deregistered before the address itself is freed.
- **`localDns` toggled off:** all services are deregistered alongside the address.
- **`localDns` toggled on (running):** the address is republished and every entry in `services[]` is registered.
- **Per-row mutation while running:** `addContainerService` / `updateContainerService` / `removeContainerService` apply the mDNS change live (no task restart). Updates are deregister + register (Avahi has no in-place update).

Service publication is best-effort: if Avahi is unavailable, services are stored in memory and re-registered the next time avahi-daemon appears (same `NameOwnerChanged` watch as address registrations — see Publishing below).

**Zip upload** (`POST /api/containers/:name/mounts/:mountName/zip`) is available for Local directory mounts only — Storage-sourced rows reject the call with `CONTAINER_MOUNT_TYPE_MISMATCH`. The UI dims the zip button and shows a tooltip to that effect.

### Idmapped Local mounts

When `runAsRoot` is true on a container, every **Local** directory/file bind mount may carry a per-mount idmap that translates a single in-container UID/GID pair to the host deploy UID/GID. This makes files created inside the container land on the host with ownership the backend can read/delete without `sudo`. Storage-sourced mounts never get an idmap (CIFS/SMB/NFS support is inconsistent and the data lives outside the container directory anyway).

**Mapping shape**: for each Local mount under `runAsRoot`, the OCI spec attaches **unconditionally** — there is no no-op short-circuit, even when `containerOwnerUid === deployUid`. This keeps the contract consistent: exactly one in-container UID/GID writes through this mount cleanly; any other UID hits the unmapped path. Without the unconditional attachment, the mount silently degrades to a plain bind for the equal-IDs case and the contract changes underneath the user.

```js
uidMappings: [{ containerID: deployUid, hostID: containerOwnerUid, size: 1 }]
gidMappings: [{ containerID: deployGid, hostID: containerOwnerGid, size: 1 }]
```

> ⚠ **Field-name gotcha:** the OCI runtime spec for `mounts[].uidMappings` uses the *opposite* convention from `linux.uidMappings` (full user namespaces). For mount idmaps, **`containerID` = UID on the source file system (on-disk)** and **`hostID` = UID at the destination mount point (what the container sees)**. So to make container UID `N` (mount-visible) write files stored on disk as `deployUid`, the mapping is `{containerID: deployUid, hostID: N, size: 1}` — *not* the other way around. Getting this backwards causes reads of bind-source files to surface as `nobody:nogroup` and writes by the container process to fail with `EOVERFLOW` (`Value too large for defined data type`).

**Implications of size:1 (one container UID translates, others don't):**
- *Reads* of files owned by other (unmapped) UIDs through the idmapped mount appear as `overflowuid`/`overflowgid` (typically `65534`, `nobody:nogroup`).
- *Writes* by other in-container UIDs **fail at the syscall** with `EOVERFLOW` (glibc surfaces this as `"Value too large for defined data type"`). Empirically confirmed on Ubuntu LTS kernels with runc 1.2+; the file is not created on disk at all. This *is* the contract — exactly the configured in-container UID/GID may write through this mount.
- The implicit assumption is **each Local mount is consistently written by ~one container UID**. If the container needs to write as both root and a worker UID to the same path, split into two mounts (each with its own owner UID) rather than relying on one mount accepting both.

**Visibility of failed writes**: there is no host-side trace of `EOVERFLOW`-rejected writes. The kernel doesn't log them (`dmesg` is silent), no file artifact appears on the bind source, no containerd event fires. The error exists only as a syscall return value handed to the in-container process. Apps that print errors to stderr surface via the container's logs panel; apps that swallow `errno` will lose data silently. This is the standard tradeoff for any in-container permission failure, just framed by the idmap rather than DAC permissions.

**Bijection rule**: idmapped mounts must be one-to-one. Two container UIDs cannot map to the same host UID through a single mount. The size:1 design sidesteps this entirely (each mount carries one entry).

**Runtime requirements**: idmapped mounts require **runc ≥ 1.2.0** (per-mount `uidMappings`/`gidMappings` without a userns) and a recent kernel (≥ 5.19 in practice; ext4/xfs/btrfs/tmpfs all supported). `scripts/linux/setup/containerd.sh` warns if the installed `runc` is older. With an older runc, container task creation fails with an OCI spec error.

**Important: idmap is an on-disk ownership shift, not a security boundary.** The container process still runs as real host UID 0 with all capabilities (no user namespace is added). Only the inode ownership stored on the bind source is translated.

### Devices entry

Host device passthrough for containers. Unlike VM PCI passthrough (VFIO), the host kernel driver still owns the device — the container only gets the existing character-device node exposed inside its mount + cgroup namespace, so host and container share the device cooperatively via the host's driver.

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"gpu"` — Intel/AMD render node (`/dev/dri/renderD<N>`). NVIDIA is **not supported** in v1 (would require nvidia-container-toolkit + CDI). |
| `device` | string | Absolute host path. For `type: "gpu"`, must match `/dev/dri/renderD\d+` (DRM render node, no master/auth required). `/dev/dri/card<N>` is **not** accepted. |

**Validation rules** (`validateAndNormalizeDevices`):
- `devices` must be an array.
- v1: at most **one** entry. Multi-device exposure is intentionally deferred until a real use case lands; the array shape is for forward compatibility.
- Each entry's `type` must be `"gpu"` (other types are rejected with `INVALID_CONTAINER_DEVICES`).
- For `type: "gpu"`, `device` must match `^/dev/dri/renderD\d+$`. No symlink resolution — the literal path is what gets passed to the OCI spec.
- Unknown keys are rejected.

**OCI spec emission** (`buildOCISpec`):
- `linux.devices: [{ path, type: 'c', major, minor, fileMode: 0o660, uid: 0, gid: <render-gid> }]` — major/minor read via `stat()` on the host node at spec build time.
- `linux.resources.devices` cgroup allow rule: `{ allow: true, type: 'c', major, minor, access: 'rw' }`. Without this, cgroup v2 denies the syscall even though the device node is visible.
- `process.user.additionalGids: [<render-gid>]` — the in-container process is added to the host's `render` group so the `0660 root:render` device node is openable. Render GID is looked up via `getgrnam('render')` (or fallback `video`) at every spec build — distros vary on the numeric GID, so it is never cached.

**Pre-start check** (symmetric to `assertBindSourcesReady` for Storage mounts):
- A `gpu` entry's `device` must still match `^/dev/dri/renderD\d+$` (`isRenderNodePath`) — re-checked here, not only at PATCH/create, because `container.json` can also arrive from a backup archive. Otherwise start fails with `INVALID_CONTAINER_DEVICES` (422).
- The configured `device` path must exist and be a character device. If missing (driver glitch, hardware change, hot-removal), start hard-fails with `CONTAINER_DEVICE_MISSING` (503). The container is not auto-cleared of its `gpu` entry — this is a footgun for users who configured an app to use HW acceleration; surfacing the error makes the regression visible.

**Concurrency:** DRM render nodes are designed for concurrent open by multiple processes. Multiple Wisp containers (and the host itself) can hold the same device simultaneously; the kernel driver schedules access. No exclusivity bookkeeping in Wisp.

**Restart required:** any change to `devices` requires a task restart — devices are baked into the OCI spec at task create. Treated like `mounts` in `RESTART_FIELDS` — see [Config changes that need a restart](#config-changes-that-need-a-restart).

**Detection (host side):** `GET /api/host/gpus` enumerates `/dev/dri/renderD*`, reads `/sys/class/drm/<name>/device/vendor` (`0x8086` Intel, `0x1002` AMD; `0x10de` NVIDIA filtered out for v1), and returns `[{ device, vendor, vendorName, pciSlot, model? }]`. UI uses this to populate the picker. When multiple GPUs are present, the user picks one — Wisp does not auto-select beyond what the picker offers.

### Secret env vars

Individual env vars can be marked `secret: true` to hide their values from the UI. Secret values are persisted in `container.json` like any other env var (the OCI process needs them at runtime), but:

- **`GET /api/containers/:name`** strips the value and returns `{ value: null, secret: true, isSet: boolean }` for every secret entry. `isSet` is `true` when a value is stored on disk.
- **`PATCH /api/containers/:name`** only accepts env-var changes through the **`envPatch`** delta (a plain `env` field is rejected with `CONFIG_ERROR`). See API.md for the delta shape.
- Flipping a key from `secret: true` to `secret: false` without providing a new value clears the stored value server-side. This is intentional: since the UI never received the old value, there is nothing to preserve. The UI warns the user before flipping the toggle.
- Creating a brand-new secret key without a `value` is rejected with `CONFIG_ERROR` (`Secret env var "X" requires a value`).

Legacy `container.json` files with a flat `env: { KEY: "value" }` dict are normalized on first **GET** `/api/containers/:name` (written back to disk as `{ KEY: { value: "value" } }`) — existing entries become non-secret.

### Secret file mounts

A file mount can be marked secret — the same model as secret env vars (settled 2026-10-16: a user's secret kept in a generic container's file mount must be as unreadable as one kept in env; the earlier app-only content guard left it open to any read-scoped token). The file is stored in plaintext under `files/<name>` (the container reads it), owner-only on the host (below), but:

- **Content is write-only for every caller** — session or token, read or admin scope. `GET /api/containers/:name/mounts/:mountName/content` answers **403** `CONTAINER_MOUNT_SECRET`; `PUT …/content` and `POST …/file` work as for any file mount. `containerManager.getMountFileTextContent` itself refuses a stored `secret: true`, so no internal caller can read one back by accident either.
- **Metadata only on output.** `GET /api/containers/:name` (and MCP `get_container`) returns secret file mounts with `secret: true`, `isSet` (the file is non-empty) and `sizeBytes` (`null` when no file is on disk). The mount-usage endpoint still reports its size.
- **Un-marking empties the file.** Turning `secret` off — row `PATCH` `{ secret: false }`, or a whole-list `PATCH` whose entry for that mount (by name, or as a `mountRenames` target) lacks the flag or changes type — truncates the file **before** the config is written, so dropping the flag can never make the content readable. Matches secret env vars (secret → plain clears the value). Marking a mount secret keeps its content.
- **Host mode `0600`.** Every secret file mount's backing file — stored `secret: true` or app-declared — is mode `0600` (settled 2026-10-16; on a multi-user host the plaintext must not be world-readable at the umask default). The container still reads it: its process is the deploy user that owns the file, or with `runAsRoot` root through the mount's idmap (checked with tiny-samba). containerManager enforces it for a stored flag: `PUT …/content`, `POST …/file` and **Init** chmod an existing file **before** writing (a new one is created at `0600`), so the content never sits under a wider mode; a missing artifact is created `0600`; marking a mount secret (row `POST`/`PATCH`, or a whole-list `PATCH`, renames included) chmods its existing file right after the config write. **Un-marking** empties the file first, then sets the plain-file mode — `0666` under the process umask, the mode Wisp gives any new mount file (`0644` under the service's default umask `022`; `wisp.service` sets no `UMask`). Plain mounts are untouched: an existing file keeps its mode across writes.
- **No restart for the flag.** `secret` is not part of the OCI spec, so a row `PATCH` that changes only `secret` returns `requiresRestart: false` even while running.
- **App containers** derive secrecy from their app module (`getSecretMountNames`, read at request time from the stored appConfig — no stored flag, so app containers created before the flag existed are covered without a migration); see [CUSTOM-APPS.md § Mount content routes](CUSTOM-APPS.md#mount-content-routes). The effective rule is "stored `secret: true` **or** declared by the app". containerApps writes the declared files `0600` via `putMountFileTextContent`'s `mode` option (applied before the content is written). Files written earlier are tightened on update by state migration `0004-app-secret-file-modes` (`getMountFileMode` / `setMountFileMode`). Stored `secret: true` mounts need no migration: the flag ships in the same release as the `0600` rule, so no released host holds one at a wider mode.
- **Backups** carry secret mount files like any other mount data (and like secret env values), owner-only — see [BACKUPS.md § Backup file modes](BACKUPS.md#backup-file-modes).

## Config changes that need a restart

`PATCH /api/containers/:name` always writes `container.json`; it never restarts the container. For a **running** container, changes to these fields do not reach the process until the next start — the process environment, mounts, devices, and resource limits are baked into the OCI runtime spec at task create:

`image` · `command` · `cpuLimit` · `memoryLimitMiB` · `env` · `mounts` · `devices` · `network` · `runAsRoot`

(`RESTART_FIELDS` in `containerManager/linux/containerManagerConfig.js`. The mount CRUD endpoints set the same flag. MAC/interface changes are the exception — rejected outright while running with `CONTAINER_MUST_BE_STOPPED` rather than deferred.)

When one of them changes while the container is running:

- `pendingRestart: { since: <now> }` is persisted in `container.json` and the PATCH response carries `{ requiresRestart: true }`.
- The UI shows the amber **Restart required** badge in the header and the section headers (see [UI.md → SectionCard](UI.md#sectioncard)).

**The flag follows the same rule as a VM's** (settled 2026-10-16, reasoning and rejected alternatives in [VM-MANAGEMENT.md → Restart-required flag](VM-MANAGEMENT.md#restart-required-flag)): a container needs a restart iff `pendingRestart` exists **and** its task's init process has not started since `since` — start time from `/proc/<pid>/stat` + `/proc/stat` `btime` (`processStartTimeMsFromProc` in `procUptime.js`). The rule lives in `containerManagerPendingRestart.js` (`resolvePendingRestart`) and runs wherever the container's state is read: every list cache refresh (including the first one at startup, so a start made while Wisp was down is caught) and `getContainerConfig`. A flag older than the task's start is dropped from `container.json` (only if it still holds that `since`; not on a `repairOnRead: false` connection — the migration runner — which reports it cleared and leaves the file); a stopped container, or one whose start time `/proc` can't tell, keeps it. Starting a container never clears the flag directly; after `Tasks.Start` it re-reads `container.json` and sets a fresh flag when a restart-relevant field was saved after the spec was built — an edit made during the DHCP wait found no task, so nothing else marked it, and its `since` lies after the task start.

**Setting the flag from outside the config paths.** `containerManager.setContainerPendingRestart(name, value)` — `true` records `since = now` (a later change moves it forward), `false` removes it; returns `{ changed }` — goes through the manager's own `container.json` write path. It is for code that changes a container's state some other way and knows the running task needs a restart to pick it up: `containerApps` (app config that can't live-reload) and state migrations; nothing outside containerManager writes `container.json` directly, and `PATCH` ignores a `pendingRestart` key. VMs have the same setter (`setVMPendingRestart`). (settled 2026-10-16)

**Env and secrets in particular.** After a change the value reads back correct everywhere — `container.json`, the API response, the UI — while the running process still holds the environment it started with. Restart the container after any env or secret change before debugging anything else. Discriminator when auth is involved: a **401 from the service** means the variable is set, just not to what you expect; the service behaving as if **unconfigured** means it isn't set at all in the running process.

**App containers** (`app` set) normally live-reload through the app module's reload command, but the reload is **skipped outright when env changed** — the new config has already been persisted, so reloading would make the app resolve it against a process environment that still lacks the variable, turning a save that only needed a restart into a hard `APP_RELOAD_FAILED`. Restarting applies the new env and the new mount contents together. See [CUSTOM-APPS.md](CUSTOM-APPS.md); the MCP `update_app_config` tool runs the same path.

## Backend Modules

The facade is `backend/src/lib/containerManager/index.js` (picks `linux/index.js` or the `darwin/` stub by platform); every module below lives under `backend/src/lib/containerManager/linux/`:

| Module | Purpose |
|--------|---------|
| `index.js` | Linux implementation entry — re-exports the operations the facade exposes |
| `containerManagerConnection.js` | gRPC client setup, proto loading, connect/disconnect |
| `containerManagerList.js` | `listContainers()`, `getContainerConfig()`, `getRunningContainerCount()` (running count for host stats SSE), `subscribeContainerListChange()` (SSE consumers subscribe to cache-refresh events). Maintains an in-memory cache populated on containerd connect, refreshed on **(a)** containerd events that affect the list (`/tasks/{start,exit,oom,delete,paused,resumed}`, `/containers/{create,update,delete}`), **(b)** any `container.json` write via `subscribeContainerConfigWrite`, **(c)** every restart-policy schedule / cancel / fire (`subscribeScheduledRestartChange` — the list carries `scheduledRestart`), and **(d)** the end of every image-update check (`refreshContainerListCache()`, awaitable — resolves once a refresh started after the call has finished). The same events subscription feeds `/tasks/exit` to the restart policy. The events subscription auto-reconnects with exponential backoff (1s→30s cap) on stream-level errors (e.g. `UNAVAILABLE: Connection dropped`) — without this the cache would go deaf to lifecycle events until backend restart, leaving sidebar icons frozen on stale state. Connected with `watchEvents: false` (the migration runner) there is no cache and no events subscription: `listContainers()` reads disk and task state on every call and returns real state or throws (`NO_CONTAINERD`, an unreadable containers directory, a failed task lookup) — [UPDATES.md → Runner](UPDATES.md#runner-backendscriptsmigratemjs). |
| `containerManagerRestartPolicy.js` | Applies `restartPolicy` on `/tasks/exit` (decoded via the registered `containerd.events.TaskExit` type, `protos/containerd/events/task.proto`). `handleContainerExit()` is the decision, `noteIntentionalStop(name, pid)` / `noteContainerStart(name)` are called by the lifecycle paths; `getScheduledRestart(name)` / `subscribeScheduledRestartChange()` expose the pending restart to the list and detail payloads. See [Restart policy](#restart-policy) |
| `containerManagerLifecycle.js` | `startContainer()`, `stopContainer()`, `restartContainer()`, `killContainer()`, `pauseContainer()` / `resumeContainer()` (cgroup freezer; module-internal — used by the backup flow, no user-facing pause), `getTaskState()`, `startAutostartContainersAtBackendBoot()`, `resumeStalePausedContainersAtBackendBoot()`, `normalizeTaskStatus()`, `containerTaskStatusToUi()` (gRPC task enums may arrive as names, indices, or string digits — normalize before API/UI) |
| `containerImageRef.js` | `normalizeImageRef()` — Docker's registry rule (shared with pull, in-use checks and update badges) |
| `containerManagerCreate.js` | `pullImage()`, `createContainer()`, `deleteContainer()` |
| `containerManagerImageUpdates.js` | `checkAllImagesForUpdates()`, `checkSingleImageForUpdates()`, `getImageUpdateStatus()`, `startImageUpdateChecker()` — re-pull via Transfer, then refresh the image-meta sidecar and list cache (see [Image updates](#image-updates)) |
| `containerManagerRename.js` | `renameContainer(oldName, newName)` — stopped-container rename (containerd Containers.Delete + Create + fs.rename + config rewrite); see [Rename](#rename) |
| `containerManagerBackup.js` | `createContainerBackup`, `listContainerBackups`, `restoreContainerBackup`, `deleteContainerBackup` — tar.gz of the container directory + a manifest sidecar; restore extracts under a new name with a fresh MAC and re-pulls the image if missing. See [BACKUPS.md → Container Backups](BACKUPS.md#container-backups) |
| `containerManagerFileModes.js` | `tightenContainerFileModes`, `tightenContainerBackupFileModes` — make existing container directories / `container.json` / container backups owner-only ([Data Model](#data-model)); pure filesystem work, exported by the macOS stub too; used by state migration `0005-container-config-modes` |
| `containerManagerImages.js` | `listContainerImages()`, `deleteContainerImage()` (containerd Images service; deletes by the exact listed name; blocked if any Wisp container references the image), `resolveContainerImageRef()` (the ref a container stores: exact local name, else normalized) |
| `containerManagerOciSize.js` | `compressedBlobSizeForImageName()` — sums compressed config + layer sizes from the resolved Linux image manifest (not the top-level manifest blob size) |
| `containerManagerConfig.js` | `updateContainerConfig()` |
| `containerValidation.js` | `validateContainerName()` — the manager's own copy of the name rule (routes validate first via `lib/validation.js`), so containerManager carries no Wisp-glue import |
| `atomicJson.js` | `writeJsonAtomic()` — private copy of the temp-file + rename write, same tmp suffix as `lib/atomicJson.js` so the boot janitor finds leftovers |
| `containerManagerConfigIo.js` | `readContainerConfig()`, `writeContainerConfig()`, `subscribeContainerConfigWrite()`, `notifyContainerConfigWrite()` — single owner of `container.json` reads/writes. Every mutation fans out a config-write notification; the container list cache subscribes and refreshes accordingly. |
| `containerManagerStats.js` | `getContainerStats()` — calls containerd `Tasks.Metrics`; the `Any` payload is decoded via the registered `io.containerd.cgroups.v{1,2}.Metrics` proto types (loaded by `containerManagerConnection.js` from `protos/containerd/cgroups/`) to extract CPU usec and memory usage |
| `procUptime.js` | `processUptimeMsFromProc(pid)` — container uptime from `/proc` (survives backend restart; in-memory `containerStartTimes` is only a fallback). `processStartTimeMsFromProc(pid)` — the init process's wall-clock start time for the restart-required rule. Kept inside containerManager (vmManager has its own reader in `vmManagerProc.js`) so each manager stays extractable. |
| `containerManagerPendingRestart.js` | Restart-required flag: `markPendingRestart(config)`, `setContainerPendingRestart(name, value)`, `resolvePendingRestart(name, config, pid)` (the rule). |
| `containerManagerLogs.js` | Per-run log files under `runs/`: `listContainerRuns()`, `getContainerRunLogs()` (reads only the file's tail, backwards in 64 KiB chunks, until it holds the requested lines — the history view never loads a whole multi-hundred-MB run log), `readRunLogHistory()` + `streamContainerRunLogs()` (the live view — see *Live log stream* under Data Model), `createNewRun()`, `finalizeRun()`, `findCurrentRunId()`, `resolveRunId()`, `createRunLogReadStream()` |
| `containerManagerMounts.js` | `validateAndNormalizeMounts()` (validates optional `sourceId`/`subPath` against `settings.mounts`), `resolveMountHostPath()` (Local vs Storage resolver), `validateSubPath()`, `findMount()`, `ensureMountArtifactIfMissing()`, `ensureMissingMountArtifacts()`, `assertBindSourcesReady()` (branches on `sourceId`, verifies the storage mount is currently mounted and creates the sub-path inside its root), `resolveBindSources()` (realpath + root re-check of every bind source right before task create; its map feeds `buildOCISpec`) |
| `containerManagerSeccomp.js` | `defaultSeccompProfile()` / `convertSeccompProfile()` — the vendored Docker default profile (`seccomp/default.json`) converted to OCI `linux.seccomp` for this host's arch, kernel and the bounding capability set |
| `containerManagerMountCrud.js` | `addContainerMount()`, `updateContainerMount()`, `removeContainerMount()` — row-scoped bind mount CRUD |
| `containerManagerUsage.js` | `getContainerMountUsage()` — per-mount host-side disk usage snapshot: resolves each persisted mount's bind source via `resolveMountHostPath()` and sizes it with `storage`'s `measurePathSize()` (stdlib walk, apparent size, symlinks not followed; unreadable entries flagged via `partial`). tmpfs → `sizeBytes: null`; unresolvable `sourceId` → `source: 'missing'`. Served by `GET /api/containers/:name/mounts/usage` and the MCP `get_container_mount_usage` tool |
| `containerManagerMountsContent.js` | `uploadMountFileStream()`, `uploadMountZipStream()` (system **`unzip`**, paths checked with **`unzip -Z1`** before extract), `initMountContent()`, `getMountFileTextContent()`, `putMountFileTextContent()`, `deleteMountData()`, `deleteMountBackingStore()`, `deleteRemovedMountData()` (explicit data delete for a mount already dropped from the list), `renameMountBackingStore()` (shared by row rename and `mountRenames`) |
| `containerManagerNetwork.js` | `setupNetwork()`, `teardownNetwork()`, `mergeNetworkLeaseIntoConfig()` (persist DHCP IP / MAC to `container.json`) |
| `containerManagerNetworkEvents.js` | `subscribeContainerNetworkChange()` — periodic IP probe (DHCP IPv4 + observed SLAAC IPv6), persisted to `container.json`, emitted only on change |
| `containerManagerServices.js` | `validateServiceDef()`, `addContainerService()` / `updateContainerService()` / `removeContainerService()`, `registerAllContainerServices()` — per-container mDNS SRV/TXT services (the `<name>.local` host record is published by the `lib/containerMdnsReconciler.js` glue) |
| `containerManagerDevices.js` | `validateAndNormalizeDevices()`, `isRenderNodePath()`, `hasGpuDevice()` — `devices[]` validation |
| `containerDeviceNode.js` | `statDeviceNode()`, `resolveDeviceSpecs()`, `getRenderGid()` — host chardev major/minor and the `render` GID for the OCI spec |
| `containerManagerSpec.js` | `buildOCISpec()` |
| `containerPaths.js` | Path helpers for container directories |
| `containerManagerExec.js` | `execInContainer()`, `resizeExec()` — interactive shell via containerd `Tasks.Exec` + PTY (FIFO stdio), used by the container console WebSocket; `execCommandInContainer()` — non-interactive command with captured stdout/stderr (app reload commands). Its timeout bounds the whole run (process exit **and** both FIFOs drained); on expiry the exec process is SIGKILLed and reaped before `Tasks.DeleteProcess`; the FIFO sockets and session dir are released on every path, including a failed Start, so no exec process, open fd, or session dir outlives the call. Both functions do FIFO I/O through non-blocking fds on the event loop (see **Exec FIFO I/O** below) |

## Interactive console (exec)

The **Console** tab on the container overview opens an in-browser terminal (**xterm.js**) connected to **`GET /ws/container-console/:name`**. The backend:

1. Requires the container **task** to be **running** (`Tasks.Get` → `RUNNING`).
2. Creates a per-session directory under **`${containersPath}/.exec-sessions/`** with **named pipes** for stdin/stdout (not `os.tmpdir()` / `/tmp`, so systemd **PrivateTmp** on the Wisp service does not hide FIFOs from containerd). Passes **absolute paths** (not `file://` URIs) as `stdin`/`stdout` on **`Tasks.Exec`** — the shim resolves paths with `os.Stat`/`open` and does not strip URL schemes. Then `terminal: true` and an OCI **Process** spec (`args: ["/bin/sh"]`, env includes `TERM=xterm-256color`). The backend opens **its ends of the FIFOs before `Tasks.Start`** (non-blocking, see **Exec FIFO I/O**): the shim opens the other ends with blocking opens during Start, so a backend reader/writer must already exist — opening only after Start returns deadlocks until containerd’s console copy times out (`DEADLINE_EXCEEDED`).
3. Bridges **binary WebSocket frames** to the FIFO sockets; **text** frames with `{ type: "resize", cols, rows }` call **`Tasks.ResizePty`**. When the shell exits (stdout EOF) the backend closes the WebSocket with **`1000` `session ended`**, which the client shows as *Session ended* instead of reconnecting — close codes and client behaviour: [CONSOLE.md](CONSOLE.md) § Container console sessions.
4. On WebSocket close (or a failed exec setup), closes the FIFO sockets; if the shell is still running, **`Tasks.Kill`** (SIGKILL) and waits for the **`Tasks.Wait`** armed after Start to settle (bounded at 5 s) — the shim refuses **`Tasks.DeleteProcess`** on a live exec, which would leave it behind as a stopped process — then **`Tasks.DeleteProcess`** for the exec id, then removes the temp directory. A WebSocket that closes while the exec is still being set up gets the same teardown as soon as setup finishes — no shell is left running in the container.

**Exec FIFO I/O stays off the libuv threadpool** *(settled 2026-10-16)*. Both exec functions open their FIFO ends with `O_NONBLOCK` and wrap each fd in a `net.Socket`, which the event loop polls (epoll). The rejected approach was `fs.createReadStream` / `createWriteStream`: their `open()` and `read()` are blocking syscalls run on the threadpool, so a pool thread stays pinned while the other end is absent (failed Start — the open never returns) or idle (an open console — read blocks until the user types). The pool has 4 threads: four idle consoles stalled every fs op, `dns.lookup`, crypto and zlib call in the backend, and a blocked thread also hangs process exit (service stop, self-update restart). Open flags, chosen against the shim's blocking opens:
- **stdout / stderr (we read):** `O_RDONLY|O_NONBLOCK` succeeds with no writer present. Linux suppresses EPOLLHUP until a writer has been seen, so there is no spurious EOF before the shim connects; EOF arrives when the shim closes its write end (process exit). (macOS kqueue never reports a FIFO writer close — irrelevant in production since darwin has no containerd, but it means a darwin harness cannot observe exec EOF.)
- **stdin (we write):** `O_WRONLY|O_NONBLOCK` fails with `ENXIO` until the shim's reader exists, and the shim opens it in the background during Start, so the backend opens `O_RDWR|O_NONBLOCK` instead — it never blocks and gives the shim's reader a writer to find. The read half is never read; closing the socket gives the shim EOF on stdin.

The exec process uses the same **UID/GID** as the main container task (`runAsRoot` in `container.json` vs deploy user). macOS dev builds have no containerd — the console WebSocket is unavailable (same as other container operations).

## OCI Runtime Spec

`buildOCISpec()` generates an OCI 1.1.0 runtime spec from `container.json` + image config:

- Default Linux namespaces: pid, ipc, uts, mount, network, cgroup. For **`network.type: bridge`**, the network namespace uses **`path: /var/run/netns/<name>`** so the process joins the netns CNI configured (a bare `network` namespace without `path` would be a new empty netns and ignore the CNI-created veth).
- Default capabilities: standard container set (chown, net_bind, etc.)
- **Seccomp:** every task runs under **Docker's default seccomp profile** (`linux.seccomp`, added in one place in `buildOCISpec`). The profile is vendored unmodified from moby/profiles (`containerManager/linux/seccomp/default.json`, tag `seccomp/v0.2.4`, Apache-2.0 — attribution and license in `seccomp/NOTICE.txt`) and converted to the OCI form by `containerManagerSeccomp.js` exactly as moby's `setupSeccomp` does (host arch + sub-arches; rules kept or dropped by their arch / capability / `minKernel` conditions against the bounding set above and `uname -r`). Unlisted syscalls fail with `EPERM`; with no `CAP_SYS_ADMIN` that includes `mount`, `unshare`, `setns` and namespace-creating `clone` flags, `clone3` returns `ENOSYS` (libc falls back to `clone`), and `AF_ALG` / `AF_VSOCK` sockets are refused. There is no per-container opt-out (backlog: *Per-container seccomp opt-out*). (settled 2026-10-16 — the same filter Docker applies by default, so images that run under Docker run here; rejected: no filter, which left the full syscall surface to every image.)
- Default mounts: proc, dev, devpts, shm, mqueue, sysfs, cgroup, run
- **Process user:** `process.user` uses the **backend process UID/GID** (the systemd deploy user) by default, so files created on bind mounts under `files/<name>/` remain owned by that user and the backend can delete them. If the backend runs as root (unusual), UID/GID stay 0. When **`runAsRoot: true`** is set in `container.json`, UID/GID are forced to 0 — required for images that write to root-owned directories inside the container (e.g. OpenWebUI writing `.webui_secret_key` to `/app`). Each **Local** bind mount then receives a per-mount **idmapped mount** (size:1) translating the configured `containerOwnerUid`/`containerOwnerGid` (defaults 0/0) to the deploy UID/GID — so writes from that in-container UID still land on disk owned by the deploy user. See [Idmapped Local mounts](#idmapped-local-mounts) for full semantics, the no-op case (`containerOwnerUid === deployUid`), and the runc/kernel requirements.
- User bind mounts: Local rows use `files/<m.name>` (`type` determines file vs directory); Storage rows use `<settings.mounts[m.sourceId].mountPath>/<m.subPath>`. On start the source is the realpath from `resolveBindSources` (see Mounts → *Re-check at task create*); define-time specs (create, restore) use `resolveMountHostPath(m)` and are replaced on every start. All bind mounts use `rbind` (+ `ro` when `m.readonly`). Local mounts under `runAsRoot` additionally carry `uidMappings`/`gidMappings`; Storage mounts never do.
- **Host devices** (`config.devices`): each entry emits a `linux.devices` chardev node, a matching `linux.resources.devices` cgroup allow rule, and pushes the host's `render` GID onto `process.user.additionalGids`. See [Devices entry](#devices-entry). The mechanism is generic to character devices; `type: "gpu"` is the only consumer in v1.
- CPU quota/period from `cpuLimit`, memory limit from `memoryLimitMiB`
- `/etc/resolv.conf` bind-mounted from host. When the container's bridge is the primary one (not a VLAN sub-bridge — names matching `*.<n>` or `*-vlanN`), the shared `/var/lib/wisp/container-resolv.conf` is used — a single `nameserver 169.254.53.53` line — so containers reach the in-process DNS forwarder in `wisp` (see **Local DNS** below). VLAN sub-bridges (or hosts where `setup-server.sh` never ran the `container-dns.sh` step) fall back to the host's upstream resolvers (`/run/systemd/resolve/resolv.conf` on resolved hosts, else `/etc/resolv.conf`) — resolved's `127.0.0.53` stub is unreachable from a container netns. The decision is by bridge name, not by probing the bridge's current addresses, because the stub IP is asserted on every wisp start (`wisp.service` `ExecStartPre=+`) — probing would race when the IP is briefly missing during a restart and bake the wrong resolv.conf into the container's run.

## Networking

Containers are attached as **veth ports on a host Linux bridge** (`br0`, or a VLAN sub-bridge `br0-vlanN`) via the **CNI bridge plugin**, exactly the same topology libvirt uses for VM NICs. Each container gets its own MAC, its own DHCP-assigned LAN IP, and — critically — **is reachable from the host** because the host already has an IP on the same bridge. This replaced an earlier macvlan setup, which isolated containers from the host by kernel design.

- **No Docker-style `-p` publish:** The container is on the LAN like a small VM. If nginx listens on port 80 inside the image, browse to `http://<container-ip>/` from any machine on the same LAN — including the Wisp host itself. Firewall rules on the host or image still apply. The Network section shows `ExposedPorts` from the OCI image config (Dockerfile `EXPOSE` directives) as informational badges so users know which ports the image intends to serve.
- **Stable MAC:** Wisp assigns a locally administered MAC at create time, persists it in `container.json`, and passes it to the CNI bridge plugin on every **ADD** as the top-level `mac` field. `cni-dhcp` keys leases by MAC, so a container keeps the same IP across stop/start.
- **Interface selection:** `network.interface` must be an existing Linux bridge (`br0`, `br0-vlan10`, etc.). The UI picks from the host bridge list (`/api/host/bridges`). Interface changes require the container to be stopped. For a VLAN-specific container, create a managed VLAN bridge (e.g. `br0-vlan10`) in Host Mgmt and point the container at it.
- **Host ↔ container reachability:** Free on the untagged bridge — no `promiscMode`, no extra routing. Host reachability **on VLAN sub-bridges** is a host-config concern (the host needs an IP on that sub-bridge); Wisp itself does not configure it.
- **Pre-ADD bridge validation:** `setupNetwork()` asserts `/sys/class/net/<iface>/bridge` exists before every CNI ADD. Without this, the bridge CNI plugin would silently create an orphan bridge under the given name.
- **IP in the UI:** After each successful CNI **ADD**, the backend stores `network.ip` in `container.json` (and may fill `mac` from the CNI result only when no MAC was already persisted). With **`ipam.type: dhcp`**, the CNI result often has **no `ips[]`** (the `cni-dhcp` daemon assigns the address shortly after). When the container **task PID** is known, Wisp prefers reading the address from **`/proc/<pid>/net/fib_trie`** (no sudo). Before the task exists (e.g. polling right after CNI **ADD**), or if `/proc` parsing finds no address, Wisp falls back to **`sudo wisp-netns ipv4 <name> eth0`**. **`GET /api/containers/:name`** also probes if the task is running but `network.ip` is still empty — so the UI catches up after DHCP is slow.
- Re-run **`install-helpers.sh`** after upgrading so `/usr/local/bin/wisp-netns` includes the **`ipv4`** subcommand (needed for fallback when PID is unavailable or `/proc` has no lease yet).
- CNI plugins installed to `/opt/cni/bin/` by `scripts/linux/setup/cni.sh`. The downloaded tarball is verified against a **SHA-256 pinned in the script** (per arch, committed to the repo) before extraction — not against the sibling `.sha256` from the same release. Update the pinned hashes when bumping `CNI_VERSION`.
- Systemwide conflist at `/etc/cni/net.d/10-wisp-bridge.conflist`: `type: bridge`, `isGateway: false`, `ipMasq: false`, `hairpinMode: false`, `promiscMode: false`, `forceAddress: false`, `ipam.type: dhcp`. The `bridge` field is overridden per container from `network.interface` before each invocation.
- DHCP IPAM via `cni-dhcp.service` systemd unit (plugin-agnostic; key on MAC)
- Network namespace per container at `/var/run/netns/<name>`
- CNI plugins are invoked via the **`wisp-cni`** privileged helper and **`sudo -n`** when the backend runs as the deploy user (`User=` in systemd). `wisp-cni` pins the CNI bin dir to `/opt/cni/bin`, validates its plugin-name argument against `^[a-z0-9-]+$`, confines the resolved plugin under the bin dir via `realpath`, and only reads a config file owned by the caller, so neither a plugin name nor a bin-dir argument can make it run an arbitrary root binary (details: [DEPLOYMENT.md — `wisp-cni`](DEPLOYMENT.md)). Stdin netconf merges **`.conflist` top-level `cniVersion` and `name` into the bridge `plugins[0]` object** (the fragment alone is not valid for a direct plugin exec). **`wisp-netns`** creates `/var/run/netns/<name>` with `ip netns add`. Install both with **`install-helpers.sh`** / **`wispctl.sh helpers`** (same pattern as `wisp-mount`). **`cni-dhcp.service`** must be running when using `ipam.type: dhcp`.
- Before **ADD**, if the netns file already exists, **`setupNetwork`** runs **CNI DEL** and **`ip netns delete`** so a leftover **`eth0`** from a failed stop does not cause `ADD` to error on "device exists".
- **Network setup failure aborts the start.** If `setupNetwork` throws (missing bridge, CNI plugin failure, DHCP lease timeout, stale netns that won't release, etc.), `startExistingContainer` tears down partial state (CNI DEL + netns + snapshot) and re-throws as `CONTAINER_NETWORK_SETUP_FAILED` (HTTP 503) — the task is never created, so the user sees the action fail in the UI instead of getting a "running" container with logs flowing but no reachable service.

## Local DNS (mDNS)

Two independent pieces. **Publishing** advertises a container as `<name>.local` on the LAN so peers can find it. **Resolution** lets an app *inside* the container query `foo.local`.

### Publishing (avahi-daemon via DBus)

- Controlled by **`localDns`** in `container.json`
- Name source: container name, sanitized to a DNS label (lowercase alnum + `-`, max 63 chars)
- Address source: `network.ip` (A record) plus `network.ip6` when present (AAAA record), CIDR masks stripped before registration; both families ride one Avahi entry group per container.
- **Why the AAAA is published (settled 2026-08-17):** dual-stack resolvers (macOS `getaddrinfo`) query A and AAAA together; an unanswered family stalls resolution for the client's full local timeout (~5s on macOS) even though the A answered instantly. Avahi never sends RFC 6762 negative responses for entry-group records — publishing an NSEC record was tested and rejected: Avahi accepts and serves it for exact-type queries only, never as an AAAA-query denial, so the benefit dies with the 120 s announcement-cache TTL. Real AAAA records answer at query time and are durable. Clients with both records still connect over IPv4 (RFC 6724 prefers IPv4 over ULA IPv6), so v4-only listeners inside containers are unaffected.
- Register / deregister: driven entirely by `containerManager.subscribeContainerNetworkChange`. The reconciler (`lib/containerMdnsReconciler.js`) registers when the event fires with `snapshot.ip` and the container's `localDns` is true; deregisters when the snapshot is `null` (stopped, killed, deleted, no longer on bridge) or when `localDns` is toggled off. Routes call `publishContainer` / `unpublishContainer` directly for metadata flips: `localDns` toggle, rename, and pre-delete cleanup. `publishContainer` publishes only a **running** container with **`localDns: true`** — `container.json` keeps the last addresses after a stop, so they alone never get published (a rename of a stopped container publishes nothing; the next start does).
- **One operation at a time per container:** every reconciler operation for a container — event handlers and the route calls — runs on that container's promise chain, in arrival order. Each handler awaits a config read before acting; without the chain a "running" handler still reading could register after the following "stopped" handler had found nothing to deregister, leaving a crashed container published.
- UI: General section has a **DNS** toggle (Local DNS); stats bar shows the registered `.local` hostname when active. The hostname reaches the bar on the per-container stats SSE (`mdnsHostname`, alongside `ip`), re-read from the live config each tick — registration only happens once the container is running, so the config the panel fetched on select would never carry it.
- Best-effort behavior: if avahi-daemon is unavailable, container operations continue unchanged and mDNS is skipped
- **Network probe + IP persistence:** `containerManager/linux/containerManagerNetworkEvents.js` runs every **60 s** and, for every running bridge container, reads the live netns IPv4 via `discoverIpv4InNetnsOnce` and the global IPv6 from `/proc/<taskPid>/net/if_inet6`. If a live address differs from `network.ip` / `network.ip6` in `container.json`, containerManager **atomically rewrites the config first**, then fires `subscribeContainerNetworkChange` so the reconciler refreshes the address records. Without this loop, an asynchronous DHCP renewal or SLAAC change would leave the published `.local` host pointing at a stale address forever — and other readers of `getContainerConfig` would see stale state.
- **Replay-on-subscribe:** `subscribeContainerNetworkChange` invokes the new handler once per known snapshot when it subscribes, so boot-time registration happens automatically when `startContainerMdnsReconciler` runs — no separate warm-up loop in `index.js`.
- **Avahi restart recovery:** `lib/mdns/linux/avahi.js` subscribes to DBus `NameOwnerChanged` on `org.freedesktop.Avahi`. When avahi-daemon disappears (package upgrade, manual restart), the in-memory entry maps (addresses **and** services) are kept but each entry's `group` handle is cleared. When avahi reappears, every stored registration is re-added. Without this, restarting avahi would silently drop all container publications until wisp was restarted too
- **Stuck-probe recovery (settled 2026-10-16):** avahi 0.8 leaks an entry group's probe counter when an interface the group is still probing on goes away (`remove_announcer` never decrements `n_probing`; fixed upstream in avahi commit `cb15988`, absent from Ubuntu 26.04's `0.8-18ubuntu1.1`). The group then stays `REGISTERING` forever with no further signal: none of its records are announced or answered, so `<name>.local` stops resolving on the host and the LAN while `mdnsHostname` still reports it. Wisp removes such interfaces itself — stop leaves the netns and its host-side veth in place and the next start deletes them (CNI DEL), so the first container of a back-to-back start (records committed within ~1 s of the second start's veth removal) failed every time; a VM stop takes its tap with it. Recovery is driven by those removals: the mdns module tracks every group it commits through `EntryGroup.StateChanged` (`REGISTERING` from the moment `Commit` is sent), and after each Wisp-initiated removal `republishProbingGroups()` `Reset`s, refills and re-commits every group still `REGISTERING` (`Reset` zeroes the leaked counter). Triggers: `containerManager.subscribeContainerNetnsRemoved` — fired after a container's netns is deleted (the stale netns a start clears, teardown on delete or failed start, rename's orphan cleanup), wired in `containerMdnsReconciler` — and the VM network-change `null` snapshot (the VM left the running state; libvirt has removed the tap by the time it reports the stop), wired in `vmMdnsReconciler`. The trigger runs after the removal has returned, so avahi has already dropped the interface: a group still probing then was stranded by it, and one committed later probes only the interfaces that remain. Covers every group Wisp commits — container and VM address records, container SRV/TXT services, the `_wisp._tcp` announcement. `COLLISION` / `FAILURE` are logged, not recovered. **Not covered:** interfaces removed outside Wisp (a manual `ip link del`, a NIC or Wi-Fi link dropping, another tool's veth/tap) — a group probing on one of those stays stuck until it is re-registered (`localDns` toggle, container restart, wisp restart). Rejected: a 10 s deadline after every `Commit` that re-commits a group still `REGISTERING` (covers every removal, but a timer standing in for a signal; the removals that matter are Wisp's own and carry an event); publishing on explicit interfaces instead of `IF_UNSPEC` (keeps announcers off the churning veth/tap bridge ports, but records would no longer follow bridge re-creation or new interfaces without an interface watch, and it changes where VLAN-bridge workloads are visible); `deny-interfaces` in `avahi-daemon.conf` (exact names only, no wildcards for `veth*`/`vnet*`)
- **Service advertisements:** in addition to the host A record above, `services[]` entries publish SRV+TXT via `EntryGroup.AddService(if=-1, proto=-1, flags=0, instanceName=containerName, type, domain="", host="<name>.local", port, txt)`. Each service has its own EntryGroup keyed by `${containerName}#${port}` so individual services can be removed without disturbing the address record. Instance name defaults to the container name (collision-resolved by Avahi if duplicated on the LAN). See [Service entry](#service-entry)

### Resolution (in-process DNS forwarder on 169.254.53.53)

Container apps that `getaddrinfo("foo.local")` need a resolver that speaks mDNS. Rather than install mDNS infrastructure inside every container — or stand up a second mDNS daemon on the host — Wisp runs a small **DNS forwarder inside the wisp process** (`backend/src/lib/mdns/linux/forwarder.js`) that containers query via unicast DNS. The forwarder answers Wisp-published workloads and the host's own name itself, translates other `.local` queries into avahi DBus calls, and relays everything else to the host's upstream DNS.

- `scripts/linux/setup/container-dns.sh` holds link-local **`169.254.53.53/32`** on the dummy interface `wisp-dns0` (never on `br0` — see Persistence below) and writes `/var/lib/wisp/container-resolv.conf` (a single `nameserver 169.254.53.53` line)
- `forwarder.js` binds **UDP + TCP port 53** on `169.254.53.53`. Binding to privileged port 53 requires `CAP_NET_BIND_SERVICE`, granted to `wisp.service` via `AmbientCapabilities=CAP_NET_BIND_SERVICE` (the service otherwise runs unprivileged as the deploy user)
- When the container's bridge is the primary one (not a VLAN sub-bridge), `resolveContainerResolvConf()` returns the shared `container-resolv.conf` and the OCI spec bind-mounts it at `/etc/resolv.conf`. The decision is keyed on bridge name (`isVlanLikeBridgeName()`) rather than probing the bridge's current addresses — `wisp.service` re-asserts `169.254.53.53/32` on every start, so probing would race during restart windows and freeze the wrong choice into the container's run
- After CNI ADD on the primary bridge, `setupNetwork` installs `169.254.53.53/32 dev eth0` inside the container's netns via `wisp-netns route-add`. Without this on-link /32, the container's kernel would send DNS to the LAN gateway (its DHCP default route) and queries would black-hole; the route makes the kernel ARP directly on the veth so br0 answers
- Containers on VLAN sub-bridges (`br0-vlan10`, `eth0.100`, …) fall back to the host's upstream resolvers and get no `.local` resolution — Linux bridges switch, they don't route, so the stub IP is unreachable from a sub-bridge segment
- **Persistence — the stub IP lives on its own interface, never on br0.** `container-dns.sh` declares a dummy device `wisp-dns0` to systemd-networkd via `/etc/systemd/network/10-wisp-dns0.netdev` + `.network` (`Address=169.254.53.53/32`, `LinkLocalAddressing=no`, `IPv6AcceptRA=no`). Written at install time and refreshed by `wisp-updater` on every self-update. Containers still reach it: each carries an on-link `169.254.53.53/32 dev eth0` route and ARPs on the bridge segment, and Linux's weak host model (`arp_ignore=0`) has the host answer from br0 for an address held anywhere. Verified 2026-07-31 on the production host.
  - **Scope is `link`, and that is fine.** iproute2 and networkd both assign scope link to anything in 169.254/16. It does not affect replies to containers because the forwarder binds the address explicitly, so the kernel never runs source-address selection. Verified working with scope link on the production host.
  - **`RequiredForOnline=no`.** A link-local-only device settles at `degraded (configured)`, which participates in `systemd-networkd-wait-online`. `wisp.service` is ordered `After=network-online.target`, so this device is explicitly excluded rather than left to depend on wait-online's default operational-state threshold.
  - **Why not runtime-only on br0 (the original design):** any networkd restart — an unattended systemd upgrade suffices — re-applied br0's `.network` and flushed the address. Silent and total: the forwarder's socket stays bound to the vanished IP so `ss` still reports it listening, while **every** container DNS query black-holes, not just `.local`, until wisp restarts. Observed as a 10-hour outage surfacing only as Caddy 502s.
  - **Why not declared on br0 (v2.0.1–v2.0.2, reverted):** with the address in br0's own `.network`, a reconfigure applies the static address immediately while DHCP takes a round-trip, leaving br0 momentarily holding **only** the link-local. avahi published `<host>.local → 169.254.53.53` in that window, re-announced with the real address, hit a name conflict and renamed the host to `<host>-2` — breaking every consumer of the host's `.local` name, including the Caddy hop that fronts the UI. Strictly worse than the bug it fixed. `container-dns.sh` deletes any leftover `*.network.d/wisp-mdns-stub.conf` it finds.
  - **Why not netplan:** an `addresses:` entry alongside `dhcp4: true` on a bridge puts networkd into a reconcile loop that flaps the LAN address — see `docs/plans/setup-refactor.md`.
  - **avahi needs no configuration.** It does register the address on `wisp-dns0` (`avahi-resolve -a 169.254.53.53` answers locally), but announces address records only on the interface holding them, and `wisp-dns0` has no peers. Confirmed from a LAN client: `dns-sd -Gv4 wisp.local` returns only the routable address. No `deny-interfaces` entry is needed — which matters, since `avahi-daemon.conf` has no drop-in support and would have to be rewritten in place.
  - **One runtime assertion remains** for hosts networkd does not manage (NetworkManager): `wisp.service` `ExecStartPre=+` creates `wisp-dns0` if absent, brings it up, and adds the address if missing, ending in `exit 0` so a failure degrades container DNS rather than blocking startup. `wisp-bridge` no longer re-asserts anything after `netplan apply` — the address is no longer br0's business, so a bridge re-render cannot disturb it.

**Forwarder dispatch logic:**

| Query | Handling |
|---|---|
| `*.local` forward (A / AAAA) — Wisp workload | Names published by this Wisp instance answer from in-memory state (per-family: A from `ip4`, AAAA from `ip6`, empty NOERROR for a family that isn't published — no avahi round-trip, no multicast wait) |
| `*.local` forward (A / AAAA) — the host's own name | avahi's current host name (`GetHostNameFqdn`, e.g. `wisp.local`) answers from the addresses on the containers' bridge, read at query time with `os.networkInterfaces()`: every IPv4 except link-local, and global/ULA IPv6 only. One answer record per address; NOERROR with no answer for a family the bridge has no usable address in. No avahi round-trip. See *Host's own name* below |
| `*.local` forward (A / AAAA) — anything else | `resolveLocalName` → avahi `ResolveHostName` over DBus (capped at 1.5 s → NOERROR, no answer), which serves LAN peers via multicast query. Same-host lookups work because the DBus call bypasses multicast entirely, sidestepping avahi's same-host loop prevention. A **link-local** result (`169.254.0.0/16`, `fe80::/10`) is dropped → NOERROR, no answer |
| `*.in-addr.arpa` / `*.ip6.arpa` (PTR) | `resolveLocalAddress` → avahi `ResolveAddress` over DBus. Falls through to upstream on miss so real reverse zones still resolve |
| Everything else | Raw relay to the first IPv4 `nameserver` from `/etc/resolv.conf` (on systemd-resolved hosts, that is `127.0.0.53` — resolved handles real forwarding), **over the transport the query arrived on**: UDP queries over a `connect()`ed UDP socket (the kernel drops datagrams from any other source, so a stray or spoofed packet to the ephemeral port can't be taken as the answer), TCP queries over TCP (they are usually a retry after a truncated UDP answer — relaying them over UDP would just truncate again). `UPSTREAM_TIMEOUT_MS=5000`; SERVFAIL on timeout, refusal or reset |

The forwarder hand-rolls minimal DNS packet parse/build (A/AAAA/PTR answers only; responses use a name-compression pointer back to the question section). It never blocks the node event loop: avahi DBus calls and upstream relays are async, with bounded timeouts. If port 53 can't be bound (missing capability, stub IP not on `wisp-dns0`), the forwarder logs a warning and the backend continues to run — VM/container management works, only `.local` inside containers is unavailable.

**Host's own name (settled 2026-10-16).** Containers resolve the host's `.local` name directly in the forwarder, never through avahi:

- **Name:** avahi's, not `os.hostname()` — `avahi.js` reads `Server.GetHostNameFqdn` at connect and again on every `Server.StateChanged` signal (avahi walks REGISTERING → RUNNING on any host-name change, including its automatic `<host>-2` rename on a LAN conflict) and when avahi reappears on the bus. Following the rename keeps containers on the name avahi actually publishes; the old name then belongs to whoever won the conflict and takes the avahi path like any LAN peer. While avahi is away the last known name is kept. Until the first read lands (avahi absent at boot) the name takes the avahi path.
- **Addresses:** the bridge new containers attach to (`getDefaultContainerParentBridge()` — `WISP_DEFAULT_BRIDGE` or the first non-VLAN bridge, normally `br0`), passed to `connectMdns` once at boot; a bridge created later is picked up on the next wisp restart. Containers reach the host on-link over that bridge, so its addresses are the ones that work for them. Other uplinks (a second NIC, `wg0`, `virbr0`) are deliberately left out — they may not be reachable from the container segment. Link-local is never answered.
- **Why (evidence, production host 2026-10-03 → 10-16):** a Caddy container logged 282 `lookup wisp.local on 169.254.53.53:53: no such host` errors in ~50 bursts of 20–80 s. Every other `.local` upstream was a Wisp workload on the fast path and never failed; `wisp.local` was the only name on the avahi slow path, which returned NODATA at the 1.5 s cap during the bursts (Go reports NODATA as "no such host"). Steady-state and cold-cache probes of that path answered in ~25 ms and host logs were silent at burst times, so the avahi stall itself is **unexplained** — the fix takes the host's name off the path rather than diagnosing it. Separately, avahi publishes the host name on every veth/vnet link, so an AAAA lookup returned a random container veth's `fe80::` address, which the forwarder passed through (unusable without a zone, on the wrong link: `connect: invalid argument`) — hence the link-local filter on the slow path too.
- **Rejected:** raising the 1.5 s avahi cap — the bursts outlast any cap a client would wait for, and a longer cap stalls container apps on names nobody publishes. **Deferred:** an avahi `deny-interfaces` entry for `veth*`/`vnet*` (would stop the link-local publication at its source, but `avahi-daemon.conf` has no drop-in support and must be rewritten in place) — revisit if a non-container consumer is hurt by the per-veth records.

**Why this instead of `systemd-resolved` as the stub:** systemd-resolved with `MulticastDNS=resolve` and avahi-daemon both want to bind UDP 5353 and conflict in practice (resolved's mDNS queries time out because avahi owns the multicast group). An earlier design used resolved at the stub address and worked around the conflict with a bind-mounted `/etc/hosts` in every container; the forwarder replaces both pieces with a single path that goes directly to avahi.

## Image Management

- **Reference normalization follows Docker's rule** (`normalizeImageRef`): the first path component is a registry host only when it contains `.` or `:`, is `localhost`, or has an uppercase letter — so `nas:5000/app` and `localhost/app` stay as written; anything else is on Docker Hub (`user/app` → `docker.io/user/app`), a single-component Hub repo gets `library/` (`caddy:2` → `docker.io/library/caddy:2`), and `index.docker.io` becomes `docker.io`. No tag is added.
- **Delete is by exact name:** the image library deletes the name containerd lists, never a normalized form — `myapp:v1` deletes that local image, not a `docker.io/library/myapp:v1` twin. The in-use check matches a container whose `image` is that name verbatim or normalizes to it.
- **Local-image shortcut:** before normalization + pull, `createContainer` calls `Images.get({ name: spec.image })` against containerd. If the exact literal ref already exists (for example an image loaded with `ctr -n wisp image import foo.tar`, or one picked verbatim from the image library), it is used as-is — no normalization, no pull — and the create SSE emits a `using-local` step instead of `pulling`. This is what lets locally built images such as `myapp:v1` or `localhost/myapp:dev` work: the normalize step would otherwise rewrite them to `docker.io/library/…` and the registry pull would fail. Registry-named refs (`nginx:latest` and friends) still go through the normalize + pull path unchanged.
- **One stored form, every writer** *(settled 2026-10-16)*: create, `PATCH image` and MCP `update_container_image` store the ref through the same rule (`resolveContainerImageRef`): the exact literal name when containerd holds one, else the normalized ref — the name a pull stores the image under. A stored short ref (`nginx:1.27`) was looked up literally at start, missed the `docker.io/library/nginx:1.27` the auto-pull had just stored, and failed every start with a 404. The start path also looks the image config and digest up by the ref `pullImage` returns, so a short ref already on disk starts too (re-pulling each start until it is re-saved — any `PATCH image` stores it normalized). A blank `image` in a PATCH answers **422** `INVALID_CONTAINER_IMAGE_REF`.
- **Picker:** the Create Container form has a **Browse…** button next to the Image field that opens the shared image library modal pre-filtered to the **OCI** tab. Any image visible to `GET /api/containers/images` (anything in the `wisp` containerd namespace) is selectable; picking one populates the Image field verbatim so the local-image shortcut above applies.
- Image pulling uses the Transfer gRPC service with protobuf-encoded Any fields
- Transfer `source` (OCIRegistry) and `destination` (ImageStore) are packed via `packProtoAny` using `protobufjs` for binary encoding (required because `@grpc/proto-loader` only exposes descriptor objects, not encodable Types)
- Multi-platform images (OCI index / Docker manifest list) are resolved to **Linux + host architecture** (`process.arch` → OCI architecture) before reading the image config. There is **no** fallback to the first index entry (registry order may list Windows or other OS first). If no matching Linux manifest exists for the host arch, image resolution fails with a clear error listing available platforms. Nested indexes are walked until a concrete image manifest is reached.
- The Transfer `ImageStore` destination sets **`platforms`** (download filter) **and** `unpacks` (snapshot unpack) to the same host platform (`linux/<arch>`). Without `platforms`, containerd downloads layers for **all** listed platforms (including Windows), which makes multi-arch pulls like `caddy:latest` extremely slow. With `arm64`, `variant: v8` is included on both fields.
- Image config (Entrypoint, Cmd, Env, WorkingDir, rootfs.diff_ids) read from content store
- The Transfer `ImageStore` destination includes an `unpacks` field (proto field 10) so containerd unpacks layers into overlayfs snapshots during pull
- Snapshot parent key is the chain ID computed from `rootfs.diff_ids` using full digest strings including the `sha256:` prefix (matches Go's `identity.ChainID` which concatenates `digest.Digest` values directly)
- Images are stored in containerd's content store, not in Wisp's filesystem
- Create progress is delivered over **SSE** (`/api/containers/create-progress/:jobId`). Large pulls may run for many minutes without real **percentage** (containerd Transfer does not expose it through the current unary API); the UI shows **elapsed time** every 15s during pull.

### Image updates

Wisp checks every OCI image in the library for upstream changes and flags containers running stale bits.

- **Trigger:** a background sweep runs **60 seconds after backend boot** and **every hour** thereafter. The UI also exposes two manual triggers from the Image Library OCI tab — a bulk **Check for updates** button and a per-row **Check this image** button.
- **How the check works:** for each image, the current top-level digest is recorded, the image is re-pulled via the existing Transfer service, and the new digest is compared. The pull is idempotent — when the upstream digest is unchanged, containerd does **HEAD** only and skips layer downloads. When the digest differs, new layers are downloaded and stored alongside the old ones (containerd keeps whichever are still referenced by a snapshot).
- **Skipped images:** locally built or unreachable refs (no registry, auth required, network down) emit a `skipped` event and continue — one failure never aborts the sweep.
- **Surfacing updates on containers:** nothing is written to container.json. The container list/detail endpoints derive `updateAvailable` per container from (`container.imageDigest` ≠ library digest for its ref) + (task is RUNNING/PAUSED). The library digest comes from `oci-image-meta.json`, refreshed by every `listContainerImages()` call. Every check — the REST job (bulk or single image), the hourly sweep, and MCP `check_image_updates` — ends inside `checkAllImagesForUpdates` / `checkSingleImageForUpdates` by re-reading the library into the sidecar and awaiting a container-list refresh, so the badge appears over SSE without any further event and the REST job only completes (and MCP only answers) once it is visible. Stopped containers always read as `false` — they adopt the new digest on their next start via `startExistingContainer`. The check's SSE `flagged-container` events and `imagesUpdated` count are computed from the same derivation, so the UI surfaces matching counts without persistent flags.
- **Apply on start (and restart):** `startExistingContainer` always removes the existing rootfs snapshot and re-prepares it from the current library image before creating the task — rootfs is ephemeral and any state must live in bind mounts. If containerd's current digest for the reference differs from the stored `imageDigest`, both `imageDigest` and `imagePulledAt` are refreshed. `updateAvailable` is always cleared on start (whether or not it was set). No registry I/O happens here; the restart consumes whatever the most recent check-updates pull (or create-time pull) left in the local image store. No rollback logic: if `prepareSnapshot` fails, the container fails to start and the user must recreate.
- **Auto-pull on missing image:** if the image was removed under us (e.g. `ctr -n wisp image rm <ref>`), `startExistingContainer` catches the `CONTAINER_NOT_FOUND` / `CONTAINER_IMAGE_NOT_FOUND` from the manifest read, runs `pullImage(config.image)`, and retries — the container's image reference is canonical, so re-pulling restores exactly what was there. Operator never has to intervene unless the registry itself is unreachable (in which case the pull surfaces the underlying error).
- **Cached summary:** `GET /api/containers/images/update-status` returns `{ lastCheckedAt, imagesChecked, imagesUpdated }` from the last bulk or single-image run (in-memory, lost on restart).
- **Modified timestamp stability:** containerd's Transfer service bumps the image's `updatedAt` on every pull, including idempotent re-pulls. To keep the Image Library's **Modified** column meaningful, Wisp pins each image's displayed timestamp in a sidecar `oci-image-meta.json` next to `wisp-config.json` (shape: `{ ref: { digest, updatedAt } }`). The sidecar tracks all OCI images regardless of whether any container uses them. `listContainerImages` returns the pinned value while the digest is unchanged, adopts containerd's current `updatedAt` when the digest changes or the entry is new, and prunes refs no longer present in containerd.
- **Pinned digests:** containers whose `image` is `ref@sha256:…` never flag updates — correct behavior (immutable by design).
- **Module:** `backend/src/lib/containerManager/linux/containerManagerImageUpdates.js` (bulk/single entry points + `startImageUpdateChecker`/`stopImageUpdateChecker`). The background timer and SIGTERM-safe AbortController mirror `osUpdates.js`.

### Debugging slow or stuck image pulls (on the server)

- **Wisp logs:** `journalctl -u wisp -f` — shows pull/snapshot errors and any other server-side issues.
- **containerd images (namespace `wisp`):** `sudo ctr -n wisp images ls` — confirm the image reference appears after a successful pull.
- **Active pull:** `sudo ctr -n wisp tasks ls` is usually empty until the container is started; during pull, watch backend logs or `ctr -n wisp content ls` (large output) only if deep debugging is needed.

## Container Lifecycle

1. **Create**: Claim the container directory → Pull image (with unpack) → Prepare snapshot → Build OCI spec → Define container in containerd (**stopped** — no CNI, no task). User configures mounts and settings, then **Start**. Create refuses with **409** `CONTAINER_EXISTS` when the name exists in containerd **or** `<containersPath>/<name>/` already exists (typically `files/` kept by a delete without "delete files") — it never adopts, overwrites, or removes a directory it didn't make. Any failure after the directory is claimed (pull, snapshot, containerd define, invalid mounts/devices) removes only that directory (settled 2026-10-16 — kept files are not re-adopted by create; to reuse them, move `files/<mount>` into another container's mount, or remove the directory to free the name).
2. **Start** (stopped): If a **STOPPED** task still exists in containerd, **Tasks.Delete** it first (otherwise **Tasks.Create** returns `already exists`). Enum status from gRPC may be numeric — normalize before comparing. Remove old rootfs snapshot → Refresh `imageDigest`/`imagePulledAt` → Prepare mount sources (`assertBindSourcesReady`: each Local backing file/dir is created empty when missing, same as **Init**; Storage sub-paths are created inside their root) → Prepare fresh snapshot from current library image → Setup networking (DHCP wait) → Persist the lease → Re-resolve mount sources (`resolveBindSources`) → Build the OCI spec and update the containerd container → Allocate the log run → Persist start-owned fields → Create task → Start task → Register SRV/TXT services. Any failure after network setup rolls back (task, netns/CNI, snapshot, services).
   **The task runs the config read at the beginning of the start**, and every `container.json` write during the start merges only what the start owns into the *latest* file: the lease IP/MAC and the refreshed image digest. Once the task has started, `pendingRestart` is set (`since = now`) if a restart-relevant field (`image`, `command`, limits, `env`, `mounts`, `devices`, `network` minus addresses, `runAsRoot`) was saved after the spec was built (an edit saved during the DHCP wait found no task, so nothing else marks it); an older flag is left to the restart-required rule, which drops it on the next read. Edits made during the wait are never reverted (settled 2026-10-16).
3. **Stop**: SIGTERM → Wait 10s → SIGKILL if needed → Delete task
4. **Kill**: SIGKILL → Wait 5s → Delete task
5. **Restart**: Stop then Start
6. **Delete**: Kill task → Tear down networking → Remove snapshot → Remove containerd container → Delete files on disk (`fs.rm` on the container directory). With `deleteFiles=false` ("keep files") everything in the container directory **except `files/`** is removed — `container.json` first, so the container leaves every list immediately (a directory without `container.json` is not a container) and autostart never retries it; a directory left with an empty or missing `files/` is removed too. The kept `<containersPath>/<name>/files/` blocks re-creating that name until it is moved or removed (see Create). Without `runAsRoot`, the main process runs as the **deploy user's UID/GID**, so bind-mount data under `files/` is removable directly. With `runAsRoot`, idmapped Local mounts (see [Idmapped Local mounts](#idmapped-local-mounts)) translate the configured in-container UID/GID to the deploy user, so files written by that UID also remain removable. Files written by other in-container UIDs through an idmapped mount may end up `nobody`-owned (`overflowuid`) on disk — fix on the host (e.g. `sudo rm -rf <path>`) if delete fails with permission errors.

### Rename

A container's name is its containerd container ID, the directory key under `containersPath`, the netns name, the published `<name>.local` mDNS host, and the URL/SSE channel key. containerd has no Rename API, so rename is implemented as **Containers.Delete(old) → Containers.Create(new) → fs.rename(old → new)**, with the rootfs snapshot dropped along the way. Because the rootfs is [ephemeral](#ephemeral-rootfs), the writable layer doesn't need to be preserved — the next start re-prepares the snapshot from the image under the new key.

**Surface:** rename rides on `PATCH /api/containers/:name` — the user edits the **Name** field in the General section like any other field. When the request body's `name` differs from the URL segment, the route runs `renameContainer(oldName, newName)` first and then applies the rest of the patch under the new name; the response carries the name in effect so clients can follow up with the new URL. There is no separate rename endpoint.

**Preconditions:**

- Container must be **stopped** (no running/paused task). Returns **409** `CONTAINER_MUST_BE_STOPPED` otherwise. The user is expected to stop the container manually first; the rename does not auto-stop. The General section's Name input is correspondingly disabled when the container is `running`, `paused`, or `pausing` (matching the same gating used on `network.mac` / `network.interface`).
- New name must pass `validateContainerName` (1–63 chars, regex `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$`, no `..` / path separators).
- New name must not already exist as a containerd container or as a directory under `containersPath`. Returns **409** `CONTAINER_EXISTS` otherwise.

**Order of operations** (in `containerManagerRename.js`):

1. Validate new name and preconditions; finalize any dangling STOPPED task via `cleanupTask`.
2. Capture the old `Containers.Get` record (for rollback).
3. `Containers.Delete(old)`.
4. `Snapshots.Remove(old)` — best-effort. Ephemeral rootfs means a missing snapshot is fine.
5. `Containers.Create(new)` reusing the captured runtime / spec / labels / snapshotter, with `id` and `snapshotKey` set to the new name.
6. `fs.rename(<containersPath>/<old>, <containersPath>/<new>)` — atomic on the same filesystem.
7. `renameWorkloadAssignment('container', oldName, newName)` — moves the entry in `settings.assignments` from `container:<old>` to `container:<new>` so a workload in a custom section keeps that section after rename. The frontend reads sections from `GET /api/sections` (mirrored into `sectionsStore`), not from the container list SSE, so the renamed container picks up its section the next time the client refetches that endpoint.
8. Rewrite `container.json` under the new dir with `name: <new>` (also fans out a config-write notification → SSE list refresh).
9. Best-effort cleanup under the old name: `deregisterAddress`, `deregisterServicesForContainer`, `wisp-netns delete <old>` for any orphan netns left behind by a previous run (stop does not tear down the netns; setupNetwork on next start would otherwise leak it).

**Rollback:** if step 5 fails, the old containerd container record is recreated from the captured spec. If step 6 fails after step 5 succeeded, the new container record is deleted and the old one is recreated. The on-disk directory and `container.json` are only touched after containerd has accepted the new id.

**Client effects (breaking):** the URL `/api/containers/:name/...` and any open SSE / WS channels (stats, logs, container console) under the old name stop responding immediately. PATCH responses always include `name` (the post-rename name, or the unchanged name when no rename happened). The frontend `ContainerOverviewPanel` compares the response `name` to the URL segment and, on a change, refetches `/api/sections` (so the LeftPanel's `sectionsStore` mirror picks up the moved assignment), re-selects under the new name (which restarts the stats SSE), then `replace`-navigates to `/container/<newName>/<tab>`. The previous run-log files travel with the directory rename and remain accessible under the new name.

**Why no auto-stop:** rename is intentionally gated on an explicit pre-stop. Auto-stopping would silently restart-equivalent the container's task (the next start runs under the new name with a fresh snapshot), which is too much side effect for what users expect from editing a name field.

### Restart policy

`restartPolicy` decides what happens when a container's **main process exits on its own** — a crash, an OOM kill, a clean exit, a `kill` from inside or from the host (settled 2026-10-16):

| Policy | Exit status 0 | Exit status ≠ 0 | Stopped through Wisp |
|--------|---------------|-----------------|----------------------|
| `never` | stays stopped | stays stopped | stays stopped |
| `on-failure` | stays stopped | restarted | stays stopped |
| `unless-stopped` (default) | restarted | restarted | stays stopped |
| `always` | restarted | restarted | stays stopped |

- **`always` = `unless-stopped`.** Docker's difference — on daemon restart `always` revives containers the user had stopped — is a boot-time behavior, and boot in Wisp belongs to `autostart` alone: `startAutostartContainersAtBackendBoot` starts every `autostart: true` container that isn't running, on host boot and on every `wisp` restart, whatever its policy and whether or not it was stopped by hand. The restart policy never starts anything at boot; there is one boot mechanism, not two. Both values stay offered *(settled 2026-10-16)*: collapsing them into one in the UI and MCP was rejected — the names are Docker's, people bring them along, and keeping both costs nothing.
- **"Stopped through Wisp"** is every exit Wisp itself causes: Stop, Kill, Restart (UI, REST, MCP) and Delete. Those paths call `noteIntentionalStop(name, pid)` before signalling the task; the matching `/tasks/exit` is skipped. Matching is by **pid**, so the exit event of the old task arriving after the next start can't be mistaken for a crash of the new one. Rename and in-place restore (which need a stopped container) and a Stop/Kill on a container that is already stopped cancel a pending restart the same way.
- **Trigger:** containerd's `/tasks/exit` event on the events stream (`containerManagerList.js`). Exits of exec'd processes (console sessions) are ignored — only the main process carries the container id as its process id. Exits that happen while `wisp` is down or the events stream is reconnecting are not replayed (no polling fallback); the container stays stopped until started by hand or by autostart on the next `wisp` start.
- **Backoff:** 1 s, doubling, capped at 5 min, per container; one pending restart at a time. A run that stayed up for 60 s resets the next delay to 1 s (judged at the exit — a deferred or failed attempt keeps escalating). Every decision is logged (`Container exited — restart scheduled by restart policy` with `exitCode`, `policy`, `attempt`, `delayMs`; `restarted`; `skipped: …`; `restart policy does not restart it`).
- **When the timer fires** it takes the container's [operation lock](#per-container-operation-lock) for the whole attempt (label `restart-policy start`). When another operation holds it — a backup, an app-config save, a restore — the attempt is deferred to the next backoff step (logged `Restart-policy restart deferred: …`, never surfaced as an error); Stop, Kill, Start, Delete, Rename and in-place restore cancel the pending restart before they act, so a deferral never revives a container one of them just stopped. With the lock held the state is re-read: a container that was deleted (no `container.json`, including delete-keep-files), switched to `never`, or already started by someone else is left alone. The start is the regular `startContainer` (fresh rootfs, network, new log run — the crashed run is finalized with its exit code); a failed start is logged and retried on the next backoff step. A user Start during the backoff supersedes the pending restart.
- **A scheduled restart is visible** *(settled 2026-10-16)*: while the backoff runs the container is stopped, but list and detail responses carry `scheduledRestart: { attempt, at }` (`getScheduledRestart(name)` in `containerManagerRestartPolicy.js`; every schedule / cancel / fire refreshes the list cache, so the `containers` SSE topic follows). The UI shows a `Restarting in N s` badge and keeps **Stop** enabled.
- **To stop a crash loop:** Stop the container or set the policy to `never`. Stop (or Kill) on a stopped container with a scheduled restart cancels it and answers **200** `{ ok: true, restartCancelled: true }`; with nothing scheduled it stays **409** `CONTAINER_NOT_RUNNING`.
- **Why not containerd's restart monitor plugin** (`containerd.io/restart.*` labels, used by nerdctl): it polls, and it restarts the task with containerd's own primitives — no Wisp network setup (netns/CNI/DHCP), no per-run log file, no fresh rootfs from the library image — so a container it revived would come up unreachable.
- **Placement:** containerManager (generic container-runtime behavior over containerd events, the same layer that already owns autostart-at-boot and the lifecycle calls that must mark intent), not Wisp glue like `containerMdnsReconciler.js`, which combines the manager's events with another subsystem.

### Per-container operation lock

*(settled 2026-10-16)* Operations on one container are mutually exclusive: each takes an in-memory per-container lock (`lib/containerOperationLock.js`, Wisp glue — the container counterpart of the [per-VM lock](BACKUPS.md#per-vm-operation-lock)) and a second one is refused with **409** `CONTAINER_BUSY` instead of queueing. The message names the running operation (`Container "x" is busy (backup in progress)`), so the UI's action error says what to wait for.

- **Who takes it:** Start, Stop, Kill, Restart, Delete (REST and MCP); every `PATCH /api/containers/:name` (rename, config / env / mount / device edits, `appConfig` saves, eject — a rename also holds the target name); the row-scoped mount and service routes (they write `container.json`); backups — manual and scheduled — for the whole background job; in-place restore for the whole job, safety backup included; restore-as-new on the new name; the MCP `deploy_container` (config + start after create), `update_container_image` (config + restart, the pull runs before it), `start/stop/restart_container` and `update_app_config` tools. Held for the duration of the call, or until the job settles (released before the job's `done`, so an action taken on completion never meets a stale 409).
- **Manager-side starts:** the restart policy and the backend-start autostart pass live in containerManager, which can't import glue (CODING-RULES §7). They take the same lock through `tryAcquireOperationLock`, a sync `(name, operation) => release | null` pushed in by `containerManager.configure()` (`lib/managerBootstrap.js`), the same way `resolveMount` is. A busy container defers the policy restart to the next backoff step (see [Restart policy](#restart-policy)) and is skipped by autostart (logged). Rejected: moving the "may start now" decision into glue — the policy's state (backoff, pending timer, intentional-stop pids) is manager-internal, so glue would have to re-implement or reach into it; the injected acquirer keeps the policy whole and the lock policy-free on the manager side.
- **What it closes:** a user Start during a restart-policy start (two starts tearing each other's netns and snapshot down), a start or edit during an in-place restore, rename or delete under a running backup, two concurrent app-config saves, a scheduled backup interleaving with a manual one.
- **Not covered:** mount *content* routes (file / zip upload, content PUT, init, data delete) write into `files/`, not `container.json`, and don't lock; the network reconciler's address persistence into `container.json` is manager-internal and doesn't lock either; create (`POST /api/containers`) doesn't lock the new name.
- **Frontend:** while a backup or in-place restore job for the container runs, Start, Stop, Kill, Restart, Backup and Delete are disabled in the Overview header (labels explain why); anything that still races surfaces the 409 as the action error.

### Backend process startup (host boot / `wisp` restart)

When the Wisp backend process starts (`backend/src/index.js`), after libvirt and containerd connection attempts and after mDNS manager connect:

1. **Configured mounts** — `ensureMounts()` runs to completion (awaited) so Host Mgmt SMB shares and removable-drive adoptions are mounted before any autostart container starts (avoids bind mounts whose host paths live under those shares). The same pass also hard-converges: any mount under `/mnt/wisp/` not present in settings is unmounted.
2. **Stale-pause recovery** — `resumeStalePausedContainersAtBackendBoot()` resumes any container whose task is still `paused`. Wisp has no user-facing pause; tasks are only paused around backup archives, so a paused task at boot means a backup was interrupted by a crash. Runs before autostart so that pass sees accurate states.
3. **Container autostart** — `startAutostartContainersAtBackendBoot()` lists containers from disk + containerd; for each with `autostart: true` that is not already `running`, it calls `startContainer()` while holding the container's [operation lock](#per-container-operation-lock) (a busy container is skipped and logged). Failures are logged per container and do not block other containers.
4. **mDNS warm-up** — For each running container (including any just started), if `localDns` is true and `network.ip` is set, the backend registers the `.local` address.

The HTTP server listens **after** these steps, so hosts with mounts configured may accept API traffic slightly later; when no mounts are configured, `ensureMounts` returns immediately.

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `CONTAINER_NOT_FOUND` | 404 | Container doesn't exist |
| `CONTAINER_RUN_NOT_FOUND` | 404 | Referenced `runId` does not exist in `runs/` |
| `CONTAINER_ALREADY_RUNNING` | 409 | Start called on running container |
| `CONTAINER_NOT_RUNNING` | 409 | Stop/kill called on stopped container |
| `CONTAINER_MUST_BE_STOPPED` | 409 | Operation requires the container to be stopped (e.g. rename, MAC/interface change) |
| `CONTAINER_TASK_TRANSIENT` | 409 | Backup requested while the task is in a transient state (`pausing`/`unknown`) — retry shortly |
| `CONTAINER_BUSY` | 409 | Another operation on this container (named in the message) holds its [operation lock](#per-container-operation-lock) — retry when it finishes |
| `CONTAINER_EXISTS` | 409 | Name conflict on create or rename |
| `IMAGE_PULL_FAILED` | 422 | Failed to pull OCI image |
| `INVALID_CONTAINER_NAME` | 422 | Name validation failed |
| `INVALID_CONTAINER_MOUNTS` | 422 | Mounts array invalid |
| `CONTAINER_MOUNT_DUPLICATE` | 422 | Duplicate mount `name` or `containerPath` |
| `CONTAINER_MOUNT_NOT_FOUND` | 404 | No mount with that `name` in config |
| `CONTAINER_MOUNT_TYPE_MISMATCH` | 422 | Operation does not match mount `type` |
| `CONTAINER_ZIP_INVALID` | 422 | Zip archive missing or corrupt |
| `CONTAINER_ZIP_UNSAFE` | 422 | Zip path escapes target directory |
| `CONTAINER_MOUNT_SOURCE_MISSING` | 422 | Backing path missing when reading mount file content in the editor, or Storage-sourced mount references a deleted `settings.mounts` entry |
| `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED` | 503 | Storage-sourced mount's referenced share/drive is not currently mounted on the host |
| `CONTAINER_MOUNT_SOURCE_UNSAFE` | 422 | Storage-sourced path resolves outside its storage root (symlink escape) |
| `CONTAINER_MOUNT_FILE_TOO_LARGE` | 422 | Mount file exceeds 512 KiB (editor GET/PUT) |
| `CONTAINER_MOUNT_FILE_NOT_UTF8` | 422 | Mount file is not valid UTF-8 (editor GET) |
| `CONTAINER_MOUNT_SECRET` | 403 | Content GET on a secret file mount — write-only for every caller (see [Secret file mounts](#secret-file-mounts)) |
| `APP_CONFIG_ONLY` | 422 | Content PUT, file upload, or row `PATCH` on a mount owned by the container's app module (see [CUSTOM-APPS.md](CUSTOM-APPS.md) § Mount content routes) |
| `BAD_MULTIPART_TOO_MANY_FILES` | 400 | More than one file part in a mount upload request |
| `CONTAINER_MOUNT_SOURCE_WRONG_TYPE` | 422 | Backing path is not a file/directory as required |
| `INVALID_CONTAINER_DEVICES` | 422 | `devices` array invalid (shape, unknown type, bad path, > 1 entry) |
| `CONTAINER_DEVICE_MISSING` | 503 | Configured host device path does not exist or is not a character device at start |
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
| `ContainerMountsSection` | `sections/` | **Mounts**: table (bridges-style); type icon column; container path (wider column) and mount name; read-only; per-row Save (PATCH full list), icon upload (file/zip) with optional multipart **`mounts`** for atomic save+upload, file editor modal; secret file mounts show `secret · set / not set` and open `SecretMountContentModal` instead of the editor |
| `MountFileEditorModal` | `sections/` | UTF-8 text editor for non-secret file-mount backing content (GET/PUT content API) |
| `SecretMountContentModal` | `sections/` | Write-only replace / clear for a secret file mount (PUT content only — never fetches content) |
| `ContainerNetworkSection` | `sections/` | Network type, interface, IP, MAC (editable when stopped + randomize), status |
| `ContainerDevicesSection` | `sections/` | Host device passthrough (currently GPU only). Picker populated from `GET /api/host/gpus`; one entry max in v1. PATCHes `devices` on Save. Disabled empty state when host has no supported GPUs. |
| `ContainerLogsSection` | `sections/` | Live-scrolling log viewer for one **run** at a time. Top bar has a **run picker** (newest first; green dot = running, red = non-zero exit, gray = clean exit), a filter input, and icon-only actions: **Clear** viewer (client-side only — does not touch files), **Mark** (inserts a divider line with an optional label), **Download** (streams the selected run's log file), **Auto-scroll**. SSE via `/logs?runId=…`; run list via `GET /runs` and refetched when the container's state transitions. |

### UI Integration

- Left panel shows unified list (VMs + containers) with type filter: All | VMs | Containers
- Containers use a Box icon (distinct from VM monitor icons)
- Container list items show the image name as subtitle
- State colors consistent with VMs (green=running, gray=stopped)
- "container" badge shown in the overview header
