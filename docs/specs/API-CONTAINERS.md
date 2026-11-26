# API — Containers

Containers, their mounts, services, logs, images and app config. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Containers

A `:name` in the path, and a container name in a body, that breaks the [name rules](ERROR-HANDLING.md#name-validation) (1–63 characters, a leading letter or digit, then letters, digits, `.`, `_`, `-`, no `..`, never trimmed) answers **400** `VALIDATION_FAILED`. Every body and querystring here takes only the keys its route lists ([API.md](API.md), Errors).

**An `agent` token.** An entry tagged `agent` may end with a line *An `agent` token:*, the part of the route that stays `admin`. A request that carries it with an `agent` token answers **403** `SCOPE_INSUFFICIENT`, the `detail` naming the key or the reason, before anything is written ([AUTH.md → The `agent` scope](AUTH.md#the-agent-scope)). A session and an `admin` token are not narrowed.

Every command on a container takes its [operation lock](CONTAINERS.md#per-container-operation-lock) (settled 2026-11-20) — start, stop, restart, kill, delete, `PATCH`, eject, the mount and service row routes, the mount content routes (file and zip upload, content `PUT`, init, data delete), backup and restore: while another of them (or the restart policy's start) runs on the same container they answer **409** `CONTAINER_BUSY`, the message naming the running operation. A kill during a stop is the exception: it makes the stop immediate ([kill](#post-apicontainersnamekill--agent)).

### GET /api/containers · `read`

List all containers (summary).

**200:** `[{ name, uuid, type: "container", image, state, iconId, autoBackup, updateAvailable, scheduledRestart, pendingRestart }]`. `pendingRestart` is the restart-required flag while it is still in force (`{ since }`), else `null` — as on the detail payload, so an open container page drops its badge after a restart done elsewhere (settled 2026-11-12). `scheduledRestart` is `{ attempt, at }` (epoch ms) while the restart policy waits out a backoff for this stopped container, else `null` (see CONTAINERS.md → *Restart policy*). `uuid` is the container's stable identity (CONTAINERS.md → *container.json Schema*): a client follows a rename by it. List payload is intentionally minimal — only what the sidebar and the Backups panel render. `updateAvailable` is set by the image update checker (see CONTAINERS.md → *Image updates*) and defaults to `false` when the field is not set on disk. `autoBackup` mirrors the `container.json` flag (drives the auto-backup badge in Host → Backups). Section assignment is not part of this payload — read it from `GET /api/sections` (see [Sections](API-WORKSPACE.md#sections)). Detail fields (`pid`, `cpuLimit`, `memoryLimitMiB`, `restartPolicy`, `autostart`, etc.) are returned by `GET /api/containers/:name`; runtime samples (`uptime`, live CPU/IO) come from the per-container stats SSE.

`iconId` is the optional UI icon key (same registry as VM icons); omit or `null` means the client uses the default container icon.

Live updates arrive on the `containers` topic of `GET /api/events` (see [Events stream](API.md#events-stream-sse)): the same array, pushed when a container's task or definition changes in containerd, when a `container.json` is written by wisp, or when an image-update check completes. No polling timer.

### POST /api/containers · `agent`

Create a new container: a [job](API.md#job-routes) with the image pull, on `GET /api/jobs/:jobId/progress`. Its subject is the new name, whose [operation lock](CONTAINERS.md#per-container-operation-lock) it holds for the whole job. The container is **defined in containerd but not started** (no task, no CNI setup yet) so mounts and settings can be configured before **Start**.

**Body:** `{ name, image, iconId?, app?, appConfig? }` — any other key is **400** `VALIDATION_FAILED`

Optional `iconId` selects a workload icon from the same set as VMs (persisted in `container.json`).

Optional `app` is an app registry ID (e.g. `"caddy-reverse-proxy"`) — creates a custom app container with a dedicated config UI. If `app` is set without `appConfig`, the app module's default config is used. Unknown `app` values → **422** `UNKNOWN_APP_TYPE`. See [CUSTOM-APPS.md](CUSTOM-APPS.md).

On create, the server writes defaults in `container.json` (empty `mounts`, bridge `network` with a generated MAC and the default container parent bridge, `localDns: true`, etc.). Use **PATCH** to change command, resources, env, mounts, and network before starting.

**202:** `{ jobId, kind, title, subject }` — the [job](API.md#job-routes)'s [ack](API.md#background-jobs) (kind `container-create`, subject the new name); `title` is e.g. `Create <name>`; `done` result: `{ name }` | **409:** `CONTAINER_EXISTS` — the name is taken in containerd or on disk; `CONTAINER_BUSY` while another job holds that name's lock | **400:** `VALIDATION_FAILED` — a name that breaks the name rules, a surrounding whitespace among them (the name is validated as sent, never trimmed), or a missing `name` or `image` | **422:** `UNKNOWN_APP_TYPE` | **503:** `NO_CONTAINERD` — containerd cannot be reached, so the name was not checked and nothing was created

Progress events: `{ step: "validating"|"using-local"|"pulling"|"pulled"|"creating"|"created", ... }`, then `done` or `error`.

The `using-local` step replaces `pulling`/`pulled` when the exact literal `image` in the request body already exists in containerd's `wisp` namespace (e.g. an operator pre-loaded it with `ctr -n wisp image import`, or the Create Container form's picker selected it verbatim). In that case nothing is normalized or pulled, so the sequence is `validating` → `using-local` → `creating` → `created` → `done`. For registry-named refs (`nginx:latest` etc.) the sequence is unchanged: `validating` → `pulling` → `pulled` → `creating` → `created` → `done`.

`created` (`{ step, name, imageDigest }`) means the containerd definition exists; it is not terminal — an app container still writes its config files after it, and a failure there rolls the container back and ends the job with `error`. The terminal `{ step: "done", result: { name } }` comes only from job completion.

*An `agent` token:* `app` and `appConfig`. It creates generic containers only.

### GET /api/containers/images · `read`

List OCI images in the containerd `wisp` namespace (same store used when creating containers).

**200:** `[{ name, digest, size, updated }]` — `name` is the full image reference (an [uploaded](#post-apicontainersimagesupload--agent) image's is under `localhost/`); `digest` is the manifest descriptor digest; **`size`** is the total **compressed** content-store size in bytes (sum of the image manifest’s config + layer descriptor sizes for this host’s platform), not the small top-level index/manifest blob alone; **`updated`** is ISO 8601 from containerd image `updatedAt` / `createdAt`, or `null` if timestamps are missing. If compressed size cannot be resolved, `size` falls back to the top-level descriptor size.

**503:** `NO_CONTAINERD` when containerd is unavailable.

### POST /api/containers/images/upload · `agent`

Upload an image archive, the tar `docker save` or `podman save` writes, and import it into containerd ([CONTAINERS.md → Image Management](CONTAINERS.md#image-management)). Multipart: one file part, streamed to a staging file as it arrives, with the answers of [the mount uploads](#mount-backing-store-filesmountname) for a missing or second file part, a file past the limit, and a body that stalls. Once the upload is received, the import is a [job](API.md#job-routes) (kind `container-image-import`, no subject, `title` `Import <file name>`).

**202:** `{ jobId, kind, title, subject }`; `done` result: `{ images: [{ name, digest }] }`, each image the archive named, under the `localhost/` name it is stored by

**Job errors:** `CONTAINER_IMAGE_ARCHIVE_INVALID` (not an image archive containerd can import; `detail` carries its message), `CONTAINER_IMAGE_ARCHIVE_UNNAMED` (the archive names no image), `CONTAINER_IMAGE_PLATFORM_MISMATCH` (an image in it is not for `linux/<arch>`; `detail` names the host's platform, and the image and its platforms where they could be read). After any of them nothing of the archive is kept.

**503:** `NO_CONTAINERD`

The image list follows on the [`changes`](API.md#changes-topic-payload) topic (`{ kind: "images" }`), and the `containers` topic when a running container's image was replaced.

### DELETE /api/containers/images · `admin`

Remove an image from containerd. Query parameter **`ref`** (required): the image's name exactly as `GET /api/containers/images` lists it (e.g. `docker.io/library/nginx:latest`, or a local-only `myapp:v1`). It is not normalized — a short ref only deletes an image listed under that literal name.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress` (the delete waits for containerd's garbage collection, up to 2 min); `done` result: `{ ref }`

**404:** `CONTAINER_IMAGE_NOT_FOUND`

**409:** `CONTAINER_IMAGE_IN_USE` — at least one Wisp container’s `container.json` `image` is this name, verbatim or after reference normalization. Delete or reconfigure those containers first.

**503 / 500:** the container list's own code (`NO_CONTAINERD`, …) — Wisp cannot tell whether the image is in use, so it is not deleted.

**400:** `VALIDATION_FAILED` — empty or missing `ref`.

**503:** `NO_CONTAINERD`

### POST /api/containers/images/check-updates · `agent`

Start an image update check in the background. **Body:** `{ ref?: string }` — when `ref` is omitted (or empty) a bulk check runs over every image in the library; when `ref` is given, only that image is checked.

For each image, the current top-level digest is recorded, the image is pulled again (idempotent), and the new digest is compared. A `localhost/` image is not pulled: the check passes it with a `skipped` event whose `error` is `CONTAINER_IMAGE_LOCAL`. Nothing is written to `container.json`: `updateAvailable` is derived per running/paused container from its stored `imageDigest` vs. the library digest. The check ends by refreshing the container list (pushed on the `containers` topic) before the job's `done` event, so the badge is visible when the job completes. The hourly sweep and MCP `check_image_updates` start the same job kind (`container-image-update-check`). See CONTAINERS.md → *Image updates*.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`. **Shared** ([API.md → Background jobs](API.md#background-jobs)), by scope: a start joins a running check that covers what it asks — a single-image check joins a running all-images check or a check of the same image — and answers that job's ack; an all-images check never joins a single-image one and starts its own. Checks take turns: a run waits for the one before it, so two never pull the same image at once.

Events:

- `{ step: "checking", ref, index, total }` — check is starting on this image (bulk: index within total; single: 1/1).
- `{ step: "unchanged", ref }` — digest did not change.
- `{ step: "updated", ref, oldDigest, newDigest }` — the registry returned new content; layers were downloaded.
- `{ step: "skipped", ref, error, detail }` — pull failed (local-only ref, unreachable registry, auth required, etc.); `error` and `detail` are the [error body](ERROR-HANDLING.md#the-error-body) of the failure; the sweep continues.
- `{ step: "flagged-container", name }` — this running/paused container now reads `updateAvailable: true`.
- `{ step: "done", result: { checked, updated, flaggedContainers, lastCheckedAt } }` — terminal.
- `{ step: "error", error, detail }` — terminal; unexpected failure (e.g. containerd disconnected mid-sweep). Single-image failures use `skipped` instead.

### GET /api/containers/images/update-status · `read`

Cached summary of the last check. **200:** `{ lastCheckedAt: ISO8601 | null, imagesChecked: number, imagesUpdated: number }`. In-memory; resets on backend restart.

### GET /api/containers/:name · `read`

Full container config including live state.

**200:** The `container.json` fields — `name`, `uuid`, `image`, `command`, `exposedPorts`, `cpuLimit`, `memoryLimitMiB`, `restartPolicy`, `autostart`, `autoBackup`, `runAsRoot`, `localDns`, `iconId`, `createdAt`, `imageDigest`, `imagePulledAt`, `env`, `mounts`, `devices`, `services`, `network`, `metadata` (`app`, `appConfig`), `pendingRestart` — plus `state`, `pid`, `uptime`, `type`, `updateAvailable`, `scheduledRestart`, and `mdnsHostname` when Local DNS is enabled and registration is active. A key outside that list is not returned. `uptime` is `null` unless the container is running, and `pid` is `null` when it has no task: neither is ever `0` (settled 2026-11-24). `network.ip` / `network.mac` are set after CNI DHCP; a lease that lands late is saved by the network probe (see CONTAINERS.md). `pendingRestart` (`{ since }`) is present only while the restart-required rule still holds — a flag older than the running task's start is left out of the response; the read writes nothing (CONTAINERS.md → *Config changes that need a restart*).

The **`env`** field uses a structured shape: `{ KEY: { value, secret?, isSet? } }`. Non-secret entries are returned as `{ value: "plaintext" }`. Secret entries are returned as `{ value: null, secret: true, isSet: boolean }` — the value is never sent to the client, and `isSet` is `true` when a value is stored on disk. See CONTAINERS.md → *Secret env vars*.

Secret **file mounts** in **`mounts`** (a stored `secret: true`, or declared secret by the container's app module) carry `secret: true`, `isSet` (the file is non-empty) and `sizeBytes` (`null` when no file is on disk); their content is never part of any response. See CONTAINERS.md → *Secret file mounts*.

**404:** `CONTAINER_NOT_FOUND` if container not found.

### GET /api/containers/:name/mounts/usage · `read`

Host-side disk usage of each bind mount. On-demand snapshot (not a live feed): each mount's bind source — Local `files/<name>` dir or storage `mountPath/subPath` — is sized as the sum of file byte lengths (symlinks not followed). Can take seconds for large data directories.

**200:** `{ name, mounts: [{ name, containerPath, type, source, hostPath, sizeBytes, partial }] }`

- `source`: `local` | `storage` | `tmpfs` | `missing` (`missing` = the mount's `sourceId` no longer resolves to a configured storage mount).
- `hostPath` / `sizeBytes`: `null` for `tmpfs` (no host backing) and `missing`.
- `partial`: `true` when some entries were unreadable or vanished mid-walk, or the walk hit its **20 s** budget (settled 2026-11-13) — `sizeBytes` is an undercount.

**404:** `CONTAINER_NOT_FOUND` if container not found.

### PATCH /api/containers/:name · `agent`

Partially update container config.

**Body:** Any subset of the fields below — `name`, `image`, `command` (an argv array or `null`), `cpuLimit` (cores > 0, or `null`), `memoryLimitMiB` (an integer ≥ 1, or `null`), `restartPolicy`, `autostart`, `autoBackup`, `runAsRoot`, `localDns`, `iconId`, `network`, `envPatch`, `mounts`, `mountRenames`, `devices`, `appConfig`. Any other key — `env`, `services`, `eject`, and the server-owned fields (`uuid`, `createdAt`, `state`, `imageDigest`, `imagePulledAt`, `updateAvailable`, `pendingRestart`, `metadata`) — is **400** `VALIDATION_FAILED` naming it (settled 2026-11-20: unknown keys refused). Environment variables change through **`envPatch`** only (see below). **`iconId`:** set to a string to choose a UI icon (same ids as VM icons), or `null` / empty string to clear and use the client default. **`localDns`:** boolean toggle for mDNS registration. **`autoBackup`:** boolean — include this container in the daily scheduled backup (no restart needed). **`restartPolicy`:** `never` | `on-failure` | `unless-stopped` | `always`, anything else → **400** `VALIDATION_FAILED`; applies to the next exit, no restart needed (CONTAINERS.md → [Restart policy](CONTAINERS.md#restart-policy)). **`image`:** non-empty string (trimmed): an empty one is **400** `VALIDATION_FAILED`, one of whitespace only **422** `INVALID_CONTAINER_IMAGE_REF`; stored exactly as create stores it — the literal name when containerd holds an image by that name, else Docker-normalized (`nginx:1.27` → `docker.io/library/nginx:1.27`; CONTAINERS.md → *Image Management*). A changed image on a running container sets its `pendingRestart` flag. **`runAsRoot`:** boolean — when `true`, the container process runs as UID/GID 0 instead of the Wisp deploy user (required for images that write to root-owned paths inside the container, e.g. OpenWebUI); requires restart.

**`name`:** Renaming the container. The container must be **stopped** (no running/paused task) — otherwise **409** `CONTAINER_MUST_BE_STOPPED`. The new name is validated with the same rules as create; invalid → **400** `VALIDATION_FAILED`. Conflicts with an existing container or directory → **409** `CONTAINER_EXISTS`. containerd unreachable → **503** `NO_CONTAINERD`, and nothing is renamed. The rename runs first, with its follow-ups, then any other fields in the body apply to the renamed container: when they fail, the answer is their error and the rename stands. The name in effect is the one sent (validation refuses anything it would change), so the client that renamed follows from its request; the change is announced under the new name, and other clients follow the container's `uuid` in the `containers` list. URL paths and SSE channels under the old name stop responding immediately — clients re-subscribe under the new name. See CONTAINERS.md → [Rename](CONTAINERS.md#rename).

**`envPatch`:** Delta applied to the container's environment variables. Keyed by env var name:

- `envPatch[KEY] = { value: "new", secret?: boolean }` — upsert. Fields omitted on an existing entry are preserved.
- `envPatch[KEY] = null` — remove the entry.

Rules: a brand-new key with `secret: true` requires an explicit `value` (otherwise **422** `CONFIG_ERROR`). Flipping an existing entry from `secret: true` → `secret: false` without providing a new `value` clears the stored value to `""` (the UI warns the user before doing this). Renames are expressed as `{ OLD: null, NEW: { value: "..." } }`. Sending a top-level `env` field in the PATCH body is refused as an unknown key (**400** `VALIDATION_FAILED`). An `envPatch` that changes the stored env of a running container sets its `pendingRestart` flag; one that leaves it as it was (e.g. re-sending the current values) does not.

**`network`:** `{ type?, mac?, interface? }`, merged with the existing object (not replaced wholesale); the addresses (`ip`, `ip6`) are the server's and are refused as unknown keys. `network.type` can only be `bridge`; **`network.mac`** is required after merge (unicast format). While the task is **running or paused**, changing **`network.mac`** or **`network.interface`** returns **409** `CONTAINER_MUST_BE_STOPPED`. Invalid MAC → **422** `INVALID_CONTAINER_MAC`.

**`mounts`:** Replaces the entire mounts array (bulk update). Prefer row-scoped mount routes below for UI editing. Each element: `{ type: "file"|"directory"|"tmpfs", name, containerPath, ... }`. For `file`/`directory`: `readonly`, optional `sourceId`/`subPath` (directories only), `containerOwnerUid`/`Gid`, `secret` (file only, boolean — an entry that drops it from a secret mount, by name or as a `mountRenames` target, empties that file first). For `tmpfs`: `sizeMiB` (1–2048, default 64); `sourceId`/`subPath`/`readonly`/`containerOwnerUid`/`Gid` are rejected. **`name`** is a single path segment (storage key under the container’s `files/` directory; tmpfs entries have no on-disk artifact). Duplicate **`name`** or duplicate **`containerPath`** → **422** `CONTAINER_MOUNT_DUPLICATE`. Invalid shape → **422** `INVALID_CONTAINER_MOUNTS`. Mounts removed from the array have their on-disk artifacts deleted automatically (tmpfs has no artifact).

**`mountRenames`:** Optional, only together with `mounts`: `{ "<oldName>": "<newName>" }` marks entries of the new list as renamed current mounts, so Local data moves from `files/<old>` to `files/<new>` instead of being deleted with the old row. Rules and errors: [CONTAINERS.md § Mount entry](CONTAINERS.md#mount-entry). Local mounts dropped from `mounts` without a rename have their data deleted.

**`devices`:** Replaces the entire devices array. Each element: `{ type: "gpu", device }` (a missing or other key, or another `type`, is **400** `VALIDATION_FAILED`). v1 caps the array at one entry; `device` must match `^/dev/dri/renderD\d+$`. Invalid shape → **422** `INVALID_CONTAINER_DEVICES`. Always requires a task restart on running containers. The configured device must exist and be a character device at start; otherwise the container fails to start with **503** `CONTAINER_DEVICE_MISSING`. See CONTAINERS.md → [Devices entry](CONTAINERS.md#devices-entry) for details.

**`services`:** Not editable via PATCH — refused as an unknown key (**400** `VALIDATION_FAILED`). Use the row-scoped service endpoints (`POST` / `PATCH` / `DELETE` `/api/containers/:name/services[/:port]`) below.

**`appConfig`:** (app containers only) Structured config for the app, **sent alone** (settled 2026-11-20): a body with `appConfig` and any other key answers **400** `VALIDATION_FAILED` naming the other keys, before anything is written. Validated by the app module; on success, regenerates derived env, mounts, and mount files. Sets `pendingRestart` (`{ since }`) if the container is running and the change is not applied by a live reload ([CUSTOM-APPS.md → Live Reload](CUSTOM-APPS.md#live-reload)). On a generic container → **422** `CONFIG_ERROR`. Sending `envPatch` or `mounts` on an app container → **422** `APP_CONFIG_ONLY`.

**`eject`:** not a PATCH field (settled 2026-11-20) — **400** `VALIDATION_FAILED` naming it as an unknown key; eject is [its own command](#post-apicontainersnameeject--admin).

**204:** saved; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic, under the new name after a rename (the section assignment, the last backup attempt and the `.local` name follow it — [CONTAINERS.md → Rename](CONTAINERS.md#rename)). A change the running process can't pick up (or an `appConfig` change that is not applied by a live reload) sets `pendingRestart`.

**422:** `APP_RELOAD_FAILED` — the app's reload command exited non-zero. The persisted config and mount file contents are rolled back to the previous (accepted) state, matching what the running app kept serving; check `detail` for stderr.

*An `agent` token:* `name`, `runAsRoot`, `network`, `devices`, `mounts` and `mountRenames` (mounts change through the row routes, which delete nothing). Its `appConfig` holds only keys the app marks agent-writable ([CUSTOM-APPS.md](CUSTOM-APPS.md#backend-app-module-interface)): each replaces that key and the rest of the stored config is kept, where a session's `appConfig` is the whole config. Another key, or an app with no agent-writable key, is refused.

### POST /api/containers/:name/eject · `admin`

Turn an app container into a generic one (settled 2026-11-20: its own command, no longer a `PATCH` field). Removes `app` and `appConfig` from the config; the generated env vars, mounts and files are kept as they are and become directly editable, and the mounts the app declared secret keep a stored `secret: true`. One-way. On a generic container it changes nothing.

**204:** ejected; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **404:** `CONTAINER_NOT_FOUND` | **409:** `CONTAINER_BUSY`

### DELETE /api/containers/:name · `admin`

Delete a container. Query param: `deleteFiles` (`true` | `false`, default `true`; anything else is **400** `VALIDATION_FAILED`). With `deleteFiles=false` the container directory keeps only `files/` (mount data) — `container.json`, run logs and the rest are removed, so the container disappears from the list. Creating a container with the same name then fails with **409** `CONTAINER_EXISTS` until that directory is moved or removed.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name }` | **404:** `CONTAINER_NOT_FOUND` | **409:** `CONTAINER_BUSY`

### POST /api/containers/:name/start · `agent`

Start a stopped container.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name }` | **404:** `CONTAINER_NOT_FOUND` | **409:** `CONTAINER_ALREADY_RUNNING`, `CONTAINER_BUSY`

### POST /api/containers/:name/stop · `agent`

Stop a running container (SIGTERM + grace period). On a stopped container with a restart-policy restart scheduled, cancels that restart.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name, restartCancelled: boolean }` — `restartCancelled: true` when a scheduled restart was cancelled | **404:** `CONTAINER_NOT_FOUND` | **409:** `CONTAINER_NOT_RUNNING` (not running and nothing scheduled), `CONTAINER_BUSY`

### POST /api/containers/:name/restart · `agent`

Restart a container (stop + start).

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name }` | **404:** `CONTAINER_NOT_FOUND` | **409:** `CONTAINER_BUSY`

### POST /api/containers/:name/kill · `agent`

Kill a container (SIGKILL). Same scheduled-restart handling as Stop. While a stop job waits out its grace period, the kill makes that stop immediate (settled 2026-11-20): the stop job kills the task at once and ends as it would, and the kill answers 204 without taking the lock the stop holds. That 204 comes before the task is dead: the stop job ends it within moments, and its end arrives on the `containers` topic. In the short window after the stop job takes the lock and before it has registered its grace period (while it checks the container's state), a kill answers `CONTAINER_BUSY`.

**204:** killed (or the scheduled restart cancelled, or a running stop made immediate); the state arrives on the `containers` topic | **409:** `CONTAINER_NOT_RUNNING` — not running and nothing scheduled; `CONTAINER_BUSY` — another operation than a stop holds the lock

### GET /api/containers/:name/stats · `read`

SSE stream for per-container stats.

- **Query:** `?intervalMs=` (an integer, default **3000**, min **2000**, max **60000**; outside the range **400** `VALIDATION_FAILED`, no longer clamped) — push interval in milliseconds for sampled metrics (CPU, memory, uptime).
- **Event data:** `{ state, cpuPercent, memoryUsageMiB, memoryLimitMiB, uptime, pid, mdnsHostname, ip }`.
- `cpuPercent`, `memoryUsageMiB` and `uptime` are sampled only while the container is running: in any other state (stopped, paused, a backup's pause among them) all three are `null`, never `0`, as a stopped VM's stream sends `null` for its figures (settled 2026-11-24). `pid` is `null` when the container has no task.
- `mdnsHostname` (registered `<hostname>.local`, or `null`) and `ip` (CNI-assigned address, or `null`) are re-read from the live container config on every tick. Both only exist once the container is *running*, so they cannot ride the `GET /api/containers/:name` snapshot the client takes when it selects a workload — clients must read them from this stream, exactly as the VM stats stream carries `mdnsHostname`/`guestIp`.
- **Errors:** `{ error, detail }` (same shape as other SSE error payloads); an error without a code arrives as `INTERNAL_ERROR`.

Default interval is **3s** when `intervalMs` is omitted.

### GET /api/containers/:name/runs · `read`

List log runs for a container. Each start creates a new run under `runs/<runId>.log` with a sidecar `runs/<runId>.json` holding timing + exit status. The newest 10 runs are kept (older pairs pruned on new-run allocation).

**200:** `{ runs: [{ runId, startedAt, endedAt, exitCode, imageDigest, logSizeBytes }, ...] }` — newest first. `endedAt` / `exitCode` are null for the currently-running run.

### GET /api/containers/:name/logs · `read`

SSE stream for a single run's logs. Initial event: `{ type: "history", lines, runId }`. Subsequent: `{ type: "line", line }`.

- **Query:** `?runId=<runId>` — optional, a run id as `GET …/runs` lists it (`2026-10-16T18-34-18-915Z`). Omit it to stream the newest run (the currently-running one if any, else the most recent completed run). Runs that have ended are served from disk and then idle-tailed — the SSE connection stays open with no new lines until the client disconnects. The history is the last 500 complete lines; the live tail continues from the exact byte where the history ended, so every line arrives once, in order, never split — a line still being written arrives when its newline lands (or when the run ends). See CONTAINERS.md → *Live log stream*.
- **Errors:** **400** `VALIDATION_FAILED` for a malformed `runId` (an empty one included), **404** `CONTAINER_RUN_NOT_FOUND` for a well-formed one with no run — the same answers as the run-log download (settled 2026-11-20: one run id schema for both). A history read failure after the stream opened sends one `{ error, detail }` event (`INTERNAL_ERROR` for an error without a code) and ends the stream.
- **Empty state:** containers with no runs yet (never started) return a single history event with `lines: []` and `runId: null`.

### GET /api/containers/:name/runs/:runId/log · `read`

Download one run's log file. Responds with `Content-Type: text/plain; charset=utf-8` and an RFC 5987 `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded(name-runId.log)>` header. Streams the file directly from disk. `runId` must match `^[a-zA-Z0-9._-]+$`.

**404:** `CONTAINER_RUN_NOT_FOUND` if the run does not exist. **400:** `VALIDATION_FAILED` — a `runId` that is not a run id's shape (the logs stream answers the same).

### POST /api/containers/:name/mounts · `agent`

Append one bind mount (row-scoped). **Body:** `{ type: "file"|"directory"|"tmpfs", name, containerPath, ... }` (same shape as one element of **`mounts`** in **PATCH**; `readonly`/`sourceId`/`subPath`/`containerOwnerUid`/`Gid` for file/directory; `secret` for file; `sizeMiB` for tmpfs). A new secret file mount starts empty (`isSet: false`) — write its content with **PUT** content or the file upload.

**204:** added; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic; a running container gets `pendingRestart` | **422:** `INVALID_CONTAINER_MOUNTS`, `CONTAINER_MOUNT_DUPLICATE`, `APP_CONFIG_ONLY` on any app container (its mounts come from `appConfig`)

*An `agent` token:* `sourceId` and `subPath`. It adds mounts kept on this host only.

### PATCH /api/containers/:name/mounts/:mountName · `agent`

Update one mount by its current storage **`name`** (URL segment). **Body:** optional subset of `{ name, containerPath, readonly, sourceId, subPath, containerOwnerUid, containerOwnerGid, secret }` for file/directory mounts (`secret` on file mounts only), or `{ name, containerPath, sizeMiB }` for tmpfs mounts (other fields rejected on tmpfs). Renaming **`name`** moves `files/<oldName>` to `files/<newName>` on disk; tmpfs renames are config-only. **`secret: false`** on a secret mount empties its file first (write-only content can't be revealed by dropping the flag); a change of `secret` alone needs no restart (no `pendingRestart`).

**204:** saved; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic; a running container gets `pendingRestart` when the change needs it | **404:** `CONTAINER_MOUNT_NOT_FOUND` | **422:** `CONTAINER_MOUNT_DUPLICATE` — duplicate path/name, `INVALID_CONTAINER_MOUNTS`, `APP_CONFIG_ONLY` (mount of an app container — see CUSTOM-APPS.md § Mount content routes)

*An `agent` token:* `sourceId` and `subPath`, and any change to a mount that has a `sourceId` (one backed by a storage share or drive).

### DELETE /api/containers/:name/mounts/:mountName · `admin`

Remove one mount and delete its `files/<mountName>` backing store (tmpfs has no backing store; its row is removed config-only).

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ requiresRestart: boolean }` | **404:** `CONTAINER_MOUNT_NOT_FOUND` | **409:** `CONTAINER_BUSY` | **422:** `APP_CONFIG_ONLY` on an app container's mount (see CUSTOM-APPS.md § Mount content routes)

### Mount backing store (`files/<mountName>`)

Multipart **file** upload: a single file part (field name typically **`file`**). The mount must already exist in `container.json`.

The file part is streamed as it arrives — for a **file** mount into a temp file beside the mount's file in `files/` (renamed over it once the whole body has been read: an atomic replace, and the reply follows the upload at once), for a **zip** into a staging file inside the container directory (extracted by the job that received it) — so every rejection below leaves the mount untouched. The temp file is removed on any failure or abort; one a crash leaves behind carries the atomic-write suffix the boot cleanup sweeps (settled 2026-11-14). Field parts are ignored, before or after the file.

**400:** `BAD_MULTIPART_TOO_MANY_FILES` if more than one file part (extra parts are read and discarded first) | `UPLOAD_NO_FILE` if no file part. **404:** `CONTAINER_NOT_FOUND` — container not found. **413:** `UPLOAD_TOO_LARGE` (`File too large`) past the multipart `fileSize` limit (50 GiB). An upload whose body sends nothing for **60 s** is dropped (settled 2026-11-13; also the PUT content body).

The file part is consumed while iterating, never held across later parts (settled 2026-10-16): holding it to check for a second file hangs the upload.

### POST /api/containers/:name/mounts/:mountName/file · `agent`

Multipart: one file part. Mount must have **`type: "file"`**. Overwrites an existing file.

**204:** written; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **409:** `CONTAINER_BUSY` — the upload holds the lock from its first byte to the replace | **422:** `APP_CONFIG_ONLY` (app-managed mount — see GET content below). Works on secret mounts (write-only).

### POST /api/containers/:name/mounts/:mountName/zip · `agent`

Multipart: one file part. Mount must have **`type: "directory"`** (Local, not storage-sourced). Once the upload is received and its entry paths pass the zip-slip check, the extract is a [job](API.md#job-routes): it clears `files/<mountName>/` and extracts the zip. The upload and the extract hold the container's operation lock as one, from the upload's first byte to the end of the extract: the upload is received in the job's check, before the job exists.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name, mount }` | **409:** `CONTAINER_BUSY` — another command holds the lock when the upload starts; while the upload and its extract run, other commands get it | **422:** `CONTAINER_ZIP_INVALID`, `CONTAINER_ZIP_UNSAFE`, `CONTAINER_MOUNT_TYPE_MISMATCH`, `APP_CONFIG_ONLY` on an app container's mount (checked before the upload is staged) | **Job errors:** `CONTAINER_ZIP_EXTRACT_TIMEOUT` (the extract made no progress for its bound), `CONTAINER_ZIP_INVALID` (unzip failed)

### GET /api/containers/:name/mounts/:mountName/content · `agent`

**File** mounts only. Returns the backing file as UTF-8 text for the in-app editor.

**Secret file mounts are refused for every caller** (session or token, any scope) with **403** `CONTAINER_MOUNT_SECRET` — a stored `secret: true`, or a file the container's app module declares secret (tiny-samba `tiny-samba-passwords`; zot `htpasswd`, `session-keys`, and `config-json` while OIDC is on). Their content is write-only: replace it with **PUT** or the file upload, never read it back. Non-secret files of app containers (Caddy's `Caddyfile`, …) are readable; *writes* to any app-managed mount stay refused with `APP_CONFIG_ONLY` (see PUT below). (settled 2026-10-16: one secret rule, refusal for all callers, no token-only special case.)

**200:** `{ content: string }` — UTF-8 text (max **512 KiB** decoded size on disk).

**403:** `CONTAINER_MOUNT_SECRET` | **404:** `CONTAINER_NOT_FOUND`, `CONTAINER_MOUNT_NOT_FOUND` | **422:** `CONTAINER_MOUNT_TYPE_MISMATCH`, `CONTAINER_MOUNT_FILE_TOO_LARGE`, `CONTAINER_MOUNT_FILE_NOT_UTF8`, `CONTAINER_MOUNT_SOURCE_MISSING` (no file on disk yet)

### PUT /api/containers/:name/mounts/:mountName/content · `agent`

**Body:** JSON `{ "content": string }`. Replaces the backing file with UTF-8 bytes (max **512 KiB** encoded length).

Works on secret mounts (write-only); `{ "content": "" }` clears one.

**204:** written; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **409:** `CONTAINER_BUSY` | **413:** `PAYLOAD_TOO_LARGE` — request body too large | **422:** same family as GET for type/size/encoding, plus `APP_CONFIG_ONLY` for app-managed mounts (an app container's files are regenerated from `appConfig` on every save — configure the app, or eject it first)

### POST /api/containers/:name/mounts/:mountName/init · `agent`

Create an empty file (0 bytes) or empty directory according to the mount **`type`** (still supported for API clients; the UI relies on automatic creation when saving mounts or starting).

**204:** created; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **409:** `CONTAINER_BUSY` | **422:** `APP_CONFIG_ONLY` on an app container's mount (see CUSTOM-APPS.md § Mount content routes)

*An `agent` token:* a mount that has a `sourceId`.

### DELETE /api/containers/:name/mounts/:mountName/data · `admin`

Remove the backing file or directory tree for that mount. The mount row remains in `container.json` until **DELETE** `/mounts/:mountName` or **PATCH** replaces **`mounts`**.

**202:** `{ jobId, kind, title, subject }` — a [job](API.md#job-routes) on `GET /api/jobs/:jobId/progress`; `done` result: `{ name, mount }` — the job holds the container's [operation lock](CONTAINERS.md#per-container-operation-lock) | **404:** `CONTAINER_MOUNT_NOT_FOUND` | **409:** `CONTAINER_BUSY` | **422:** `CONTAINER_MOUNT_TYPE_MISMATCH` (tmpfs), `APP_CONFIG_ONLY` on an app container's mount (see CUSTOM-APPS.md § Mount content routes)

### POST /api/containers/:name/services · `agent`

Append one mDNS service advertisement (row-scoped, keyed by port). **Body:** `{ port: integer, type: string, txt?: object }` — `type` matches `^_[a-z0-9-]+\._(tcp|udp)$`; `txt` is a flat map of string keys to string values (another value type is **400** `VALIDATION_FAILED`). Requires `localDns: true` on the container. Live registration happens immediately if the container is running.

**204:** added; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **409:** `CONTAINER_LOCAL_DNS_DISABLED`, `CONTAINER_SERVICE_DUPLICATE` | **422:** `INVALID_CONTAINER_SERVICE`

### PATCH /api/containers/:name/services/:port · `agent`

Update one service identified by its current **`port`** (URL segment). **Body:** optional subset of `{ type, txt }`. Port is not editable — delete + create to move to a different port.

**204:** saved; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **404:** `CONTAINER_SERVICE_NOT_FOUND` | **409:** `CONTAINER_LOCAL_DNS_DISABLED` | **422:** `INVALID_CONTAINER_SERVICE`

### DELETE /api/containers/:name/services/:port · `agent`

Remove an mDNS service by its port. Live deregistration happens immediately if the container is running.

**204:** removed; the container's new state reaches clients as `{ kind: "container", id }` on the [`changes`](API.md#changes-topic-payload) topic | **404:** `CONTAINER_SERVICE_NOT_FOUND`
