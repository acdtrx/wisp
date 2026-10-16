# Error Handling

Error handling follows a consistent pattern across the entire stack: backend library modules throw structured errors, route handlers map them to HTTP status codes, and the frontend displays contextual error messages.

## Backend Error Shape

### vmManager errors

All vmManager functions throw errors with a structured shape:

```
{ code: string, message: string, raw?: string }
```

- **code** — machine-readable error identifier (e.g. `VM_NOT_FOUND`)
- **message** — human-readable error description
- **raw** — optional raw error string from libvirt or system calls

These are created via `createAppError(code, message, raw)` which returns a standard `Error` object with `code` and `raw` properties attached.

### containerManager errors

Container manager functions use the same structured error shape via `containerError(code, message, raw)` (which calls `createAppError` internally). Container-specific codes include: `CONTAINER_NOT_FOUND`, `CONTAINER_MOUNT_NOT_FOUND`, `CONTAINER_ALREADY_RUNNING`, `CONTAINER_NOT_RUNNING`, `CONTAINER_EXISTS`, `CONTAINER_MUST_BE_STOPPED`, `CONTAINER_TASK_TRANSIENT`, `CONTAINER_IMAGE_NOT_FOUND`, `CONTAINER_IMAGE_IN_USE`, `INVALID_CONTAINER_IMAGE_REF`, `IMAGE_PULL_FAILED`, `INVALID_CONTAINER_NAME`, `INVALID_CONTAINER_MAC`, `INVALID_CONTAINER_MOUNTS`, `CONTAINER_MOUNT_DUPLICATE`, `CONTAINER_MOUNT_TYPE_MISMATCH`, `CONTAINER_ZIP_INVALID`, `CONTAINER_ZIP_UNSAFE`, `CONTAINER_MOUNT_SOURCE_MISSING`, `CONTAINER_MOUNT_SOURCE_WRONG_TYPE`, `CONTAINER_MOUNT_SOURCE_UNSAFE`, `CONTAINER_MOUNT_FILE_TOO_LARGE`, `CONTAINER_MOUNT_FILE_NOT_UTF8`, `BAD_MULTIPART_TOO_MANY_FILES`, `CONTAINERD_ERROR`, `NO_CONTAINERD`. gRPC error codes are mapped automatically: `NOT_FOUND` → `CONTAINER_NOT_FOUND`, `ALREADY_EXISTS` → `CONTAINER_EXISTS`, `UNAVAILABLE` → `NO_CONTAINERD`. Image delete remaps image `NOT_FOUND` to `CONTAINER_IMAGE_NOT_FOUND` in `containerManagerImages`.

Settings mount helpers throw: `MOUNT_NOT_FOUND`, `MOUNT_INVALID`, `MOUNT_DUPLICATE` (via `createAppError`). Disk-specific helpers throw `DISK_MOUNT_INVALID` (422) and `DISK_MOUNT_UNAVAILABLE` (503); SMB-specific helpers throw `SMB_INVALID` / `SMB_MOUNT_UNAVAILABLE` (both 503). All are returned as `{ error, detail }` by the `/api/host/mounts/*` routes.

### HTTP error responses

All API routes return errors in a consistent format:

```json
{ "error": "Human-readable message", "detail": "Raw error or more specific info" }
```

Route handlers use `handleRouteError(err, reply, request)` which maps the error `code` to an HTTP status code and formats the response.

Before sending, `handleRouteError` runs `detail` through a redactor that scrubs absolute filesystem paths (`/foo/bar/...` → `<path>`) and UUIDs to `<uuid>`, and caps the string at 500 characters. The full unredacted value (including any `err.raw` toolchain stderr) is still logged server-side via `request.log.warn` / `request.log.error`, so operators see the real diagnostic in journald. This keeps callers from leaking host layout that an authenticated admin shouldn't need to depend on.

For non-vmManager errors (e.g. settings, host), routes use `sendError(reply, status, error, detail)`.

Errors that never reach a route's own handling — raised by Fastify itself, or escaping a handler uncaught — go through the app-wide error handler (`handleUncaughtError`, installed with `setErrorHandler`), so they leave in the same shape:

