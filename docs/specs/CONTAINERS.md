# Container Management

Wisp supports running OCI containers alongside VMs using containerd as the runtime. Containers appear in the same unified list as VMs, with filtering options.

## Architecture

Containers follow the same patterns as VMs: a platform facade over a Linux implementation (and a macOS stub), gRPC to containerd where VMs use DBus to libvirt, a store of their own and live data on the client, and routes that mirror the VM routes. Only the Linux implementation imports `@grpc/grpc-js`. The system's shape: `docs/ARCHITECTURE.md`.

## Ephemeral rootfs

The writable rootfs layer of a Wisp container is **ephemeral**. On every start the existing rootfs snapshot is removed and prepared again from the current library image before the task is created. Anything a container needs to persist across restarts must be stored under a Local mount (`files/<mountName>` in the container directory), a Storage-sourced mount, or a tmpfs mount (which is itself ephemeral but kernel-managed).

Consequences:

- **Image updates** are picked up automatically on next start. The container always boots from whatever the library currently holds for its image reference.
- **Package installs and `/etc` edits** done inside a running container do **not** survive a stop. Tools that customize a system after first boot must run as part of the image build, an entrypoint script reading mounted config, or an app's `appConfig`/derived mounts.
- **Identity changes** (e.g. **rename**) do not need to preserve any rootfs state — the snapshot under the old key is dropped at rename time and the next start re-prepares one under the new key.

## containerd Connection

- Socket: `/run/containerd/containerd.sock` (override: `WISP_CONTAINERD_SOCK`)
- Namespace: `wisp` (set via gRPC metadata header `containerd-namespace: wisp`)
- Required version: containerd 2.0+
- The vendored proto files' **field numbers must match the installed containerd**: a definition from another major version decodes mounts wrongly and task create fails.

## Name validation

