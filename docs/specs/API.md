# API Reference

All routes are prefixed with `/api/` (REST) or `/ws/` (WebSocket), plus `/mcp`. This file holds the contracts every route shares: access levels, errors, command responses, background jobs, the events stream, MCP and the WebSockets. The routes themselves are documented by area:

- [API-AUTH.md](API-AUTH.md) — login, logout, password change, API tokens, OIDC
- [API-HOST.md](API-HOST.md) — host inventory and stats, OS and Wisp updates, power, network bridges, host storage, settings, discovery
- [API-VMS.md](API-VMS.md) — VMs, VM stats, disks, CD-ROMs, USB, cloud-init
- [API-CONTAINERS.md](API-CONTAINERS.md) — containers, mounts, services, logs, images, app config
- [API-BACKUPS.md](API-BACKUPS.md) — VM and container backups
- [API-LIBRARY.md](API-LIBRARY.md) — the image library
- [API-WORKSPACE.md](API-WORKSPACE.md) — sidebar sections and the home page

Every endpoint heading carries its **access level** — declared on the route itself and enforced by one hook; see [AUTH.md](AUTH.md) § Route access levels:

| Level | Who may call |
|-------|--------------|
| `public` | anyone — login, the OIDC routes, static assets + SPA shell |
| `session` | browser session only; API tokens get **403 Session required** |
| `read` | session, or an API token of any scope |
| `agent` | session, or an `agent`- or `admin`-scoped token (a `read` token gets **403** `SCOPE_INSUFFICIENT`); an entry may keep a part of the route `admin` ([AUTH.md → The `agent` scope](AUTH.md#the-agent-scope)) |
| `admin` | session, or an `admin`-scoped token (a `read` or `agent` token gets **403** `SCOPE_INSUFFICIENT`) |
| `mcp` | API token only (any scope); cookies are ignored |

Credentials:

- **Session cookie** (the browser/SPA path) — the `wisp_session` cookie set by login. State-changing methods (`POST` / `PUT` / `PATCH` / `DELETE`) additionally require the `X-CSRF-Token` header to match the (non-HttpOnly) `wisp_csrf` cookie. Send `credentials: 'include'` on fetch requests so the browser carries the cookies cross-port in dev.
- **Bearer API token** (the non-interactive path) — `Authorization: Bearer wisp_…`. No CSRF header needed. See [AUTH.md](AUTH.md) § API tokens.

`npm run route-access` prints the level of every registered route. A path that matches no route answers 404 (JSON for API-looking paths, the SPA shell otherwise in production) without an auth check — no handler runs.

**Errors (settled 2026-11-20).** Every error answers `{ "error": "<CODE>", "detail": "<message>" }`: `error` is the stable code, always present, and `detail` the human-readable message. The status follows from the code, through the one table. The framework's own refusals answer the same way: a request that fails its schema is **400** `VALIDATION_FAILED` (`detail` naming the part and the field, `body/<field> …`), malformed JSON **400** `BAD_REQUEST`, an unknown route **404** `ROUTE_NOT_FOUND`, a body too large **413** `PAYLOAD_TOO_LARGE`, an unsupported content type **415** `UNSUPPORTED_MEDIA_TYPE`, a missing or expired session **401** `AUTH_REQUIRED` / `AUTH_INVALID`. The same body is a job's error event, a stream's error frame and an MCP tool error. Every code, its status and its meaning: [ERROR-HANDLING.md](ERROR-HANDLING.md#codes).

**Input is checked against the route's schema (settled 2026-11-20).** Every route declares the params, querystring and body it takes. A key the schema does not list, in a body or a querystring, is refused: **400** `VALIDATION_FAILED`, `detail` naming it (`body: unknown key "x"`, `body/nics/0: unknown key "vlan"`); a route that declares no querystring or no body takes none (a bodiless command still accepts an empty `{}`). A JSON body is not coerced: a string where a number or a boolean is wanted is refused. A querystring and path params arrive as strings and are coerced to the type their schema names (`?deleteFiles=false`, `/services/80`). Every refusal of the input's shape — a missing or unknown key, a wrong type, a value out of range, a name that breaks the [name rules](ERROR-HANDLING.md#name-validation) — is that 400; a route's own 4xx codes (a 422 such as `SECTION_INVALID`) are for what a schema cannot say (a name of whitespace only, a duplicate, an id that names nothing). The MCP tools check their arguments the same way ([MCP.md](MCP.md)).

**Short requests (settled 2026-11-13).** The web client gives up on a REST call after **45 s**, over the request and reading its body. Every route answers within that: an operation that can outlast it is a [job route](#job-routes), which answers 202 at once and reports through the job's stream.

**Command responses (settled 2026-11-15; ARCHITECTURE § Transport).** A state-changing request (`POST` / `PUT` / `PATCH` / `DELETE`) answers with an ack, never its result:

- **`204`**, no body: an instant command (a settings save, a rename, a disk attach).
- **`201 { id }`**: a create that assigns the new record's id (a section, a home-page group or manual tile, a host mount). The new record itself arrives on the stream.
- **`202 { jobId, kind, title, subject }`**: a [job route](#job-routes).
- An error that kept the command from starting answers as any error does (above).

The new state reaches every client through the [events stream](#events-stream-sse): on the topic that carries the record, or as a reference on the [`changes`](#changes-topic-payload) topic, after which a client showing that record GETs it. Exceptions that answer with their result: requests that change no state (`POST /api/host/mounts/check`), a secret shown once (`POST /api/auth/tokens`), and the auth routes (login, logout, change-password). The [MCP endpoint](MCP.md) has no stream and is exempt.

## Background jobs

In-memory job registry (server process only; no persistence across restart) (settled 2026-11-20: one store, one starter, one progress route). Every job, whatever started it (a route, an MCP tool, the scheduler, an hourly check), is started by the one starter, lives in the one store, is listed by `GET /api/jobs` and streams on `GET /api/jobs/:jobId/progress`; MCP's `get_job` reads the same store.

**A job says what it acts on.** A job on a VM or a container carries a `subject`, `{ "type": "vm" | "container", "name" }`, and holds that workload's operation lock from its start to its end ([BACKUPS.md → Per-VM operation lock](BACKUPS.md#per-vm-operation-lock), [CONTAINERS.md → Per-container operation lock](CONTAINERS.md#per-container-operation-lock)). A job that creates a workload has the name it creates as its subject. While the lock is held, starting such a job answers the busy error (`VM_BUSY`, `CONTAINER_BUSY`) at once; no job is created. The lock is released when the job ends, before its last event. A workload is busy while a running job has it as its subject: clients read busy from the subject, never from a title.

**The ack names the job (settled 2026-11-20).** A start answers `{ "jobId", "kind", "title", "subject" }` — the fields of the job's [`GET /api/jobs`](#get-apijobs--read) row that never change, `subject` `{ type, name }` or `null` — as a job route's 202 body and as a job-starting MCP tool's result. A start that joins a running job (below) answers that job's ack. Clients take the kind and the subject from the ack, never supply their own.

**Refusals are answers (settled 2026-11-20).** What keeps a job from starting — the busy lock, a missing resource, a conflict such as `UPDATE_BUSY` — answers the start with its error at once; it never becomes a failed job. The decisive test and the claim it protects are one step: of two starts arriving together, the second answers its refusal (e.g. 409), never a second job or a failed one.

**Shared runs, by scope (settled 2026-11-20).** The OS update check and the image update check are shared: a start, from any trigger, while a running job of the same kind *covers* it answers that job's ack and starts nothing. The OS check always covers another. An image check of every image covers a check of one image; a check of one image covers only a check of that image. So a check of every image started while a check of one image runs is its own job: image check runs then take turns — a run waits for the one before it to end, so two runs never pull the same image at once.

**Jobs that may be cut (settled 2026-11-20).** A job must finish, except the interruptible ones: the OS update check, the image update check and the certificate job ([CERTIFICATES.md](CERTIFICATES.md#the-job)). A shutdown (a restart, a self-update) cuts a running interruptible job: it ends with status `cancelled` and the terminal event `{ "step": "cancelled" }` — not a failure, no error body; the next hourly check runs again. The self-update's `UPDATE_JOBS_ACTIVE` refusal counts only running jobs that must finish.

### GET /api/jobs · `read`

- **200:**

```json
{
  "jobs": [
    {
      "jobId": "string",
      "kind": "vm-create | vm-backup | vm-start | vm-force-stop | vm-delete | vm-restore | container-create | container-backup | container-restore | container-restore-new | container-start | container-stop | container-restart | container-delete | container-mount-delete | container-mount-data-delete | container-zip-extract | container-deploy | container-image-update | container-image-update-check | container-image-delete | library-download | os-update-check | os-upgrade | network-bridge-create | network-bridge-delete | mount-unmount | mount-delete | certificate-issue | self-update",
      "title": "string",
      "subject": { "type": "vm | container", "name": "string" },
      "status": "running | done | error | cancelled",
      "createdAt": 1730000000000
    }
  ]
}
```

Newest first. `subject` is `null` for a job on no workload. `title` is computed on the server (e.g. `Create <name>`, `Backup <name>`; for a library download its URL's origin and path — no userinfo, query or fragment — truncated). A finished job is listed until it expires (below). The same list is the [`jobs` topic](#get-apievents--read) of the events stream, pushed on every change.

**Job store contract** (every kind):

- **Retention:** a finished (completed, failed or cancelled) job stays fetchable — listed here, its progress SSE replaying to the terminal event — for **5 minutes after it finished**, however long it ran; then it is removed (404 on its progress SSE).
- **Progress events** keep `step`, with `percent` and `detail` where they apply, plus each kind's own fields (`currentFile`, `destinationId`, `ref`, …).
- **Progress volume:** byte-driven progress (backup gzip / tar streams, library downloads, `qemu-img convert`) is emitted once per integer percent change — at most ~101 events per stream, whatever the size.
- **Replay to a late or reconnecting stream:** live subscribers get every event, but the store keeps only the latest of consecutive events with the same `step` (progress ticks of one step replace each other). A stream that connects mid-job receives one event per step transition — the latest progress of each, plus milestones such as `destination-done` — then the live tail.
- **Stream end:** the terminal event is the last event of every progress SSE — the server ends the response right after it. A stream opened on an already-finished job gets the replay (ending with the terminal event) and is ended; it is never held open until the job expires. Clients stop on the terminal event and do not reconnect.
- **Done event:** `{ "step": "done", "result": … }` — the job's result as its own key, listed per job route in the area specs.
- **Error event:** `{ "step": "error", "error", "detail" }` — the [error body](ERROR-HANDLING.md#the-error-body): `error` the code (e.g. `VM_ALREADY_RUNNING`, `UPDATE_BUSY`), `detail` the message.
- **Cancelled event:** `{ "step": "cancelled" }` — an interruptible job cut (above). Clients treat it as an end with no error text.

### Job routes

(settled 2026-11-13.) A command that can outlast a short request (45 s, above) runs as a server job (FRONTEND-RULES, Data: the client is an observer): its route checks what it can at once — a bad request, a missing resource, a conflict answer with their usual status — then starts the job and answers **202** with the job's [ack](#background-jobs) `{ jobId, kind, title, subject }`. The job runs to completion whether or not a client follows it. Its progress, and its result as the `done` event's `result`, arrive on `GET /api/jobs/:jobId/progress`; a failure is the `error` event, carrying the code the synchronous route would have answered with. Each job route lists its `done` result in its area spec. The MCP tools that start jobs return the same ack ([MCP.md](MCP.md)).

### GET /api/jobs/:jobId/progress · `read`

The progress SSE of every job (the job store contract above).

- **200:** `text/event-stream` — progress events, then `done`, `error` or `cancelled`
- **404:** `JOB_NOT_FOUND` — unknown job (never started, or expired)

---

## Events stream (SSE)

### GET /api/events · `read`

The single always-on Server-Sent Events stream. Multiplexes every feed the UI needs continuously as `{ "topic": <name>, "data": <payload> }` frames over one connection, not a stream per topic: browsers cap plain-HTTP/1.1 connections at 6 per origin and each open SSE stream holds one. Scoped streams (per-entity stats, container logs, host disks/usb, job progress) remain separate endpoints: they are transient and bounded well below the cap.

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
| `home` | The `{ tiles, groups }` envelope (see [Home page](API-WORKSPACE.md#home-page)) | On every VM list change, container list change, `container.json` write (so app-config edits land here) and homepage write |
| `discovery` | Sorted peer array (see [Discovery](API-HOST.md#discovery)) | On mDNS browse events (peer appeared/left, avahi restart) |
| `backups` | Per-workload last-backup-attempt map (below) | After every backup attempt (manual or scheduled, success or failure) and every backup delete/prune — consumers also use the frame as the cue to refetch the backup lists |
| `jobs` | Same body as `GET /api/jobs` (`{ jobs: [rows] }`) | When the list changes: a job created, a job's status changed (done, error, cancelled), finished jobs expired — never on a progress event, which stays on the job's [progress stream](#get-apijobsjobidprogress--read) (settled 2026-11-20) |
| `changes` | A reference to a changed record (below) | After every saved change no other topic carries in full |

No topic uses a polling timer except the sampled `stats` metrics.

Every topic except `discovery` and `jobs` (in-memory lists that can't fail) may carry an error frame instead of its payload — the error body `{ error, detail }` when that topic's gather fails (e.g. `stats` when a host read throws). Clients keep the last good payload and show the error's text beside it; nothing renders the error object as data.

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
| `certificate` | — | `GET /api/settings/certificate` |
| `wisp-update` | — | `GET /api/updates/status` |

The snapshot frame on connect is `{ "kind": "all" }`: anything may have changed while the stream was down, so a client GETs every record it shows.

#### `backups` topic payload

The persisted last-attempt status map (see [BACKUPS.md → Backup attempt status](BACKUPS.md#backup-attempt-status)):

```json
{
  "vms": { "ubuntu-server": { "at": "2026-07-14T03:00:12.000Z", "ok": true, "origin": "manual", "destinationIds": ["local"], "timestamp": "2026-07-14T03-00-05" } },
  "containers": { "caddy": { "at": "2026-07-14T03:00:41.000Z", "ok": false, "origin": "scheduled", "destinationIds": ["local"], "error": "BACKUP_DEST_NOT_WRITABLE", "detail": "Backup destination not writable: …" } }
}
```

A failed attempt carries the failure's [error body](ERROR-HANDLING.md#the-error-body): `error` is its code, `detail` its text (settled 2026-11-20).

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
    { "type": "x86_pkg_temp", "label": "CPU Package", "tempC": 62.5, "maxC": 80.0, "critC": 95.0, "pciAddress": null },
    { "type": "nvme nvme0", "label": "nvme nvme0", "tempC": 41.0, "maxC": null, "critC": null, "pciAddress": "0000:01:00.0" }
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
  "updateOperationInProgress": false,
  "rebootRequired": false,
  "rebootReasons": [],
  "certificateFailed": false,
  "wispUpdate": { "current": "…", "latest": "…", "available": false, "lastChecked": "…" }
}
```

- `runningContainers` is the count of containers in the running state (0 on non-Linux dev hosts). It is `null` when the container list could not be read (containerd down), as `runningVMs`, `cpu.allocated` and `memory.allocatedGB` are when the VM list could not (libvirt down): a figure is never a guessed 0.
- `cpuTemp` and `cpuPowerWatts` are `null` when unavailable (e.g. non-Intel, VM, or no thermal/powercap sysfs); `cpuTempThresholds` is `null` when unavailable; `thermalZones` is an empty array when unavailable.
- `loadAvg` is [1min, 5min, 15min].
- `wispUpdate` is the self-update status ([UPDATES.md](UPDATES.md), API).
- This is the payload's one home. What each figure measures, and what the other fields mean: [HOST-MONITORING.md](HOST-MONITORING.md), Host Stats and OS updates.
- `pendingUpdates` is the count of upgradable packages from the background hourly check (or 0 if check unavailable).
- `updatesLastChecked` is an ISO 8601 timestamp of the last successful update check (background or manual), or `null` if no check has completed since the backend started.
- `rebootRequired` is `true` when the host has a pending reboot. `rebootReasons` is a list of short tags (the package names that asked for the reboot).
- `certificateFailed` is `true` while the last attempt to get or renew the host's certificate failed ([CERTIFICATES.md → Renewal](CERTIFICATES.md#renewal)); `false` otherwise, with no certificate setting included.
- CPU and memory `allocated` values reflect running VMs only.

---

## MCP

### POST /mcp · `mcp`

Model Context Protocol endpoint (streamable HTTP, stateless, JSON-RPC 2.0) exposing inspection tools, and a few that deploy and run containers, to coding agents. **Bearer API tokens only** — cookies are ignored, so the endpoint is CSRF-irrelevant; missing/invalid tokens get 401 with `WWW-Authenticate: Bearer`. Any token scope passes the route; scope is enforced per tool. `GET /mcp` and `DELETE /mcp` return 405. Full protocol subset, tool catalogue, and client registration in [MCP.md](MCP.md).

---

## WebSocket

### WS /ws/console/:name/vnc · `session`

VNC console WebSocket proxy. Bridges the browser's noVNC client to QEMU's VNC server on localhost.

- **Auth:** `session` — `wisp_session` cookie on the upgrade handshake (sent automatically same-origin); bearer API tokens get 403. `Origin` allow-list enforced.
- **Protocol:** Binary frames — bidirectional TCP-to-WebSocket bridge ([CONSOLE.md](CONSOLE.md))
- **Rejected before the upgrade:** HTTP `401` (no/invalid session — browsers report it as close `1006`), `403` (bearer token), `400` `VALIDATION_FAILED` (a VM name that breaks the name rules)
- **Close codes:**
  - `1008` — Origin not allowed, or all consoles closed after a password change
  - `4000` — `vnc unavailable` (no VNC port yet / libvirt error)
  - `1011` — TCP connection error

### WS /ws/container-console/:name · `session`

Interactive shell (`/bin/sh` on a PTY) in a **running** container; I/O is bridged over WebSocket. When the socket closes, the shell's process is killed.

- **Auth:** `session` — `wisp_session` cookie on the upgrade handshake (same as VNC console); bearer API tokens get 403
- **Query:** `cols` and `rows` (optional integers 1–4096, defaults 80×24) — initial PTY size; client may send further resize messages after connect
- **Protocol:**
  - **Binary frames** — terminal input (client → server) and output (server → client)
  - **Text frames** — JSON control only: `{ "type": "resize", "cols": number, "rows": number }` (client → server)
- **Rejected before the upgrade:** HTTP `401` (no/invalid session — browsers report it as close `1006`), `403` (bearer token), `400` `VALIDATION_FAILED` (a container name that breaks the name rules, a PTY size out of range)
- **Close codes:**
  - `1000` — the shell exited (exec stdout ended); reason `session ended`
  - `1008` — Origin not allowed, or all consoles closed after a password change
  - `4000` — Container not running, or exec failed
  - `1011` — Stream/proxy error