| Source | Status | Response |
|--------|--------|----------|
| Request schema violation (body / params / querystring) | **400** | `{ error: "Invalid request body", detail: "body/updateChannel must be equal to one of the allowed values" }` — `error` names the part that failed |
| Other framework rejection (malformed JSON, unsupported content type, payload too large, …) | Fastify's status (400, 415, 413, …) | `{ error: <HTTP reason phrase>, detail: <Fastify's message> }` |
| Uncaught error carrying a known app `code` | Mapped status | Same as `handleRouteError` |
| Anything else (a bug, a response-serialization failure) | **500** | `{ error: "Internal error", detail: <redacted message> }`, full error logged at `error` |

Framework 4xx messages are built from Wisp's own schemas and limits, so they pass through unredacted (the path redactor would mangle `body/<field>`); the generic 500's detail goes through the same redactor as `handleRouteError`.

Unmatched routes answer `404 { error: "Not Found", detail: "Route <METHOD> <url> not found" }` under `/api` and `/ws`; in production every other unmatched path serves the SPA shell. Unmatched requests run no handler and so get no auth check (see [AUTH.md](AUTH.md) § Route access levels). The `/api` / `/ws` decision uses the request's percent-decoded path (`routePath` in `index.js`), so `/%61pi/nope` is an API miss, not a client-side route.

## Error Code to HTTP Status Mapping

The table below lists codes mapped by `handleRouteError` in `backend/src/lib/routeErrors.js` (vmManager, disks, USB routes, and other callers of that helper). Codes not listed default to **500** when passed to `handleRouteError`. **SMB:** `SMB_INVALID` and `SMB_MOUNT_UNAVAILABLE` are returned as **503** from settings/SMB routes via explicit handler logic (not only the `handleRouteError` switch).

| HTTP Status | Error Codes | Meaning |
|-------------|------------|---------|
| **400** | `BAD_MULTIPART_TOO_MANY_FILES` | Bad request — more than one file part in a container mount upload |
| **404** | `VM_NOT_FOUND`, `BACKUP_NOT_FOUND`, `CONTAINER_NOT_FOUND`, `CONTAINER_MOUNT_NOT_FOUND`, `CONTAINER_IMAGE_NOT_FOUND`, `MOUNT_NOT_FOUND`, `NETWORK_BRIDGE_NOT_FOUND` | Resource does not exist |
| **409** | `VM_ALREADY_RUNNING`, `VM_NOT_RUNNING`, `VM_NOT_PAUSED`, `VM_EXISTS`, `VM_DIR_EXISTS`, `VM_MUST_BE_OFFLINE`, `VM_BUSY`, `DISK_SLOT_IN_USE`, `BACKUP_EXISTS`, `CONTAINER_ALREADY_RUNNING`, `CONTAINER_NOT_RUNNING`, `CONTAINER_EXISTS`, `CONTAINER_MUST_BE_STOPPED`, `CONTAINER_TASK_TRANSIENT`, `CONTAINER_BUSY`, `CONTAINER_IMAGE_IN_USE`, `MOUNT_DUPLICATE`, `NETWORK_BRIDGE_EXISTS`, `NETWORK_BRIDGE_IN_USE` | State conflict — the operation is not valid for the current state |
| **422** | `PARSE_ERROR`, `RESIZE_INVALID`, `DISK_NOT_FOUND`, `RESIZE_FAILED`, `CONVERT_FAILED`, `USB_ATTACH_FAILED`, `USB_DETACH_FAILED`, `CONFIG_ERROR`, `INVALID_VM_NAME`, `INVALID_USB_ID`, `BACKUP_INVALID`, `HASH_FAILED`, `INVALID_URL`, `SSRF_BLOCKED`, `DNS_FAILED`, `DOWNLOAD_FAILED`, `NO_BODY`, `INVALID_REQUEST`, `PATH_NOT_ALLOWED`, `DISK_FORMAT_UNSUPPORTED`, `DISK_IMAGE_UNSAFE`, `PASSWORD_EMPTY`, `INVALID_PASSWORD`, `INVALID_BACKUP_SCHEDULE`, `BACKUP_DEST_UNKNOWN`, `BACKUP_DEST_NONE`, `IMAGE_PULL_FAILED`, `INVALID_CONTAINER_IMAGE_REF`, `INVALID_CONTAINER_NAME`, `INVALID_CONTAINER_MAC`, `INVALID_CONTAINER_MOUNTS`, `CONTAINER_MOUNT_DUPLICATE`, `CONTAINER_MOUNT_TYPE_MISMATCH`, `CONTAINER_ZIP_INVALID`, `CONTAINER_ZIP_UNSAFE`, `CONTAINER_MOUNT_SOURCE_MISSING`, `CONTAINER_MOUNT_SOURCE_WRONG_TYPE`, `CONTAINER_MOUNT_SOURCE_UNSAFE`, `CONTAINER_MOUNT_FILE_TOO_LARGE`, `CONTAINER_MOUNT_FILE_NOT_UTF8`, `INVALID_APP_CONFIG`, `APP_CONFIG_ONLY`, `MOUNT_INVALID`, `INVALID_NETWORK_BRIDGE_NAME`, `INVALID_NETWORK_BRIDGE_PARENT`, `INVALID_VLAN_ID` | Unprocessable — the request is structurally valid but cannot be carried out |
| **500** | `LIBVIRT_ERROR`, `DISK_INFO_FAILED`, `BACKUP_RESTORE_FAILED`, `GITHUB_API`, `NO_ASSET`, `CONTAINERD_ERROR` | Internal server error |
| **503** | `NO_CONNECTION`, `NO_CONTAINERD`, `NO_PASSWORD_CONFIGURED`, `PASSWORD_FILE_UNSUPPORTED_FORMAT`, `BACKUP_DEST_NOT_FOUND`, `BACKUP_DEST_NOT_WRITABLE`, `BACKUP_MOUNT_FAILED`, `UPDATE_CHECK_UNAVAILABLE`, `POWER_UNAVAILABLE`, `SMB_INVALID`, `SMB_MOUNT_UNAVAILABLE`, `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED`, `NETWORK_BRIDGE_UNAVAILABLE`, `NETWORK_BRIDGE_APPLY_FAILED` | Service unavailable — libvirt/containerd not connected, backup destination not accessible, host update/power scripts missing, SMB/mount issues, managed bridge helper/netplan failures, etc. |

Any unrecognized error code passed to `handleRouteError` defaults to **500**.

Server errors (status >= 500) are logged with full context (message, code, detail) via the request logger.

## SSE Error Payloads

### Long-lived streams (VM list, VM stats, host stats, etc.)

On failure, these streams may emit a JSON object that includes an `error` field:

```json
{ "error": "message", "detail": "raw detail", "code": "ERROR_CODE" }
```

The frontend distinguishes normal data events from error events by checking for the `error` property. On the `/api/events` topics an error frame is ignored and the store keeps its last good payload (host stats, VM/container lists, sections, home, backups status) — consumers dereference the payload's fields, so storing the error object in its place would crash the render.

### Job progress streams (VM create, backup, library download)

Progress uses `step` on every event. **Failures** use the shared job-store terminal shape (no top-level `code`):

```json
{ "step": "error", "error": "message", "detail": "raw detail" }
```

The stream closes after that event. **Successful completion** uses `{ "step": "done", ...fields }` where the extra fields depend on the job (see [API.md](API.md) job SSE sections). `done` and `error` are the only terminal steps — clients close on either — so intermediate milestones use their own step names (e.g. a multi-destination backup's `destination-done`).

## Authentication Errors

| Scenario | Status | Response |
|----------|--------|----------|
| Missing token | 401 | `{ error: "Authentication required", detail: "Missing or malformed Authorization header" }` |
| Invalid/expired token | 401 | `{ error: "Authentication failed", detail: "Invalid or expired token" }` |
| Wrong password (login) | 401 | `{ error: "Invalid password", detail: "The provided password is incorrect" }` |
| Wrong current password (change-password) | 422 | `INVALID_PASSWORD` — `{ error: "Current password is incorrect", detail: … }` |
| Rate limited (login) | 429 | `{ error: "Too many login attempts", detail: "Try again after 60 seconds" }` |

**401 means "no or expired session" — nothing else.** The frontend logs every tab out on any 401 from an authenticated route, so a route that rejects a *request* while the session is fine (wrong current password on change-password) answers 422. Login keeps 401 for a wrong password: the login page posts with a bare `fetch`, never through the shared client.

Login rate limiting: 5 failed attempts per IP within a 60-second window. The map is swept every 60 s for expired entries and capped at 10 000 distinct IPs.

`PASSWORD_FILE_UNSUPPORTED_FORMAT` (503) is returned by login when `config/wisp-password` exists but isn't in the expected `scrypt:salt:hash` shape — run `wispctl password` to repair. `NO_PASSWORD_CONFIGURED` (503) is returned when the file is missing.

## Frontend Error Display

The frontend uses several patterns for displaying errors to the user:

### Error bar

A persistent red bar below the VM header. Visible on both Overview and Console tabs. Used for VM action failures (start, stop, save, etc.). Remains until the user dismisses it or starts another VM header action—the store clears the error when that new action **begins**, not only after it succeeds (so errors are not auto-dismissed solely because some other operation later succeeds).

### Inline errors

Red error text displayed within a section card. Used for per-section save failures. Shows the `error` message with optional expandable `detail`.

### Job progress errors

For async operations (VM creation, backup, download), errors appear inline in the progress area. The progress display shows the error message with a red indicator and optionally exposes the raw detail.

### Global 401 handling

The frontend API client (`api()` in `api/client.js`) intercepts all 401 responses. On receiving a 401:
1. Write the `wisp_logout` localStorage signal so other tabs bounce too
2. Redirect to `/login`

This is automatic and applies to all API calls, handling session expiry and password changes from another device. Because it logs every tab out, the backend sends 401 only for a missing/expired session (see Authentication Errors).

### Render errors

A render throw anywhere in the tree lands in the top-level `AppErrorBoundary` (wraps the router in `main.jsx`), which replaces the page with a recovery card and a **Reload** button instead of unmounting to a blank page. See [UI.md](UI.md) § Render Error Screen. It is a last resort — data errors are still handled where they occur (store guards, inline errors).

### Stale responses for a previous selection

Selecting a VM or container fetches its config asynchronously. The stores (`vmStore`, `containerStore`) bump a selection sequence number on every selection change (select, deselect, rename-follow) and drop any `getVM` / `getContainer` response — success or error — that comes back after the selection changed, so a slow response for the previously-selected workload never overwrites the current one. The same newest-request-wins guard applies to the container Logs run list and to the Image Library's per-filter list fetch.

## Validation Errors

### VM name validation

VM names are validated before route handlers execute (via a `preHandler` hook). Invalid names receive a 422 response with code `INVALID_VM_NAME`.

### Path policy for VM disks / ISOs

`assertPathInsideAllowedRoots(absPath, vmName)` is invoked by attach/create paths (CDROM, ISO, sourcePath). Any path that resolves outside the image library or the VM's per-VM directory returns **422 PATH_NOT_ALLOWED**.

### Request body validation

Routes use schema validation. Invalid request bodies (and params / querystrings) are rejected by the framework with **400** `{ error, detail }` before the handler is reached — see the error-handler table under HTTP error responses. 400 is deliberate, not 422: it is the framework's verdict on the request's shape, while 422 stays for a well-formed request the handler cannot carry out.

### Filename validation

Library file operations validate filenames: no path separators (`/`, `\`), no `..`, no leading dots, and the filename must equal its `basename()`.

## Backend Error Logging

- Server errors (status >= 500) are logged with `request.log.error()`
- Client errors (4xx) are not logged by default
- Background job failures are logged by the job store at **warn** (`Background job failed` with `code` and message). The job's own failure path adds a `log.error()` with the full error/stack only for unexpected failures — not for known app codes that map to 4xx (`isExpectedAppError` in `lib/routeErrors.js`, e.g. a `VM_MUST_BE_OFFLINE` or `VM_BUSY` that a race let past the route's pre-check)
- DBus connection errors are logged and trigger automatic reconnection with backoff (see VM-MANAGEMENT.md); stream write errors (disk full, name collision) fail the job — never the process