A container name is checked by one schema ([ERROR-HANDLING.md → Name validation](ERROR-HANDLING.md#name-validation)) wherever one arrives: every `/api/containers/:name/*` path, a create's or a rename's body, a container backup's and restore's names, the console WebSocket and the MCP tools' `name` argument. It requires:

- length 1–63
- a leading letter or digit, then letters, digits, `.`, `_`, `-`
- no `..`, `/` or `\`; used as sent, never trimmed

A name that breaks it answers **400** `VALIDATION_FAILED` (settled 2026-11-20: a schema-shape refusal, no longer 422). The container manager checks a name it is given again (**422** `INVALID_CONTAINER_NAME`), with a copy of the rule of its own, for callers that reach it without the schema: every path it builds from a name is guarded against traversal, and the manager imports no Wisp glue.

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

**Owner-only (settled 2026-10-16).** The container directory is `0700` and `container.json` is `0600`: it holds secret env values in plaintext. Every `container.json` write applies the mode, and a restore (as new and in place) sets the restored container directory to `0700` whatever mode the archive recorded. Nothing but the backend reads this directory; the container's process only ever sees its mount points. What is inside `files/` keeps its own modes (the container reads and writes there).

**One read, atomic writes (settled 2026-11-22).** Every reader of `container.json` (the list, start, exec, mount content, autostart, restore, boot cleanup) goes through one read: a missing file is `CONTAINER_NOT_FOUND`, one that cannot be read `INTERNAL_ERROR`, anything that is not a JSON object `PARSE_ERROR`, so a broken file is reported as broken, not as "not found". Writes are atomic (temp file, fsync, rename), with the temp-file suffix the boot cleanup looks for. Nothing outside containerManager writes the file except through the manager's exports.

**Per-run log files.** Every start that creates a new task allocates a fresh **runId** — a filesystem-safe ISO-8601 timestamp (`2026-04-18T12-34-56-789Z`, colons and dots replaced with hyphens). The task's `stdout` and `stderr` both go to `runs/<runId>.log`, which the containerd shim opens and writes.

Alongside each log file, the backend writes a JSON sidecar with run metadata:

| Field | Type | Description |
|-------|------|-------------|
| `runId` | string | Matches the filename stem. |
| `startedAt` | string | ISO 8601 time the run was allocated (immediately before the task is created). |
| `endedAt` | string \| null | ISO 8601 time the task exited. Null while the run is active. |
| `exitCode` | number \| null | Process exit status. Null while the run is active, or when the exit code is unavailable. |
| `imageDigest` | string \| null | Library image digest the container was running at the time of the run, if known. |

**Live log stream** *(settled 2026-10-16)*. The logs SSE (`GET /api/containers/:name/logs`) delivers every line of the run exactly once, in order: the history is the last 500 **complete** lines, and the tail continues from exactly where the history ended — no gap between history and tail, no line in both. A write that ends mid-line (or mid UTF-8 sequence) is held until its newline lands. A trailing line without a newline is delivered once the run has ended (sidecar `endedAt` set), or when it exceeds 64 KiB. The run-log history (MCP `get_container_logs`) returns the last N segments including a trailing partial line, and reads only the file's tail: it never loads a whole run log.

**Retention.** The newest **10** runs are kept; older log+sidecar pairs are pruned on every new-run allocation. No separate GC job. Container delete removes the whole container directory, including all runs.

**Finding the current run.** The active run is the one whose sidecar has `endedAt === null`; the "current" run is not tracked in memory, so a container mid-run looks identical across backend restarts. A stop, a kill, or a start that finds a stale task writes `endedAt` and `exitCode` together. A task that exits on its own is finalized on its `/tasks/exit` event, with the event's exit status *(settled 2026-11-12)* — unless the container already runs a newer task, so a late event never ends the newer run. That finalize takes the [operation lock](#per-container-operation-lock); a container another operation holds is left to it. Already-finalized sidecars are not rewritten.

### container.json Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | (required) | Container name (alphanumeric, 1-63 chars) |
| `uuid` | string | (auto) | Stable identity, a random UUID: made at create and when a backup is restored as a new container, kept by a rename and by a restore in place. Clients follow a rename by it, as they follow a VM by its libvirt UUID (settled 2026-11-16). Server-managed: not writable via PATCH. |
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
| `pendingRestart` | `{ since }` \| omitted | omitted | Restart-required flag: `since` is the ISO time a change the running process can't pick up live was saved — a change to a restart-relevant field while running, or an `appConfig` change the app cannot live-reload. See [Config changes that need a restart](#config-changes-that-need-a-restart). Dropped once the task is seen to have started after `since`. Server-managed: not writable via PATCH. (Image-version drift is surfaced via the derived `updateAvailable` field on API responses; it's not persisted.) |
| `imageDigest` | string \| omitted | omitted | Server-managed: top-level manifest/index digest (`sha256:…`) of the library image the container's rootfs was last built from. Written at **create** and refreshed on every start when the library digest has changed. Used by the image update checker to detect drift. Not writable via PATCH. |
| `imagePulledAt` | string \| omitted | omitted | Server-managed: ISO 8601 timestamp of the last `imageDigest` change (i.e. when the container last adopted a new image). Not writable via PATCH. |
| `scheduledRestart` | object \| null (derived) | null | Not stored on disk — on list and detail responses. `{ attempt, at }` while the restart policy has a restart scheduled for this stopped container (`attempt` counts restarts in the current crash loop, `at` is the epoch-ms time the backoff timer fires), else `null`. See [Restart policy](#restart-policy). |
| `updateAvailable` | boolean (derived) | omitted | Not stored on disk — derived at read time when the list/detail endpoints build their response. `true` when the container's task is RUNNING or PAUSED **and** its stored `imageDigest` no longer matches the library's current digest for `image`. Stopped containers always read as `false`; they adopt the new digest automatically on next start. Not writable via PATCH. |

### Command override

`command` is the process argv, stored exactly as sent; `null` (or an empty array) runs the image's entrypoint + cmd. It is edited as **one line of shell-style quoting** *(settled 2026-10-16)*: the stored argv is shown with each argument quoted only when needed (`sh -c 'sleep 5 && echo hi'`), and the typed line is split back with the same rules — whitespace separates arguments, `'…'` is literal, `"…"` honours `\"` `\\` `\$` `` \` `` only, `$'…'` takes ANSI-C escapes (`\n`, `\t`, `\xHH`, …; the formatter uses it for arguments holding newlines or control characters), and `\` escapes one character outside quotes. Formatting then parsing returns every argv unchanged, so a command set through the API survives a UI edit, and a re-quoted line with the same argv is not re-sent. Only the quoting is shell-like — no shell runs, so `$VAR`, globs, `|`, `&&` are literal characters (use `sh -c '…'`). An unterminated quote or a trailing backslash fails the save with an error; blank saves `null`.

### `network` object

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `bridge` — container is attached as a veth port on a host Linux bridge (LAN DHCP). The only value: PATCH refuses any other, **400** `VALIDATION_FAILED` (its body's schema; *settled 2026-11-12*). |
| `interface` | string | Host Linux bridge used as the parent for the container's veth pair (e.g. `br0` or a VLAN sub-bridge `br0-vlan10`). Required at start; a setup-time probe rejects anything that is not an existing Linux bridge. At **create**, defaults to the first bridge whose name is not VLAN-style (`br0-vlanN` / `iface.VID`); if none, the first listed bridge. |
| `ip` | string \| omitted | Set by the backend after a successful CNI **ADD** (IPv4 with mask, e.g. `192.168.1.50/24`). Not writable via PATCH while the task is running (ignored in the merge). |
| `ip6` | string \| omitted | Set by the backend when the running container's netns holds a global-scope IPv6 (with prefix, e.g. `fdc0:…:ad5f/64`). Kernel SLAAC from the LAN's router advertisements — nothing in the CNI/DHCP layer requests IPv6; the address is observed from `/proc/<taskPid>/net/if_inet6` by the 60 s network probe (GUA preferred over ULA; link-local/tentative/deprecated/temporary skipped). Absent on LANs without an IPv6 prefix. Not user-writable. |
| `mac` | string | Required. Locally administered unicast format (`aa:bb:cc:dd:ee:ff`). Assigned at create (random if omitted), persisted in `container.json`, and passed to the CNI bridge plugin on each **ADD** so the DHCP client identity (and therefore the lease) stays stable across stop/start. User-editable via PATCH when the container is **not** running (`running` / `paused` / `pausing` block MAC or interface changes). |

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

**Host-path resolution:**
- Local: `<containersPath>/<name>/files/<mount.name>`
- Storage: `<settings.mounts[sourceId].mountPath>/<mount.subPath>`
- tmpfs: no host path (kernel-allocated)

**Replacing the list (`PATCH` `mounts`).** The manager never deletes mount data on its own (settled 2026-10-16), so no caller can lose data by rearranging a list: a Local mount that leaves the list — or stays under its name but now points at a Storage source *(settled 2026-11-12)* — keeps `files/<name>` and is reported back, and the caller deletes it explicitly (the delete refuses a name still configured as a Local mount). The generic `PATCH /api/containers/:name` route does exactly that, so for API callers dropping a Local mount from `mounts` still deletes its data — the same contract as `DELETE /mounts/:name`. App flows decide per mount ([CUSTOM-APPS.md](CUSTOM-APPS.md), Live Reload). An optional **`mountRenames`** object (`{ "<oldName>": "<newName>" }`, only alongside `mounts`) marks entries of the new list as renamed current mounts: a Local mount's `files/<old>` moves to `files/<new>` with its contents, like a row-scoped rename. Rules: `oldName` is a current mount; `newName` is in the new list, has the same type, and is not a current mount (swaps and chains take two saves); `files/<new>` must not already exist on disk (**422** `CONTAINER_MOUNT_DUPLICATE`). Violations → **422** `CONFIG_ERROR`. If a move or the config write fails, completed moves are reversed.

After **PATCH** persists **`mounts`**, or after **POST** `/api/containers/:name/mounts` adds one mount, the backend creates any **missing** backing artifact automatically (Local: empty file/directory under `files/<name>`; Storage: the sub-path inside the mounted storage root) so new rows are usable without a separate **Init** call.

**Pre-start checks** for Storage-sourced entries validate that:
- The referenced `settings.mounts[sourceId]` still exists (otherwise `CONTAINER_MOUNT_SOURCE_MISSING`).
- The storage mount is currently mounted (otherwise **503** `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED` — user mounts it in Host Mgmt → Storage and retries).
- `realpath(<mountPath>/<subPath>)` stays within `realpath(<mountPath>)` — symlink escapes are rejected with `CONTAINER_MOUNT_SOURCE_UNSAFE`. A missing sub-path is created one component at a time from the resolved root, each existing component checked first (a symlink is followed only when its target stays inside the root), so nothing is ever created outside the storage root.

**Re-check at task create (settled 2026-10-16).** The checks above run early in a start, before the network wait (fail fast). Immediately before the task is created every bind source — Local and Storage — is resolved again with `realpath` and re-checked against its root (and Storage's mounted state), and the OCI spec binds **that resolved path**, never the configured one. A symlink swapped into a sub-path during the DHCP wait therefore fails the start with `CONTAINER_MOUNT_SOURCE_UNSAFE` instead of being bound.

**Delete semantics:** removing a mount row or deleting the container itself leaves Storage-sourced sub-paths untouched (user data outside the container directory). Local backing files/directories are removed (row delete, generic `PATCH` dropping the row, container delete with files). **Rename** (row `PATCH` with a new `name`, or `mountRenames`) moves the Local backing store and refuses when `files/<newName>` already exists.

**Zip upload** (`POST /api/containers/:name/mounts/:mountName/zip`) is available for Local directory mounts only — Storage-sourced rows reject the call with `CONTAINER_MOUNT_TYPE_MISMATCH`. The archive's paths are listed and checked before anything is extracted.

### tmpfs mounts

`type: "tmpfs"` mounts are kernel-managed in-memory filesystems. They have no host backing — contents live only in RAM (subject to the `sizeMiB` cap) for the lifetime of the container task and are wiped on stop/restart. Use them for paths that don't need to survive a restart and shouldn't write through to disk: per-session caches, runtime state directories like Samba's `/var/lib/samba`, lock/socket scratch space.

A tmpfs is mounted `nosuid,nodev,mode=1777` with its size cap, so any in-container UID can write, as in `/tmp`.

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

**Mutation surface:** services are managed exclusively via the row-scoped endpoints (`POST` / `PATCH` / `DELETE` `/api/containers/:name/services[/:port]`); sending `services` to **PATCH** `/api/containers/:name` returns **422** `CONFIG_ERROR`.

**Lifecycle:** services persist in `container.json` independent of run state. Live publication tracks the address registration:
- **Container start:** once the task has started (and the IP is known), every entry in `services[]` is published against the container's `<name>.local` host — read from the latest `container.json`, so a `localDns` switched off during the start publishes nothing. A start that fails after network setup publishes nothing and deregisters any services left under the name. A registration failure after the task started is logged; the start still succeeds.
- **Container stop / kill / delete:** every published service for the container is deregistered before the address itself is freed.
- **Task exits on its own** (crash, `kill -9`, the process ending): on its `/tasks/exit` event every published service is deregistered, unless the container already runs a newer task — without waiting on avahi, so the restart policy is never held up by it; a restart by the restart policy registers them again with its start. A deregister frees only the records it found, never one a concurrent register put under the same key. A task that dies while its own start is still registering its services (a crash loop) is caught by that start: it re-checks the task afterwards and drops the services if the task is gone.
- **`localDns` toggled off:** all services are deregistered alongside the address.
- **`localDns` toggled on (running):** the address is republished and every entry in `services[]` is registered.
- **Per-row mutation while running:** applied live (no task restart). An update is a deregister and a register.

Service publication is best-effort: if Avahi is unavailable, services are kept in memory and registered the next time avahi-daemon appears, as address registrations are ([Publishing](#publishing-avahi-daemon-via-dbus)).

### Idmapped Local mounts

When `runAsRoot` is true on a container, every **Local** directory/file bind mount carries a per-mount idmap that translates a single in-container UID/GID pair to the host deploy UID/GID. This makes files created inside the container land on the host with ownership the backend can read/delete without `sudo`. Storage-sourced mounts never get an idmap (CIFS/SMB/NFS support is inconsistent and the data lives outside the container directory anyway).

**Mapping shape**: for each Local mount under `runAsRoot`, the mapping is attached **unconditionally** — there is no no-op short-circuit, even when `containerOwnerUid === deployUid`, so the contract is the same for every mount: exactly one in-container UID/GID writes through it cleanly.

```js
uidMappings: [{ containerID: deployUid, hostID: containerOwnerUid, size: 1 }]
gidMappings: [{ containerID: deployGid, hostID: containerOwnerGid, size: 1 }]
```

> ⚠ **Field-name gotcha:** the OCI runtime spec for `mounts[].uidMappings` uses the *opposite* convention from `linux.uidMappings` (full user namespaces). For mount idmaps, **`containerID` = UID on the source file system (on-disk)** and **`hostID` = UID at the destination mount point (what the container sees)**. Getting this backwards makes bind-source files read as `nobody:nogroup` and the container's writes fail with `EOVERFLOW`.

**Implications of size:1 (one container UID translates, others don't):**
- *Reads* of files owned by other (unmapped) UIDs through the idmapped mount appear as `overflowuid`/`overflowgid` (typically `65534`, `nobody:nogroup`).
- *Writes* by other in-container UIDs **fail at the syscall** with `EOVERFLOW` (`"Value too large for defined data type"`); the file is not created on disk at all. This *is* the contract — exactly the configured in-container UID/GID may write through this mount.
- Each Local mount is assumed to be written by one container UID. If the container needs to write as both root and a worker UID to the same path, split into two mounts (each with its own owner UID).

**Runtime requirements**: idmapped mounts require **runc ≥ 1.2.0** and a recent kernel (≥ 5.19 in practice); every containerd setup accepts brings such a runc. With an older runc, container task creation fails with an OCI spec error.

**Idmap is an on-disk ownership shift, not a security boundary.** The container process still runs as real host UID 0 with all capabilities (no user namespace is added). Only the inode ownership stored on the bind source is translated.

### Devices entry

Host device passthrough for containers. Unlike VM PCI passthrough (VFIO), the host kernel driver still owns the device — the container only gets the existing character-device node, so host and container share the device through the host's driver.

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"gpu"` — Intel/AMD render node (`/dev/dri/renderD<N>`). NVIDIA is **not supported** in v1 (would require nvidia-container-toolkit + CDI). |
| `device` | string | Absolute host path. For `type: "gpu"`, must match `/dev/dri/renderD\d+` (DRM render node, no master/auth required). `/dev/dri/card<N>` is **not** accepted. |

**Validation rules:**
- `devices` must be an array.
- v1: at most **one** entry.
- Each entry's `type` must be `"gpu"` (other types are rejected with `INVALID_CONTAINER_DEVICES`).
- For `type: "gpu"`, `device` must match `^/dev/dri/renderD\d+$`. No symlink resolution — the literal path is what the container gets.
- Unknown keys are rejected.

**In the container:** the device node (`0660`, group: the host's `render` group), a device-cgroup rule allowing it (without the rule, cgroup v2 denies the open even though the node is visible), and membership of the host's `render` group (or `video`) for the process. The group's GID is looked up at every start, never cached: distros differ.

**Pre-start check:**
- A `gpu` entry's `device` must still match `^/dev/dri/renderD\d+$` — re-checked here, not only at PATCH/create, because `container.json` can also arrive from a backup archive. Otherwise start fails with `INVALID_CONTAINER_DEVICES` (422).
- The configured `device` path must exist and be a character device. If missing (driver glitch, hardware change, hot-removal), start hard-fails with `CONTAINER_DEVICE_MISSING` (503). The container is not auto-cleared of its `gpu` entry: the failed start makes a lost GPU visible to a user who set up hardware acceleration.

**Concurrency:** DRM render nodes are designed for concurrent open by multiple processes. Multiple Wisp containers (and the host itself) can hold the same device simultaneously. No exclusivity bookkeeping in Wisp.

**Restart required:** any change to `devices` requires a task restart — see [Config changes that need a restart](#config-changes-that-need-a-restart).

**Detection (host side):** `GET /api/host/gpus` lists the host's Intel and AMD render nodes ([API-HOST.md](API-HOST.md)); NVIDIA is filtered out for v1. When multiple GPUs are present, the user picks one — Wisp does not auto-select beyond what the picker offers.

### Secret env vars

Individual env vars can be marked `secret: true` to hide their values from the UI. Secret values are persisted in `container.json` like any other env var (the OCI process needs them at runtime), but:

- **`GET /api/containers/:name`** strips the value and returns `{ value: null, secret: true, isSet: boolean }` for every secret entry. `isSet` is `true` when a value is stored on disk.
- **`PATCH /api/containers/:name`** only accepts env-var changes through the **`envPatch`** delta (a plain `env` field is rejected with `CONFIG_ERROR`). See [API-CONTAINERS.md](API-CONTAINERS.md) for the delta shape.
- Flipping a key from `secret: true` to `secret: false` without providing a new value clears the stored value server-side: the UI never received the old value, so there is nothing to preserve. The UI warns the user before flipping the toggle.
- Creating a brand-new secret key without a `value` is rejected with `CONFIG_ERROR` (`Secret env var "X" requires a value`).

A container backup restores the env shape it holds: backups are outside the state migrations' reach, and container backups exist only since 2026-05-02, after both shape changes (settled 2026-11-12).

### Secret file mounts

A file mount can be marked secret — the same model as secret env vars (settled 2026-10-16). The file is stored in plaintext under `files/<name>` (the container reads it), owner-only on the host (below), but:

- **Content is write-only for every caller** — session or token, read or admin scope. `GET /api/containers/:name/mounts/:mountName/content` answers **403** `CONTAINER_MOUNT_SECRET`; `PUT …/content` and `POST …/file` work as for any file mount. The manager's own content read refuses a stored `secret: true`, so no internal caller can read one back either.
- **Metadata only on output.** `GET /api/containers/:name` (and MCP `get_container`) returns secret file mounts with `secret: true`, `isSet` (the file is non-empty) and `sizeBytes` (`null` when no file is on disk). The mount-usage endpoint still reports its size.
- **Un-marking empties the file.** Turning `secret` off — row `PATCH` `{ secret: false }`, or a whole-list `PATCH` whose entry for that mount (by name, or as a `mountRenames` target) lacks the flag or changes type — truncates the file **before** the config is written, so dropping the flag can never make the content readable. Marking a mount secret keeps its content.
- **Host mode `0600`** (settled 2026-10-16). Every secret file mount's backing file — stored `secret: true` or app-declared — is mode `0600`; the container still reads it, as the deploy user that owns the file or, with `runAsRoot`, as root through the mount's idmap. A write sets the mode **before** the content, so the content never sits under a wider mode; marking a mount secret sets it right after the config write. **Un-marking** empties the file first, then gives it the mode of any new mount file. Plain mounts are untouched: an existing file keeps its mode across writes.
- **No restart for the flag.** `secret` is not part of the OCI spec, so a row `PATCH` that changes only `secret` sets no `pendingRestart`, even while running.
- **App containers** derive secrecy from their app module, read at request time from the stored appConfig — no stored flag; see [CUSTOM-APPS.md § Mount content routes](CUSTOM-APPS.md#mount-content-routes). The effective rule is "stored `secret: true` **or** declared by the app".
- **Backups** carry secret mount files like any other mount data (and like secret env values), owner-only — see [BACKUPS.md § Backup file modes](BACKUPS.md#backup-file-modes).

## Config changes that need a restart

`PATCH /api/containers/:name` always writes `container.json`; it never restarts the container. For a **running** container, changes to these fields do not reach the process until the next start — the process environment, mounts, devices, and resource limits are fixed when the task is created:

`image` · `command` · `cpuLimit` · `memoryLimitMiB` · `env` · `mounts` · `devices` · `network` · `runAsRoot`

The mount CRUD endpoints set the same flag. MAC/interface changes are the exception — rejected outright while running with `CONTAINER_MUST_BE_STOPPED` rather than deferred.

**One rule decides "changes"** (settled 2026-11-22): those fields are compared before and after the write — `mounts` and `devices` normalized, a mount's `secret` and the network's `ip`/`ip6` left out, `env` whatever its key order — and the flag is set iff the container is on (its task running or paused) and they differ. The config save, the mount rows and the start's settle all use the rule, so re-sending a current value flags nothing, whichever field it is. An app's save adds its own reasons, which are about reloading the running app, not about the config: it has no reload command, the reload failed, or the app's hook says so. A container that needs a restart is not reloaded at all: when the save changes the env, the mount layout or the devices, or the container is already flagged, the reload is skipped, because the running task lacks what the new files were written for, and a reload against it would fail a save that only needed a restart ([CUSTOM-APPS.md](CUSTOM-APPS.md), Live Reload; the MCP `update_app_config` tool runs the same path).

- `pendingRestart: { since: <now> }` is persisted in `container.json`; the restart badge follows it on the container record (the PATCH answers 204).
- The page shows "Restart to apply" in its header ([UI-CONTAINER.md](UI-CONTAINER.md)).

**The flag follows the same rule as a VM's** (settled 2026-10-16; [VM-MANAGEMENT.md → Restart-required flag](VM-MANAGEMENT.md#restart-required-flag)): a container needs a restart iff `pendingRestart` exists **and** its task's init process has not started since `since` (its start time read from `/proc`). A config read leaves out a flag the running task started after. Reads never write (`CODING-RULES.md` §16). **The start clears the flag** *(settled 2026-11-12)*: once the task has started, the start re-reads `container.json` and either sets a fresh flag — a restart-relevant field was saved after the spec was built — or drops a flag the new task started after (a flag set while the task was starting is newer than its start and stays). Every task start goes through there (UI, API, MCP, restart policy, autostart), so no sweep is needed. If Wisp dies between the task's start and that write, the stale flag stays: reported as not in force while the task runs, shown again once it stops, dropped by the next start. A stopped container, or one whose start time `/proc` can't tell, keeps its flag.

**Setting the flag from outside the config paths** (settled 2026-10-16). The manager exports a setter, `setContainerPendingRestart(name, value)`: `true` records `since = now` (a later change moves it forward), `false` or `null` removes it, a `{ since }` flag is written as given (restoring an earlier flag exactly, as the app-config rollback does); it answers `{ changed }`. It is for code that changes a container's state some other way and knows the running task needs a restart to pick it up: `containerApps` (app config that can't live-reload) and state migrations. `PATCH` ignores a `pendingRestart` key. VMs have the same setter.

## Lists and state

- **A list that could not be read is never an empty list** (settled 2026-11-22). The container list returns every container or throws (`NO_CONTAINERD`, an unreadable containers directory or `container.json`, a failed task lookup), and it tells its subscribers only when its answer changes, a list or an error.
- The list follows containerd's task and container events, every `container.json` write, every restart-policy schedule, cancel and fire, and the end of every image-update check. The events subscription reconnects by itself (1 s, doubling to 30 s). A stream error also marks the list stale, so the next read asks containerd and reports it down; the same reconnect picks up a containerd that was not running when Wisp started.
- Connected without event watching (the start's state migrations) there is no cache and no subscription: every list call reads disk and task state and returns real state or throws — [UPDATES.md → Runner](UPDATES.md#runner).
- **One "is it on"**: a container is on when its task is running or paused. One wait for a task to stop. One name check, for create, rename and restore as new.
- Uptime and the task's start time are read from `/proc`, so they survive a backend restart. The manager has its own reader, as vmManager has: each manager stays extractable.

## Interactive console (exec)

The container page's **Console** is a terminal on **`GET /ws/container-console/:name`** (close codes and client behaviour: [CONSOLE.md](CONSOLE.md) § Container console sessions).

- Requires the container **task** to be **running**.
- The shell is `/bin/sh` on a PTY, with `TERM=xterm-256color`, under the same **UID/GID** as the main container task (`runAsRoot` in `container.json` vs deploy user).
- **Binary** WebSocket frames carry the terminal's bytes; a **text** frame `{ type: "resize", cols, rows }` resizes the PTY. When the shell exits the backend closes the WebSocket with **`1000` `session ended`**.
- The session's named pipes live under **`${containersPath}/.exec-sessions/`**, not `os.tmpdir()`: systemd **PrivateTmp** on the Wisp service would hide them from containerd.
- The backend opens **its ends of the pipes before the exec is started**: the shim opens the other ends with blocking opens during the start, so opening afterwards deadlocks until containerd times out.
- On WebSocket close (or a failed exec setup) nothing is left running: a shell still alive is killed and waited for (bounded at 5 s) before the exec is deleted — the shim refuses to delete a live exec, which would leave it behind — and the pipes and the session directory are removed. A WebSocket that closes while the exec is still being set up gets the same teardown as soon as setup finishes.
- **Exec FIFO I/O stays off the libuv threadpool** *(settled 2026-10-16)*. The pipe ends are non-blocking fds the event loop polls, not `fs` streams: their blocking opens and reads pin a pool thread for as long as a console sits idle, and four idle consoles stalled every file, DNS, crypto and zlib call in the backend.
- **A non-interactive exec** (an app's reload command) has one timeout for the whole run — process exit and both pipes drained. On expiry the process is killed and reaped; no exec process, open fd or session directory outlives the call on any path.

## OCI Runtime Spec

What a container runs with, built from `container.json` and the image config:

- Namespaces: pid, ipc, uts, mount, network, cgroup. The network namespace is joined by **`path: /var/run/netns/<name>`**, the one CNI configured (a bare `network` namespace would be a new empty one, without the veth).
- Capabilities: the standard container set (chown, net_bind, etc.)
- **Seccomp:** every task runs under **Docker's default seccomp profile** (settled 2026-10-16), so images that run under Docker run here. The profile is vendored unmodified from moby/profiles (tag `seccomp/v0.2.4`, Apache-2.0, with its notice) and converted to the OCI form as moby does, for the host's arch, kernel and the capability set above. Unlisted syscalls fail with `EPERM`; with no `CAP_SYS_ADMIN` that includes `mount`, `unshare`, `setns` and namespace-creating `clone` flags, `clone3` returns `ENOSYS`, and `AF_ALG` / `AF_VSOCK` sockets are refused. There is no per-container opt-out (backlog: *Per-container seccomp opt-out*).
- Default mounts: proc, dev, devpts, shm, mqueue, sysfs, cgroup, run
- **Process user:** the **backend process UID/GID** (the systemd deploy user) by default, so files created on bind mounts under `files/<name>/` remain owned by that user and the backend can delete them. When **`runAsRoot: true`** is set, UID/GID are 0 — required for images that write to root-owned directories inside the container — and each **Local** bind mount is idmapped ([Idmapped Local mounts](#idmapped-local-mounts)).
- User bind mounts: `rbind` (+ `ro` when `readonly`), from the source resolved right before task create ([Mount entry](#mount-entry)).
- **Host devices:** [Devices entry](#devices-entry).
- CPU quota/period from `cpuLimit`, memory limit from `memoryLimitMiB`
- `/etc/resolv.conf` is bind-mounted. On the primary bridge (not a VLAN sub-bridge — names matching `*.<n>` or `*-vlanN`) it is the shared `/var/lib/wisp/container-resolv.conf`, which names the DNS forwarder ([Local DNS](#local-dns-mdns)); on a VLAN sub-bridge it is the host's upstream resolvers (`/run/systemd/resolve/resolv.conf` on resolved hosts, else `/etc/resolv.conf`). **The decision is by bridge name, not by probing the bridge's addresses**: a probe would race a moment the stub address is missing, such as the network being re-applied, and fix the wrong resolver into the container's run.

## Networking

Containers are attached as **veth ports on a host Linux bridge** (`br0`, or a VLAN sub-bridge `br0-vlanN`) via the **CNI bridge plugin**, exactly the same topology libvirt uses for VM NICs. Each container gets its own MAC, its own DHCP-assigned LAN IP, and **is reachable from the host**, because the host already has an IP on the same bridge.

- **No Docker-style `-p` publish:** The container is on the LAN like a small VM. If nginx listens on port 80 inside the image, browse to `http://<container-ip>/` from any machine on the same LAN — including the Wisp host itself. Firewall rules on the host or image still apply. `exposedPorts` (the image's `EXPOSE` directives) are informational.
- **Stable MAC:** Wisp assigns a locally administered MAC at create time, persists it in `container.json`, and passes it to `wisp-cni` on every **ADD**, which hands it to the CNI bridge plugin. `cni-dhcp` identifies a container to the DHCP server by its name, the network's and the interface's, so a container keeps the same IP across stop/start.
- **Interface selection:** `network.interface` must be an existing Linux bridge (`br0`, `br0-vlan10`, etc.), and an interface name by its shape (letters, digits, `.`, `_`, `-`, at most 15 characters): anything else is refused when it is saved (400 `VALIDATION_FAILED`; settled 2026-11-22). A stored value of another shape still reads, and is refused at the next start. Interface changes require the container to be stopped. For a VLAN-specific container, create a managed VLAN bridge (e.g. `br0-vlan10`) in Host Mgmt and point the container at it.
- **Host ↔ container reachability:** Free on the untagged bridge — no `promiscMode`, no extra routing. Host reachability **on VLAN sub-bridges** is a host-config concern (the host needs an IP on that sub-bridge); Wisp itself does not configure it.
- **The bridge is checked before every CNI ADD:** `/sys/class/net/<iface>/bridge` must exist. Without the check the bridge plugin would silently create an orphan bridge under the given name.
- **One source per address step** (settled 2026-11-22): at start the address is the CNI **ADD** result's (the dhcp plugin asks the `cni-dhcp` daemon, which returns the lease or fails the ADD) and is stored as `network.ip`; the 60 s network probe reads **`/proc/<pid>/net/fib_trie`** (no sudo, no exec), which follows a later change. `GET /api/containers/:name` reads `container.json` and probes nothing (settled 2026-11-12).
- **One way per network step** (settled 2026-11-22). Setup writes the helpers (`wisp-netns`, `wisp-cni`), the CNI plugins and the containers' resolver file (`container-resolv.conf`) at every install and update. A start that finds one of them missing fails with `CONTAINER_NETWORK_SETUP_FAILED`, naming the file and "run setup" (a create and a restore-as-new on the primary bridge need the resolver file too, since they build the same spec, and fail the same way, leaving nothing behind); a CNI ADD that answers something that is not JSON fails the same way. There is no fallback: no built-in network config, no upstream resolvers in place of the resolver file, no direct plugin or `ip netns` call.
- The CNI plugins are in `/opt/cni/bin/`, installed by setup ([DEPLOYMENT.md](DEPLOYMENT.md)).
- **The network config is `wisp-cni`'s** (settled 2026-11-22): the helper builds it for each call from the container's name, its bridge and its MAC, with fixed settings: `type: bridge`, `isGateway: false`, `ipMasq: false`, `hairpinMode: false`, `promiscMode: false`, `forceAddress: false`, `ipam.type: dhcp`, under the network name `wisp-bridge` (which the DHCP daemon's leases are keyed by, so a container started by an older build is released by this one). No file on the host holds it: setup removes the `/etc/cni/net.d/10-wisp-bridge.conflist` an earlier release wrote, and nothing else reads that folder (containerd's CRI plugin, the only other reader, is off).
- DHCP IPAM via `cni-dhcp.service` systemd unit (plugin-agnostic; the lease is keyed on the container's name, the network's and the interface's)
- Network namespace per container at `/var/run/netns/<name>`
- CNI plugins are invoked via the **`wisp-cni`** privileged helper: `add <container> <bridge> <mac>` and `del <container> <bridge>`. The namespace is always the container's own, the plugin always `bridge` from `/opt/cni/bin`, so no caller can name another namespace, plugin or config ([DEPLOYMENT.md → The helpers](DEPLOYMENT.md#the-helpers)).
- Before **ADD**, if the netns already exists, a **CNI DEL** runs and the netns is deleted (`wisp-netns delete`), so a leftover **`eth0`** from a failed stop does not cause `ADD` to error on "device exists".
- **Network setup failure aborts the start.** If network setup fails (missing bridge, CNI plugin failure, DHCP lease timeout, stale netns that won't release, etc.), the start tears down partial state (CNI DEL + netns + snapshot) and fails with `CONTAINER_NETWORK_SETUP_FAILED` (HTTP 503) — the task is never created, so the user sees the action fail instead of getting a "running" container with no reachable service.

## Local DNS (mDNS)

Two independent pieces. **Publishing** advertises a container as `<name>.local` on the LAN so peers can find it. **Resolution** lets an app *inside* the container query `foo.local`.

### Publishing (avahi-daemon via DBus)

- Controlled by **`localDns`** in `container.json`
- Name source: container name, sanitized to a DNS label (lowercase alnum + `-`, max 63 chars)
- Address source: `network.ip` (A record) plus `network.ip6` when present (AAAA record), CIDR masks stripped before registration; both families ride one Avahi entry group per container.
- **The AAAA is published** (settled 2026-08-17): dual-stack resolvers (macOS `getaddrinfo`) query A and AAAA together, and an unanswered family stalls the lookup for the client's full timeout. Clients with both records still connect over IPv4, so v4-only listeners inside containers are unaffected.
- **Only a running container with `localDns: true` is published**: `container.json` keeps the last addresses after a stop, so they alone never get published (a rename of a stopped container publishes nothing; the next start does). The name is registered when the container's address is known or changes, and withdrawn when it stops, is killed, is deleted, leaves the bridge, or `localDns` is switched off. A `localDns` toggle, a rename (the old name withdrawn, the new one published) and a delete act through the container's follow-ups (settled 2026-11-20), so a REST command, an MCP tool and the scheduler reach them alike.
- **One operation at a time per container**, in arrival order: a "running" still being handled can never register after the "stopped" that followed it.
- The registered name reaches clients on the per-container stats stream (`mdnsHostname`, alongside `ip`): registration only happens once the container runs, so the config alone would never carry it.
- Best-effort behavior: if avahi-daemon is unavailable, container operations continue unchanged and mDNS is skipped
- **Bounded avahi calls** *(settled 2026-11-12)*: every avahi DBus call on the publishing path gives up after **5 s**. A timed-out register is logged, frees whatever group it made (also one whose answer arrives after the timeout) and leaves the entry unpublished. Nothing retries it by itself: the next register of that workload (an address change, a local DNS toggle, a restart) recreates the group, and everything is registered again only when the avahi-daemon process is replaced, not when a hung one recovers — see the backlog entry "A timed-out avahi registration is never retried". Discovery's browser and resolver creation, and the forwarder's host-name and address resolves, are bounded the same way (5 s).
- **Network probe + IP persistence:** on every list change and every **60 s**, each running container's live IPv4 and global IPv6 are read. If a live address differs from `network.ip` / `network.ip6` in `container.json`, the config is **written first**, then the change is announced, so the published records follow a DHCP renewal or a SLAAC change and no reader sees a stale address.
- **Avahi restart recovery:** when avahi-daemon disappears (package upgrade, manual restart) the registrations are kept, addresses **and** services, and when it reappears every one is added again. **A failed system bus** (the bus daemon restarted or died) is treated as avahi gone, and Wisp then **reopens the bus** by itself (settled 2026-11-22): it retries after 2 s, doubling to 30 s, one retry pending at a time, and the first reopen watches for avahi again and re-adds every stored registration.
- **Host name conflicts on address churn (settled 2026-10-23):** setup sets `publish-aaaa-on-ipv4=no` in `avahi-daemon.conf`, which keeps the host's AAAA records off IPv4. Without it avahi 0.8 renames the host to `<host>-2` when an address is withdrawn while it is still probing its host name ([avahi#117](https://github.com/avahi/avahi/issues/117)), and never goes back by itself. AAAA stays published over IPv6, and Wisp's own entry groups are unaffected. A host already renamed needs `systemctl restart avahi-daemon`. Wisp does not configure guests: a VM running avahi needs the same line in its own `avahi-daemon.conf`.
- **Stuck-probe recovery (settled 2026-10-16):** avahi 0.8 leaves an entry group `REGISTERING` for ever, announcing nothing, when an interface the group is still probing on goes away. Wisp removes such interfaces itself, so after each removal of its own it resets, refills and commits again every group still `REGISTERING`. The triggers: a container's netns deleted (the stale netns a start clears, teardown on delete or failed start, rename's cleanup), and a VM stopped, whose tap is an interface a container's group may be probing on (settled 2026-11-20: the trigger stayed when VM name publishing went). Covers every group Wisp commits — container address records, container SRV/TXT services, the `_wisp._tcp` announcement. `COLLISION` / `FAILURE` are logged, not recovered. **Not covered:** interfaces removed outside Wisp (a manual `ip link del`, a NIC or Wi-Fi link dropping, another tool's veth/tap, the network being re-applied; see `docs/BACKLOG.md`) — a group probing on one of those stays stuck until it is registered again (`localDns` toggle, container restart, wisp restart).
- **Service advertisements:** `services[]` entries publish SRV+TXT against `<name>.local`, each service on its own, so one can be removed without disturbing the address record or the others. The instance name is the container name (Avahi resolves a duplicate on the LAN). See [Service entry](#service-entry)

### Resolution (in-process DNS forwarder on 169.254.53.53)

Container apps that `getaddrinfo("foo.local")` need a resolver that speaks mDNS. Wisp runs a small **DNS forwarder inside the wisp process** that containers query via unicast DNS. The forwarder answers Wisp-published workloads and the host's own name itself, translates other `.local` queries into avahi DBus calls, and relays everything else to the host's upstream DNS. Not systemd-resolved as the stub: its mDNS and avahi-daemon both want UDP 5353 and conflict.

- The stub address is link-local **`169.254.53.53/32`** on the dummy interface `wisp-dns0`, **never on `br0`**: an address on the bridge is flushed or raced whenever the network is re-applied, which stopped all container DNS or renamed the host. `/var/lib/wisp/container-resolv.conf` holds a single `nameserver 169.254.53.53` line.
- The forwarder binds **UDP + TCP port 53** on `169.254.53.53`, which needs `CAP_NET_BIND_SERVICE`: `wisp.service` grants it with `AmbientCapabilities=CAP_NET_BIND_SERVICE` (the service otherwise runs unprivileged as the deploy user).
- A container on the primary bridge gets the shared `container-resolv.conf` as its `/etc/resolv.conf` ([OCI Runtime Spec](#oci-runtime-spec)).
- After CNI ADD on the primary bridge, `169.254.53.53/32 dev eth0` is installed inside the container's netns (`wisp-netns route-add`). Without this on-link /32, the container's kernel would send DNS to the LAN gateway and queries would black-hole; with it the container ARPs on the bridge segment and the host answers.
- Containers on VLAN sub-bridges (`br0-vlan10`, `eth0.100`, …) fall back to the host's upstream resolvers and get no `.local` resolution — Linux bridges switch, they don't route, so the stub IP is unreachable from a sub-bridge segment
- **Declared through netplan** (settled 2026-11-20): `wisp-dns0` is a dummy device in a netplan file of Wisp's own, `/etc/netplan/90-wisp-dns0.yaml` (`dummy-devices`, `addresses: [169.254.53.53/32]`, `link-local: []`, `accept-ra: false`, `renderer: networkd` on the definition itself). It exists at every boot before `wisp.service` starts, with nothing of Wisp's creating it, and setup checks it on every install and update ([DEPLOYMENT.md](DEPLOYMENT.md), Setup). A `netplan apply` can drop the stub's address for a few seconds; the bridge step waits for it ([DEPLOYMENT.md](DEPLOYMENT.md), The bridge).
- **Part of the network being online (settled 2026-11-18).** The backend binds the stub address when it starts, and `wisp.service` is ordered `After=network-online.target`. The definition is not optional, so netplan's wait-online waits for it. A forwarder that still cannot bind fails the start (`DNS_FORWARDER_UNAVAILABLE`, naming the cause) and systemd starts the backend again with the unit's backoff.
- avahi needs no configuration: it announces address records only on the interface holding them, and `wisp-dns0` has no peers.

**Forwarder dispatch logic:**

| Query | Handling |
|---|---|
| `*.local` forward (A / AAAA) — Wisp container | Names published by this Wisp instance (its containers') answer from in-memory state (per-family: A from `ip4`, AAAA from `ip6`, empty NOERROR for a family that isn't published — no avahi round-trip, no multicast wait) |
| `*.local` forward (A / AAAA) — the host's own name | avahi's current host name (e.g. `wisp.local`) answers from the addresses on the containers' bridge, read at query time: every IPv4 except link-local, and global/ULA IPv6 only. One answer record per address; NOERROR with no answer for a family the bridge has no usable address in. No avahi round-trip. See *Host's own name* below |
| `*.local` forward (A / AAAA) — anything else | avahi's host-name resolve over DBus (capped at 1.5 s → NOERROR, no answer), which serves LAN peers via multicast query — a VM's name among them, which its guest announces (Wisp publishes none; [VM-MANAGEMENT.md → Local DNS](VM-MANAGEMENT.md#local-dns-mdns)). Same-host lookups work because the DBus call bypasses multicast entirely. A **link-local** result (`169.254.0.0/16`, `fe80::/10`) is dropped → NOERROR, no answer |
| `*.in-addr.arpa` / `*.ip6.arpa` (PTR) | avahi's address resolve over DBus. Falls through to upstream on miss so real reverse zones still resolve |
| Everything else | Raw relay to the first IPv4 `nameserver` from `/etc/resolv.conf` (on systemd-resolved hosts, that is `127.0.0.53` — resolved handles real forwarding), **over the transport the query arrived on**: UDP queries over a `connect()`ed UDP socket (the kernel drops datagrams from any other source, so a stray or spoofed packet to the ephemeral port can't be taken as the answer), TCP queries over TCP (they are usually a retry after a truncated UDP answer — relaying them over UDP would just truncate again). 5 s; SERVFAIL on timeout, refusal or reset |

The forwarder answers A, AAAA and PTR only. It never blocks the node event loop: avahi DBus calls and upstream relays are async, with bounded timeouts.

**Host's own name (settled 2026-10-16).** Containers resolve the host's `.local` name directly in the forwarder, never through avahi, whose path stalled for it:

- **Name:** avahi's, not `os.hostname()` — read at connect, on every change of avahi's state (which includes its automatic `<host>-2` rename on a LAN conflict) and when avahi reappears on the bus. Following the rename keeps containers on the name avahi actually publishes; the old name then belongs to whoever won the conflict and takes the avahi path like any LAN peer. While avahi is away the last known name is kept. Until the first read lands (avahi absent at boot) the name takes the avahi path.
- **Addresses:** the bridge new containers attach to (`WISP_DEFAULT_BRIDGE` or the first non-VLAN bridge, normally `br0`), fixed at boot; a bridge created later is picked up on the next wisp restart. Other uplinks (a second NIC, `wg0`, `virbr0`) are deliberately left out — they may not be reachable from the container segment. Link-local is never answered.

## Image Management

- **Reference normalization follows Docker's rule**: the first path component is a registry host only when it contains `.` or `:`, is `localhost`, or has an uppercase letter — so `nas:5000/app` and `localhost/app` stay as written; anything else is on Docker Hub (`user/app` → `docker.io/user/app`), a single-component Hub repo gets `library/` (`caddy:2` → `docker.io/library/caddy:2`), and `index.docker.io` becomes `docker.io`. No tag is added.
- **Delete is by exact name:** the image library deletes the name containerd lists, never a normalized form — `myapp:v1` deletes that local image, not a `docker.io/library/myapp:v1` twin. The in-use check matches a container whose `image` is that name verbatim or normalizes to it: the delete is blocked while one does, and refused when that cannot be told.
- **Local-image shortcut:** before normalization + pull, a create asks containerd for the exact literal ref. If it already exists (for example an image loaded with `ctr -n wisp image import foo.tar`, or one picked verbatim from the image library), it is used as-is — no normalization, no pull — and the create's progress carries a `using-local` step instead of `pulling`. This is what lets locally built images such as `myapp:v1` or `localhost/myapp:dev` work. Registry-named refs (`nginx:latest` and friends) still go through the normalize + pull path unchanged.
- **One stored form, every writer** *(settled 2026-10-16)*: create, `PATCH image` and MCP `update_container_image` store the ref through the same rule: the exact literal name when containerd holds one, else the normalized ref — the name a pull stores the image under. A short ref already on disk starts too (re-pulling each start until it is re-saved — any `PATCH image` stores it normalized). A blank `image` in a PATCH answers **422** `INVALID_CONTAINER_IMAGE_REF`.
- Multi-platform images (OCI index / Docker manifest list) are resolved to **Linux + host architecture**. There is **no** fallback to the first index entry (registry order may list Windows or other OS first). If no matching Linux manifest exists for the host arch, image resolution fails with a clear error listing available platforms.
- A pull downloads and unpacks the host platform's layers only (`linux/<arch>`); without that filter containerd downloads every listed platform.
- An image's size is the sum of its compressed config and layers, from the resolved Linux manifest (not the top-level manifest's size).
- Images are stored in containerd's content store, not in Wisp's filesystem
- **Uploaded images.** An image archive sent to Wisp ([API-CONTAINERS.md](API-CONTAINERS.md#post-apicontainersimagesupload--agent)) is imported into containerd, so an image built elsewhere runs here with no registry.
  - **The archive** is the tar `docker save` or `podman save` writes. It is staged in the containers path and removed when the import ends, however it ends; one a crash left is removed at the next start.
  - **The name:** an uploaded image is stored under `localhost/`, the name the archive carries with its registry host replaced: `myapp:v1` → `localhost/myapp:v1`, `ghcr.io/me/app:2` → `localhost/me/app:2`, Docker Hub's `nginx:latest` → `localhost/nginx:latest`. A name already under `localhost/` (what podman gives a local build) is kept. An archive of several images imports each. An archive that names no image is refused. The import creates or changes no image under another name.
  - **The platform:** an archive with no image for the host (`linux/<arch>`) is refused, and nothing of it is kept.
  - **`localhost/` is this host's own, and is never pulled.** A ref whose registry host is `localhost` names an image that came from no registry. Wherever Wisp would pull a ref (a create, an image change, a start that finds no image, the update check, MCP `update_container_image`), it uses the image containerd holds by that name, and answers `CONTAINER_IMAGE_NOT_FOUND` when it holds none. The name is the mark: an upload and a registry's image of the same repository live side by side, and no check replaces one with the other.
  - **A new upload under the same name replaces the image.** Running containers on it then read `updateAvailable`, and a restart applies it, as after a registry update (below).
- A pull reports no percentage (containerd does not expose one): a create's progress shows elapsed time during it.

### Image updates

Wisp checks every OCI image in the library for upstream changes and flags containers running stale bits.

- **Trigger:** a background sweep runs **60 seconds after backend boot** and **every hour** thereafter, armed only where the platform can check (not on the macOS dev stub). The UI also exposes two manual triggers from the Image Library — a bulk **Check for updates** button and a per-row **Check this image** button — and MCP has `check_image_updates`. Every trigger starts the one job kind, `container-image-update-check`, through the job starter, and it is **shared** by scope: a start joins a running check that covers what it asks (a single-image check joins an all-images one; an all-images check never joins a single-image one), and checks take turns ([API-CONTAINERS.md](API-CONTAINERS.md#post-apicontainersimagescheck-updates--agent)).
- **How the check works:** for each image, the current top-level digest is recorded, the image is pulled again, and the new digest is compared. The pull is idempotent — when the upstream digest is unchanged, no layer is downloaded. When the digest differs, new layers are downloaded and stored alongside the old ones (containerd keeps whichever are still referenced by a snapshot).
- **`localhost/` images are not pulled:** a check passes each with a `skipped` event (`CONTAINER_IMAGE_LOCAL`), since there is nothing upstream to compare with.
- **Skipped images:** locally built or unreachable refs (no registry, auth required, network down) emit a `skipped` event (`{ step, ref, error, detail }`, the failure's error body) and continue — one failure never aborts the sweep.
- **Surfacing updates on containers:** nothing is written to container.json. The container list/detail endpoints derive `updateAvailable` per container from (`container.imageDigest` ≠ library digest for its ref) + (task is RUNNING/PAUSED). Every check — the REST job (bulk or single image), the hourly sweep, and MCP `check_image_updates` — ends by re-reading the library and awaiting a container-list refresh, so the badge appears on the `containers` topic without any further event and the REST job only completes (and MCP only answers) once it is visible. Stopped containers always read as `false` — they adopt the new digest on their next start. The check's `flagged-container` events and `imagesUpdated` count are computed from the same derivation, so the UI surfaces matching counts without persistent flags.
- **Apply on start (and restart):** the rootfs is prepared from the current library image on every start ([Ephemeral rootfs](#ephemeral-rootfs)). If containerd's current digest for the reference differs from the stored `imageDigest`, both `imageDigest` and `imagePulledAt` are refreshed. No registry I/O happens here; the start uses whatever the most recent check or create-time pull left in the local image store. No rollback logic: if the snapshot cannot be prepared, the container fails to start and the user must recreate.
- **Auto-pull on missing image:** if the image was removed under us (e.g. `ctr -n wisp image rm <ref>`), the start pulls `config.image` and retries. Operator never has to intervene unless the registry itself is unreachable (in which case the pull surfaces the underlying error).
- **Cached summary:** `GET /api/containers/images/update-status` returns `{ lastCheckedAt, imagesChecked, imagesUpdated }` from the last bulk or single-image run (in-memory, lost on restart).
- **Modified timestamp stability:** containerd bumps an image's `updatedAt` on every pull, including idempotent re-pulls. To keep the Image Library's **Modified** column meaningful, Wisp pins each image's displayed timestamp, for every OCI image whether or not a container uses it: it returns the pinned value while the digest is unchanged, adopts containerd's current `updatedAt` when the digest changes or the image is new, and forgets refs no longer present in containerd. The pins live in a sidecar, `.oci-image-meta.json` in the containers path (shape `{ ref: { digest, updatedAt } }`), whose read-change-write runs one at a time; it also gives a container's `updateAvailable` the library digest without asking containerd. It is a cache: missing, it is rebuilt.
- **Pinned digests:** containers whose `image` is `ref@sha256:…` never flag updates — correct behavior (immutable by design).
- **Where it runs:** the check itself is containerManager's; starting it as a job and its hourly trigger are app glue, shared with the OS update check, because the manager cannot start a job (CODING-RULES §7).

## Container Lifecycle

1. **Create**: the container is defined in containerd **stopped** — image pulled and unpacked, no network, no task. User configures mounts and settings, then **Start**. Create refuses with **409** `CONTAINER_EXISTS` when the name exists in containerd **or** `<containersPath>/<name>/` already exists (typically `files/` kept by a delete without "delete files") — it never adopts, overwrites, or removes a directory it didn't make (settled 2026-10-16). Any failure after the directory is claimed (pull, snapshot, containerd define, invalid mounts/devices) removes only that directory. To reuse kept files, move `files/<mount>` into another container's mount, or remove the directory to free the name.
2. **Start** (stopped), in this order: a stopped task left in containerd is removed → the old rootfs snapshot is removed and `imageDigest`/`imagePulledAt` refreshed → mount sources are prepared (each Local backing file/dir is created empty when missing, same as **Init**; Storage sub-paths are created inside their root) → a fresh snapshot is prepared from the current library image → networking is set up (DHCP wait) and the lease persisted → mount sources are resolved again → the log run is allocated → the task is created and started → SRV/TXT services are registered. Any failure after network setup rolls back (task, netns/CNI, snapshot, services).
   **The task runs the config read at the beginning of the start**, and every `container.json` write during the start merges only what the start owns into the *latest* file: the lease IP/MAC and the refreshed image digest. Once the task has started, `pendingRestart` is set (`since = now`) if a restart-relevant field was saved after the spec was built (an edit saved during the DHCP wait found no task, so nothing else marks it); otherwise a flag the task started after is dropped (settled 2026-11-12). Edits made during the wait are never reverted (settled 2026-10-16).
3. **Stop**: SIGTERM → Wait 10s → SIGKILL if needed → Delete task
4. **Kill**: SIGKILL → Wait 5s → Delete task
5. **Restart**: Stop then Start
6. **Delete**: Kill task → Tear down networking (only when its network namespace exists) → Remove snapshot → Remove containerd container → Delete files on disk. The delete **stops at the first step that fails**, naming it, and can be run again (settled 2026-11-22): every step passes over what is already gone, and `container.json` is removed **last**, so a container whose delete failed is still listed and can be deleted again. One exception: a network lease that cannot be released (the CNI DHCP daemon down) does not stop the delete. The rest runs and the job ends as failed with `CONTAINER_DELETE_INCOMPLETE`, saying the lease was not released. With `deleteFiles=false` ("keep files") everything in the container directory **except `files/`** is removed (a directory without `container.json` is not a container, so it leaves every list and autostart never retries it); a directory left with an empty or missing `files/` is removed too. The kept `<containersPath>/<name>/files/` blocks re-creating that name until it is moved or removed (see Create). Once the container is gone, its follow-ups (a VM delete's plus its `.local` name; settled 2026-11-20): the `.local` name is withdrawn, and its last backup attempt and section assignment are removed, with or without "keep files". Files written through an idmapped mount by an in-container UID other than the configured one may end up `nobody`-owned on disk — fix on the host (e.g. `sudo rm -rf <path>`) if delete fails with permission errors.

### Rename

A container's name is its containerd container ID, the directory key under `containersPath`, the netns name, the published `<name>.local` mDNS host, and the URL/SSE channel key. containerd has no Rename API, so a rename deletes the containerd container, creates it under the new name and renames the directory, with the rootfs snapshot dropped along the way: the rootfs is [ephemeral](#ephemeral-rootfs), and the next start prepares it under the new key.

**Surface:** rename rides on `PATCH /api/containers/:name`. When the request body's `name` differs from the URL segment, the rename runs first and then the rest of the patch is applied under the new name, and the route answers 204. The rename is a step of its own *(settled 2026-11-20)*: the rename, then its follow-ups (below), then the rest under the new name — a failure of the rest answers its error, while the rename and its follow-ups stand; clients follow the new name as *Client effects* below says. There is no separate rename endpoint.

**Preconditions:**

- Container must be **stopped** (no running/paused task). Returns **409** `CONTAINER_MUST_BE_STOPPED` otherwise. The rename does not auto-stop: the user stops the container first (an auto-stop would amount to a restart, too much of a side effect for editing a name).
- New name must pass the [name rules](#name-validation) (1–63 chars, no `..` / path separators).
- New name must not already exist as a containerd container or as a directory under `containersPath`. Returns **409** `CONTAINER_EXISTS` otherwise.

**What it keeps and leaves:** `uuid` is unchanged, and the run-log files travel with the directory. The directory and `container.json` are only touched after containerd has accepted the new id; a failure before that, or of the directory rename, puts the old containerd record back. What was left under the old name is cleaned up, best-effort: its SRV/TXT services, and a netns left by the last stop — CNI `DEL`, which releases the DHCP lease held under the old container id, then the netns delete.

**Then the follow-ups** (a VM rename's plus its `.local` name; settled 2026-11-20), under the lock, best-effort — logged when one fails, never failing the rename:

- The section assignment moves from `container:<old>` to `container:<new>` in `settings.assignments`, so a workload in a custom section keeps that section after rename (a stale assignment the new name kept is dropped). The move reaches clients on the `sections` topic.
- The last backup attempt ([BACKUPS.md → Backup attempt status](BACKUPS.md#backup-attempt-status)) moves to the new name.
- The old `.local` name is withdrawn and the new one published (a renamed container is stopped, so its next start publishes it).

**Client effects (breaking):** the URL `/api/containers/:name/...` and any open SSE / WS channels (stats, logs, container console) under the old name stop responding immediately. The PATCH answers 204 ([API.md](API.md), Command responses). The tab that renamed goes to the new name from its own request; every other tab follows the container's `uuid` to its new name in the `containers` list. The client re-selects under the new name (which restarts the stats SSE) and `replace`-navigates to `/container/<newName>/<tab>`; the moved section assignment arrives on the `sections` topic.

### Restart policy

`restartPolicy` decides what happens when a container's **main process exits on its own** — a crash, an OOM kill, a clean exit, a `kill` from inside or from the host (settled 2026-10-16):

| Policy | Exit status 0 | Exit status ≠ 0 | Stopped through Wisp |
|--------|---------------|-----------------|----------------------|
| `never` | stays stopped | stays stopped | stays stopped |
| `on-failure` | stays stopped | restarted | stays stopped |
| `unless-stopped` (default) | restarted | restarted | stays stopped |
| `always` | restarted | restarted | stays stopped |

- **`always` = `unless-stopped`.** Docker's difference — on daemon restart `always` revives containers the user had stopped — is a boot-time behavior, and boot in Wisp belongs to `autostart` alone: every `autostart: true` container that isn't running is started on host boot and on every `wisp` restart, whatever its policy and whether or not it was stopped by hand. The restart policy never starts anything at boot; there is one boot mechanism, not two. Both values stay offered *(settled 2026-10-16)*: the names are Docker's, and people bring them along.
- **"Stopped through Wisp"** is every exit Wisp itself causes: Stop, Kill, Restart (UI, REST, MCP) and Delete. Those paths note the stop before signalling the task, and the matching `/tasks/exit` is skipped. Matching is by **pid**, so the exit event of the old task arriving after the next start can't be mistaken for a crash of the new one. Rename and in-place restore (which need a stopped container) and a Stop/Kill on a container that is already stopped cancel a pending restart the same way.
- **Trigger:** containerd's `/tasks/exit` event. Exits of exec'd processes (console sessions) are ignored. Exits that happen while `wisp` is down or the events stream is reconnecting are not replayed (no polling fallback); the container stays stopped until started by hand or by autostart on the next `wisp` start.
- **Backoff:** 1 s, doubling, capped at 5 min, per container; one pending restart at a time. A run that stayed up for 60 s resets the next delay to 1 s (judged at the exit — a deferred or failed attempt keeps escalating). Every decision is logged.
- **When the timer fires** it takes the container's [operation lock](#per-container-operation-lock) for the whole attempt. When another operation holds it — a backup, an app-config save, a restore — the attempt is deferred to the next backoff step (logged, never surfaced as an error); Stop, Kill, Start, Delete, Rename and in-place restore cancel the pending restart before they act, so a deferral never revives a container one of them just stopped. With the lock held the state is re-read: a container that was deleted (no `container.json`, including delete-keep-files), switched to `never`, or already started by someone else is left alone. The start is the regular start (fresh rootfs, network, new log run — the crashed run is finalized with its exit code); a failed start is logged and retried on the next backoff step. A user Start during the backoff supersedes the pending restart.
- **A scheduled restart is visible** *(settled 2026-10-16)*: while the backoff runs the container is stopped, but list and detail responses carry `scheduledRestart: { attempt, at }` (every schedule / cancel / fire refreshes the list, so the `containers` topic follows). The UI shows a `Restarting in N s` badge and keeps **Stop** enabled.
- **To stop a crash loop:** Stop the container or set the policy to `never`. Stop (or Kill) on a stopped container with a scheduled restart cancels it: the stop job's result carries `restartCancelled: true`, and Kill answers 204 ([API-CONTAINERS.md](API-CONTAINERS.md)); with nothing scheduled it stays **409** `CONTAINER_NOT_RUNNING`.
- **Not containerd's restart monitor plugin** (`containerd.io/restart.*` labels, used by nerdctl): it restarts the task with containerd's own primitives — no Wisp network setup, no per-run log file, no fresh rootfs — so a container it revived would come up unreachable.
- The policy is containerManager's, as autostart and the lifecycle calls that mark intent are; it is not Wisp glue.

### Per-container operation lock

*(settled 2026-10-16)* Operations on one container are mutually exclusive: each takes an in-memory per-container lock (Wisp glue — the container counterpart of the [per-VM lock](BACKUPS.md#per-vm-operation-lock)) and a second one is refused with **409** `CONTAINER_BUSY` instead of queueing. The message names the running operation (`Container "x" is busy (backup in progress)`), so the UI's action error says what to wait for.

- **Who takes it** *(settled 2026-11-20: one rule for VMs and containers)*: every command that changes a container's state, config or files, for the call or for the whole job. The lock is taken in one place per kind of command: by the job starter for a job, by the instant command's own function for the call — the routes, the MCP tools and the scheduler call those functions, and no route takes a lock itself (`npm run check-fences` fails one that imports it).
  - **Jobs**, through the job starter, which takes the lock before the job's checks run and answers `CONTAINER_BUSY` at once when it is held ([API.md → Background jobs](API.md#background-jobs)): Start, Stop, Restart, Delete (REST and MCP); backups — manual and scheduled; in-place restore, safety backup included; mount delete; mount data delete; the zip upload and its extract, one hold from the upload's first byte to the end of the extract (settled 2026-11-20: the upload is received in the job's check, under the lock, before the job exists); the MCP `deploy_container` (create, config and start) and `update_container_image` (pull, config and restart). A job that creates a container holds the lock of the name it creates: create (`POST /api/containers`), restore as new and `deploy_container` hold the new name's lock for the whole job.
  - **Instant commands**, for the call: Kill; every `PATCH /api/containers/:name` (rename, config / env / mount / device edits, `appConfig` saves — a rename also holds the target name); eject (`POST /api/containers/:name/eject`); the row-scoped mount add / edit and service routes; the MCP `update_app_config` tool; and the mount content commands for as long as they write into the container's directory — the file upload from its first byte to the rename over the mount's file, the content `PUT` and init.
  - **A kill during a stop** is that stop made immediate: while a stop job waits out its grace period (it holds the lock for the whole job), Kill does not meet the lock — it cuts the stop's grace period, and the stop job, still the one command acting on the task, kills it at once and ends as it would. So a kill stays possible during a stop, as a VM's force stop does during a guest shutdown; a kill during any other job answers `CONTAINER_BUSY`.
  - A job's lock is released before its `done`, so an action taken on completion never meets a stale 409.
- **Manager-side takers:** the restart policy and the backend-start autostart pass live in containerManager, which can't import glue (CODING-RULES §7). They take the same lock through an acquirer the glue hands the manager when it is configured. A busy container defers the policy restart to the next backoff step (see [Restart policy](#restart-policy)) and is skipped by autostart (logged). The `/tasks/exit` handler takes it to finalize the run of a task that exited on its own (a busy container is left to its holder), and the network probe takes it too, for its read and write of `container.json` when a container's addresses changed *(settled 2026-11-12)*, as every other writer of that file runs under the lock. A busy container is retried on the next probe; a user action in that window gets the 409 (`network address update in progress`).
- **Frontend:** while any running job has the container as its `subject` (`GET /api/jobs`) — a backup, an in-place restore, a start, a delete, … — Start, Stop, Kill, Restart, Backup and Delete are disabled in the page's header, the job's title the reason — Kill excepted while the job is a stop, which a kill cuts short (above); anything that still races (an instant edit, another client) surfaces the 409 as the action error. Busy is read from the subject, never from a job's title (settled 2026-11-20).

### Backend process startup (host boot / `wisp` restart)

When the Wisp backend process starts, after the libvirt and containerd connection attempts and the mDNS connect, in this order:

1. **Configured mounts** — the startup reconciliation ([STORAGE.md](STORAGE.md)) runs to completion, so Host Mgmt SMB shares and adopted drives are mounted before any autostart container starts (its bind mounts may live on them).
2. **Stale-pause recovery** — any container whose task is still `paused` is resumed. Wisp has no user-facing pause; tasks are only paused around backup archives, so a paused task at boot means a backup was interrupted by a crash. Runs before autostart so that pass sees accurate states.
3. **Container autostart** — each container with `autostart: true` that is not already `running` is started while holding its [operation lock](#per-container-operation-lock) (a busy container is skipped and logged). Failures are logged per container and do not block other containers.
4. **mDNS** — for each running container (including any just started), if `localDns` is true and `network.ip` is set, the `.local` address is registered.

The HTTP server listens **after** these steps.

## Error Codes

Every container code, with its status and meaning: [ERROR-HANDLING.md → Codes](ERROR-HANDLING.md#codes).

## Frontend

The container page: [UI-CONTAINER.md](UI-CONTAINER.md). The list, the sidebar and how a page follows the server: [UI.md](UI.md) and `docs/FRONTEND-RULES.md`.

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) 
- containerd gRPC: every unary call **30 s** unless named here; content reads **60 s**; an image pull has no total bound and is stopped after **5 min** without progress on containerd's transfer progress stream — no byte fetched or extracted (settled 2026-11-13); snapshot removal and image delete (which waits for garbage collection) **2 min** (settled 2026-11-13); `tasks.wait` none — it lasts as long as the process. Channel keepalive pings every **6 min** with a **20 s** timeout while a call is active (containerd refuses pings more often than every 5 min), so a dead containerd drops the events stream, which resubscribes.
- Zip mount uploads: the listing **30 s**; the extract, a job, has no total bound and is stopped after **5 min** with neither an output line nor bytes read — the job fails with `CONTAINER_ZIP_EXTRACT_TIMEOUT` (settled 2026-11-13). FIFO creation for an exec: **5 s**.
- Mount uploads and mount content writes: dropped after **60 s** without body bytes. The mount-usage walk: **20 s**, then it answers what it has sized, `partial: true` (settled 2026-11-13).
- Start, stop, restart, delete, mount and mount-data delete, image delete, restore as new and the zip extract run as server jobs (settled 2026-11-13); their checks (not found, busy, already running / not running, in use, validation) answer on the request.
