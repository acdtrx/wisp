# API Reference

All routes are prefixed with `/api/` (REST) or `/ws/` (WebSocket), plus `/mcp`. This file holds the contracts every route shares: access levels, errors, command responses, background jobs, the events stream, MCP and the WebSockets. The routes themselves are documented by area (split 2026-11-15, so a reader loads only the area it works on):

- [API-AUTH.md](API-AUTH.md) — login, logout, password change, API tokens, OIDC
- [API-HOST.md](API-HOST.md) — host inventory and stats, OS and Wisp updates, power, network bridges, host storage, settings, discovery
- [API-VMS.md](API-VMS.md) — VMs, VM stats, disks, CD-ROMs, USB, cloud-init
- [API-CONTAINERS.md](API-CONTAINERS.md) — containers, mounts, services, logs, images, app config
- [API-BACKUPS.md](API-BACKUPS.md) — VM and container backups
- [API-LIBRARY.md](API-LIBRARY.md) — the image library
- [API-WORKSPACE.md](API-WORKSPACE.md) — sidebar sections and the home page

Every endpoint heading carries its **access level** — declared on the route itself (`config: { auth }`) and enforced by one hook; see [AUTH.md](AUTH.md) § Route access levels:

| Level | Who may call |
|-------|--------------|
| `public` | anyone — login, the OIDC routes, static assets + SPA shell |
| `session` | browser session only; API tokens get **403 Session required** |
| `read` | session, or an API token of either scope |
| `admin` | session, or an `admin`-scoped token (a `read` token gets **403 Insufficient scope**) |
| `mcp` | API token only (either scope); cookies are ignored |

Credentials:

- **Session cookie** (the browser/SPA path) — the `wisp_session` cookie set by login. State-changing methods (`POST` / `PUT` / `PATCH` / `DELETE`) additionally require the `X-CSRF-Token` header to match the (non-HttpOnly) `wisp_csrf` cookie. Send `credentials: 'include'` on fetch requests so the browser carries the cookies cross-port in dev.
- **Bearer API token** (the non-interactive path) — `Authorization: Bearer wisp_…`. No CSRF header needed. See [AUTH.md](AUTH.md) § API tokens.

`npm run route-access` prints the level of every registered route. A path that matches no route answers 404 (JSON for API-looking paths, the SPA shell otherwise in production) without an auth check — no handler runs.

**Errors (settled 2026-11-20).** Every error answers `{ "error": "<CODE>", "detail": "<message>" }`: `error` is the stable code, always present, and `detail` the human-readable message. The status follows from the code, through the one table. The framework's own refusals answer the same way: a request that fails its schema is **400** `VALIDATION_FAILED` (`detail` naming the part and the field, `body/<field> …`), malformed JSON **400** `BAD_REQUEST`, an unknown route **404** `ROUTE_NOT_FOUND`, a body too large **413** `PAYLOAD_TOO_LARGE`, an unsupported content type **415** `UNSUPPORTED_MEDIA_TYPE`, a missing or expired session **401** `AUTH_REQUIRED` / `AUTH_INVALID`. The same body is a job's error event, a stream's error frame and an MCP tool error. Every code, its status and its meaning: [ERROR-HANDLING.md](ERROR-HANDLING.md#codes).

**Short requests (settled 2026-11-13).** The web client gives up on a REST call after **45 s**, over the request and reading its body. Every route answers within that: an operation that can outlast it is a [job route](#job-routes), which answers 202 at once and reports through the job's stream.

**Command responses (settled 2026-11-15; ARCHITECTURE § Transport).** A state-changing request (`POST` / `PUT` / `PATCH` / `DELETE`) answers with an ack, never its result:

- **`204`**, no body: an instant command (a settings save, a rename, a disk attach).
- **`201 { id }`**: a create that assigns the new record's id (a section, a home-page group or manual tile, a host mount). The new record itself arrives on the stream.
- **`202 { jobId, title }`**: a [job route](#job-routes).
- An error that kept the command from starting answers as any error does (above).

The new state reaches every client through the [events stream](#events-stream-sse): on the topic that carries the record, or as a reference on the [`changes`](#changes-topic-payload) topic, after which a client showing that record GETs it. Exceptions that answer with their result: requests that change no state (`POST /api/host/mounts/check`), a secret shown once (`POST /api/auth/tokens`), and the auth routes (login, logout, change-password). The [MCP endpoint](MCP.md) has no stream and is exempt.

## Background jobs

In-memory job registry (server process only; no persistence across restart). Used to restore the jobs tray after a full page reload and for server logging. Progress for each job uses its kind's SSE endpoint: the per-feature ones (`/vms/create-progress`, `/vms/backup-progress`, `/library/download-progress`, `/containers/create-progress`, …), or `GET /api/jobs/:jobId/progress` for the [job routes](#job-routes).

### GET /api/background-jobs · `read`

- **200:**

```json
{
  "jobs": [
    {
      "jobId": "string",
      "kind": "vm-create | container-create | container-image-update-check | backup | container-backup | container-restore | library-download | vm-start | vm-force-stop | vm-delete | vm-restore | os-update-check | os-upgrade | network-bridge-create | network-bridge-delete | mount-unmount | mount-delete | self-update | container-start | container-stop | container-restart | container-delete | container-mount-delete | container-mount-data-delete | container-image-delete | container-restore-new | container-zip-extract | container-deploy | container-image-update | container-image-check",
      "title": "string",
      "done": false,
      "createdAt": 1730000000000
    }
  ]
}
```

`done` is true after the job completed or failed (until the in-memory TTL removes it). `title` is computed on the server (same rules as the UI: e.g. `Create <name>`, `Backup <name>`, truncated URLs for library downloads).

**Job store contract** (`lib/jobs/jobStore.js`, shared by every job kind):

- **Retention:** a finished (completed or failed) job stays fetchable — listed here, its progress SSE replaying to the terminal event — for **5 minutes after it finished**, however long it ran; then it is removed (404 on its progress SSE). The sweep re-arms for the next expiry while finished jobs remain.
- **Progress volume:** byte-driven progress (backup gzip / tar streams, library downloads, `qemu-img convert`) is emitted once per integer percent change — at most ~101 events per stream, whatever the size.
- **Replay to a late or reconnecting stream:** live subscribers get every event, but the store keeps only the latest of consecutive events with the same `step` (progress ticks of one step replace each other). A stream that connects mid-job receives one event per step transition — the latest progress of each, plus milestones such as `destination-done` — then the live tail.
- **Stream end:** the terminal event (`done` or `error`) is the last event of every progress SSE — the server ends the response right after it. A stream opened on an already-finished job gets the replay (ending with the terminal event) and is ended; it is never held open until the job expires. Clients stop on the terminal event and do not reconnect.
- **Error event:** `{ step: "error", error, detail }` — the [error body](ERROR-HANDLING.md#the-error-body): `error` the code (e.g. `VM_ALREADY_RUNNING`, `UPDATE_BUSY`), `detail` the message.

### Job routes

(settled 2026-11-13.) A command that can outlast a short request (45 s, above) runs as a server job (FRONTEND-RULES, Data: the client is an observer): its route checks what it can at once — a bad request, a missing resource, a conflict answer with their usual status — then starts the job and answers **202** `{ jobId, title }`. The job runs to completion whether or not a client follows it. Its progress, and its result as the `done` event's payload, arrive on `GET /api/jobs/:jobId/progress`; a failure is the `error` event, carrying the code the synchronous route would have answered with. The routes: VM start, force-stop and delete; VM restore as new; the OS update check, package refresh and upgrade; network-bridge create and delete; mount unmount and delete; the Wisp update install; container start, stop, restart and delete; container mount delete and mount-data delete; image delete; container restore as new; the zip extract after its upload. Each lists its `done` payload below. The MCP tools that start jobs return the same `{ jobId, title }` ([MCP.md](MCP.md)).

### GET /api/jobs/:jobId/progress · `read`

The progress SSE of a job started by a [job route](#job-routes) (the job store contract above).

- **200:** `text/event-stream` — progress events, then `done` (the route's result) or `error`
- **404:** `JOB_NOT_FOUND` — unknown job (never started, or expired)

---

## Events stream (SSE)

### GET /api/events · `read`

The single always-on Server-Sent Events stream. Multiplexes every feed the UI needs continuously as `{ "topic": <name>, "data": <payload> }` frames over one connection — browsers cap plain-HTTP/1.1 connections at 6 per origin and each open SSE stream holds one, so dedicated per-topic streams exhausted the pool on direct `http://host:8080` access and queued all further requests indefinitely (behind an HTTP/2 proxy the cap never applies). Scoped streams (per-entity stats, container logs, host disks/usb, job progress) remain separate endpoints: they are transient and bounded well below the cap.

Every topic sends a snapshot frame on connect (and after every client reconnect), then pushes on its own cadence. A topic that fails to gather sends the error body `{ error, detail }` as its `data`; the stream stays up and the other topics keep flowing.

- **Content-Type:** `text/event-stream`
- **Frame:** `data: { "topic": "<name>", "data": <payload> }`
- **Topics:**

| Topic | Payload (`data`) | Pushed |
|-------|------------------|--------|
| `stats` | Host statistics (below) | Every 5 s |
| `vms` | Same array as `GET /api/vms` | On libvirt `DomainEvent` (define/undefine/start/stop/…) and qemu binary replacement on disk |
| `containers` | Same array as `GET /api/containers` | On containerd events, `container.json` writes, image-update completion |
| `sections` | The `{ sections, assignments }` envelope (see [Sections](API-WORKSPACE.md#sections)) | After every successful section or assignment write |
| `home` | The `{ tiles, groups }` envelope (see [Home page](API-WORKSPACE.md#home-page)) | On every VM list change, container list change (which includes `container.json` writes, so app-config edits land here), and homepage write |
| `discovery` | Sorted peer array (see [Discovery](API-HOST.md#discovery)) | On mDNS browse events (peer appeared/left, avahi restart) |
| `backups` | Per-workload last-backup-attempt map (below) | After every backup attempt (manual or scheduled, success or failure) and every backup delete/prune — consumers also use the frame as the cue to refetch the backup lists |
| `changes` | A reference to a changed record (below) | After every saved change no other topic carries in full |

No topic uses a polling timer except the sampled `stats` metrics.

Every topic except `discovery` (an in-memory list that can't fail) may carry an error frame instead of its payload — the error body `{ error, detail }` when that topic's gather fails (e.g. `stats` when a host read throws). Clients ignore error frames and keep the last good payload; nothing renders the error object as data.

#### `changes` topic payload

(settled 2026-11-15.) `{ "kind": "<kind>", "id": "<id>" }`, `id` omitted when the kind is one record or a whole list. The module that saved the change publishes it, never the route. A client that shows the record GETs it again; every other client ignores the frame.

| `kind` | `id` | GET it names |
|--------|------|--------------|
| `vm` | VM name | `GET /api/vms/:name` and what its detail view reads (cloud-init, USB attachments) |
| `container` | container name | `GET /api/containers/:name` and what its detail view reads (mounts, files, services) |
| `settings` | — | `GET /api/settings` |
| `host-mounts` | — | `GET /api/host/mounts`, `GET /api/host/mounts/status` |
| `network-bridges` | — | `GET /api/host/network-bridges` |
| `library` | — | `GET /api/library` |
| `images` | — | `GET /api/containers/images` |
| `tokens` | — | `GET /api/auth/tokens` |
| `wisp-update` | — | `GET /api/updates/status` |

The snapshot frame on connect is `{ "kind": "all" }`: anything may have changed while the stream was down, so a client GETs every record it shows.

#### `backups` topic payload

The persisted last-attempt status map (see [BACKUPS.md → Backup attempt status](BACKUPS.md#backup-attempt-status)):

```json
{
  "vms": { "ubuntu-server": { "at": "2026-07-14T03:00:12.000Z", "ok": true, "origin": "manual", "destinationIds": ["local"], "timestamp": "2026-07-14T03-00-05" } },
  "containers": { "caddy": { "at": "2026-07-14T03:00:41.000Z", "ok": false, "origin": "scheduled", "destinationIds": ["local"], "error": "Backup destination not writable" } }
}
```

#### `stats` topic payload

```json
{
  "cpu": {
    "allocated": 8,
    "total": 16,
    "usagePercent": 34.2,
    "perCore": [12.5, 45.0, 8.3]
  },
  "cpuTemp": 62.5,
  "cpuTempThresholds": { "maxC": 80.0, "critC": 95.0 },
  "thermalZones": [
    { "type": "x86_pkg_temp", "label": "CPU Package", "tempC": 62.5, "maxC": 80.0, "critC": 95.0 },
    { "type": "acpitz", "label": "ACPI", "tempC": 27.8, "maxC": null, "critC": 95.0 }
  ],
  "cpuPowerWatts": 45.2,
  "memory": {
    "allocatedGB": 12.0,
    "totalGB": 64.0,
    "usagePercent": 28.1,
    "usedBytes": 0,
    "buffersBytes": 0,
    "cachedBytes": 0,
    "swapTotalBytes": 0,
    "swapUsedBytes": 0
  },
  "loadAvg": [1.2, 0.8, 0.6],
  "disk": { "readMBs": 1.2, "writeMBs": 0.4 },
  "net": { "rxMBs": 2.1, "txMBs": 0.8 },
  "runningVMs": 3,
  "runningContainers": 2,
  "pendingUpdates": 0,
  "updatesLastChecked": "2026-04-03T12:00:00.000Z",
  "rebootRequired": false,
  "rebootReasons": []
}
```

- `runningContainers` is the count of containers in the running state (0 when containerd is unavailable or on non-Linux dev hosts).
- `cpuTemp` and `cpuPowerWatts` are `null` when unavailable (e.g. non-Intel, VM, or no thermal/powercap sysfs).
- `cpuTemp` is selected from the best CPU-relevant sensor (package/core sensors preferred over generic ACPI/platform sensors).
- `cpuTempThresholds` contains thresholds for the selected primary CPU sensor as `{ maxC, critC }` (or `null` when unavailable).
- `thermalZones` contains readable thermal sensors as `{ type, label, tempC, maxC, critC }`; empty array when unavailable. If both sysfs sources expose the same sensor type, `thermal_zone` is preferred and duplicate `hwmon` entry is omitted.
- `loadAvg` is [1min, 5min, 15min] from /proc/loadavg.
- `pendingUpdates` is the count of upgradable packages from the background hourly check (or 0 if check unavailable).
- `updatesLastChecked` is an ISO 8601 timestamp of the last successful update check (background or manual), or `null` if no check has completed since the backend started.
- `rebootRequired` is `true` when the host has a pending reboot. `rebootReasons` is a list of short tags (the package names that asked for the reboot).
- CPU and memory `allocated` values reflect running VMs only.

---

## MCP

### POST /mcp · `mcp`

Model Context Protocol endpoint (streamable HTTP, stateless, JSON-RPC 2.0) exposing read-only inspection tools to coding agents. **Bearer API tokens only** — cookies are ignored, so the endpoint is CSRF-irrelevant; missing/invalid tokens get 401 with `WWW-Authenticate: Bearer`. Either token scope passes the route; scope is enforced per tool. `GET /mcp` and `DELETE /mcp` return 405. Full protocol subset, tool catalogue, and client registration in [MCP.md](MCP.md).

---

## WebSocket

### WS /ws/console/:name/vnc · `session`

VNC console WebSocket proxy. Bridges the browser's noVNC client to QEMU's VNC server on localhost.

- **Auth:** `session` — `wisp_session` cookie on the upgrade handshake (sent automatically same-origin); bearer API tokens get 403. `Origin` allow-list enforced.
- **Protocol:** Binary frames — bidirectional TCP-to-WebSocket bridge
- **Connection flow:**
  1. Global auth hook validates the session cookie before the upgrade completes
  2. Validate VM name
  3. Read VNC port from domain XML
  4. Open TCP connection to `127.0.0.1:<port>`
  5. Pipe data bidirectionally between WebSocket and TCP socket
- **Rejected before the upgrade:** HTTP `401` (no/invalid session — browsers report it as close `1006`), `403` (bearer token)
- **Close codes:**
  - `1008` — Origin not allowed, or all consoles closed after a password change
  - `4000` — `invalid name` (VM name) or `vnc unavailable` (no VNC port yet / libvirt error)
  - `1011` — TCP connection error

### WS /ws/container-console/:name · `session`

Interactive shell in a **running** container. Uses containerd `Tasks.Exec` with a PTY (`/bin/sh`); I/O is bridged over WebSocket.

- **Auth:** `session` — `wisp_session` cookie on the upgrade handshake (same as VNC console); bearer API tokens get 403
- **Query:** `cols` and `rows` (optional, defaults 80×24) — initial PTY size; client may send further resize messages after connect
- **Protocol:**
  - **Binary frames** — terminal input (client → server) and output (server → client)
  - **Text frames** — JSON control only: `{ "type": "resize", "cols": number, "rows": number }` (client → server)
- **Connection flow:**
  1. Global auth hook validates the session cookie before the upgrade completes
  2. Validate container name
  3. Ensure the container task is running; create a unique exec session with named pipes + `Tasks.Exec` / `Tasks.Start`
  4. Bridge WebSocket ↔ FIFO streams; forward `resize` to `Tasks.ResizePty`
  5. On close, kill the exec process and remove temp FIFO directory
- **Rejected before the upgrade:** HTTP `401` (no/invalid session — browsers report it as close `1006`), `403` (bearer token)
- **Close codes:**
  - `1000` — the shell exited (exec stdout ended); reason `session ended`
  - `1008` — Origin not allowed, or all consoles closed after a password change
  - `4000` — Invalid container name, container not running, or exec failed
  - `1011` — Stream/proxy error
