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

Container manager functions use the same structured error shape via `containerError(code, message, raw)` (which calls `createAppError` internally). Container-specific codes include: `CONTAINER_NOT_FOUND`, `CONTAINER_MOUNT_NOT_FOUND`, `CONTAINER_ALREADY_RUNNING`, `CONTAINER_NOT_RUNNING`, `CONTAINER_EXISTS`, `CONTAINER_MUST_BE_STOPPED`, `CONTAINER_IMAGE_NOT_FOUND`, `CONTAINER_IMAGE_IN_USE`, `INVALID_CONTAINER_IMAGE_REF`, `IMAGE_PULL_FAILED`, `INVALID_CONTAINER_NAME`, `INVALID_CONTAINER_MAC`, `INVALID_CONTAINER_MOUNTS`, `CONTAINER_MOUNT_DUPLICATE`, `CONTAINER_MOUNT_TYPE_MISMATCH`, `CONTAINER_ZIP_INVALID`, `CONTAINER_ZIP_UNSAFE`, `CONTAINER_MOUNT_SOURCE_MISSING`, `CONTAINER_MOUNT_SOURCE_WRONG_TYPE`, `CONTAINER_MOUNT_SOURCE_UNSAFE`, `CONTAINER_MOUNT_FILE_TOO_LARGE`, `CONTAINER_MOUNT_FILE_NOT_UTF8`, `BAD_MULTIPART_TOO_MANY_FILES`, `CONTAINERD_ERROR`, `NO_CONTAINERD`. gRPC error codes are mapped automatically: `NOT_FOUND` → `CONTAINER_NOT_FOUND`, `ALREADY_EXISTS` → `CONTAINER_EXISTS`, `UNAVAILABLE` → `NO_CONTAINERD`. Image delete remaps image `NOT_FOUND` to `CONTAINER_IMAGE_NOT_FOUND` in `containerManagerImages`.

Settings mount helpers throw: `MOUNT_NOT_FOUND`, `MOUNT_INVALID`, `MOUNT_DUPLICATE` (via `createAppError`). Disk-specific helpers throw `DISK_MOUNT_INVALID` (422) and `DISK_MOUNT_UNAVAILABLE` (503); SMB-specific helpers throw `SMB_INVALID` / `SMB_MOUNT_UNAVAILABLE` (both 503). All are returned as `{ error, detail }` by the `/api/host/mounts/*` routes.

### HTTP error responses

All API routes return errors in a consistent format:

```json
{ "error": "Human-readable message", "detail": "Raw error or more specific info" }
```

Route handlers use `handleRouteError(err, reply, request)` which maps the error `code` to an HTTP status code and formats the response.

For non-vmManager errors (e.g. settings, host), routes use `sendError(reply, status, error, detail)`.

## Error Code to HTTP Status Mapping

The table below lists codes mapped by `handleRouteError` in `backend/src/lib/routeErrors.js` (vmManager, disks, USB routes, and other callers of that helper). Codes not listed default to **500** when passed to `handleRouteError`. **SMB:** `SMB_INVALID` and `SMB_MOUNT_UNAVAILABLE` are returned as **503** from settings/SMB routes via explicit handler logic (not only the `handleRouteError` switch).

| HTTP Status | Error Codes | Meaning |
|-------------|------------|---------|
| **400** | `BAD_MULTIPART_TOO_MANY_FILES` | Bad request — more than one file part in a container mount upload |
| **404** | `VM_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`, `BACKUP_NOT_FOUND`, `CONTAINER_NOT_FOUND`, `CONTAINER_MOUNT_NOT_FOUND`, `CONTAINER_IMAGE_NOT_FOUND`, `MOUNT_NOT_FOUND`, `NETWORK_BRIDGE_NOT_FOUND` | Resource does not exist |
| **409** | `VM_ALREADY_RUNNING`, `VM_NOT_RUNNING`, `VM_NOT_PAUSED`, `VM_RUNNING`, `VM_EXISTS`, `VM_MUST_BE_OFFLINE`, `CONTAINER_ALREADY_RUNNING`, `CONTAINER_NOT_RUNNING`, `CONTAINER_EXISTS`, `CONTAINER_MUST_BE_STOPPED`, `CONTAINER_IMAGE_IN_USE`, `MOUNT_DUPLICATE`, `NETWORK_BRIDGE_EXISTS`, `NETWORK_BRIDGE_IN_USE` | State conflict — the operation is not valid for the current state |
| **422** | `PARSE_ERROR`, `CLONE_FAILED`, `RESIZE_INVALID`, `DISK_NOT_FOUND`, `RESIZE_FAILED`, `CONVERT_FAILED`, `USB_ATTACH_FAILED`, `USB_DETACH_FAILED`, `SNAPSHOT_CREATE_FAILED`, `SNAPSHOT_REVERT_FAILED`, `SNAPSHOT_DELETE_FAILED`, `CONFIG_ERROR`, `INVALID_VM_NAME`, `INVALID_USB_ID`, `BACKUP_INVALID`, `HASH_FAILED`, `INVALID_URL`, `SSRF_BLOCKED`, `DNS_FAILED`, `DOWNLOAD_FAILED`, `NO_BODY`, `INVALID_REQUEST`, `IMAGE_PULL_FAILED`, `INVALID_CONTAINER_IMAGE_REF`, `INVALID_CONTAINER_NAME`, `INVALID_CONTAINER_MAC`, `INVALID_CONTAINER_MOUNTS`, `CONTAINER_MOUNT_DUPLICATE`, `CONTAINER_MOUNT_TYPE_MISMATCH`, `CONTAINER_ZIP_INVALID`, `CONTAINER_ZIP_UNSAFE`, `CONTAINER_MOUNT_SOURCE_MISSING`, `CONTAINER_MOUNT_SOURCE_WRONG_TYPE`, `CONTAINER_MOUNT_SOURCE_UNSAFE`, `CONTAINER_MOUNT_FILE_TOO_LARGE`, `CONTAINER_MOUNT_FILE_NOT_UTF8`, `MOUNT_INVALID`, `INVALID_NETWORK_BRIDGE_NAME`, `INVALID_NETWORK_BRIDGE_PARENT`, `INVALID_VLAN_ID` | Unprocessable — the request is structurally valid but cannot be carried out |
| **500** | `LIBVIRT_ERROR`, `DISK_INFO_FAILED`, `BACKUP_RESTORE_FAILED`, `GITHUB_API`, `NO_ASSET`, `CONTAINERD_ERROR` | Internal server error |
| **503** | `NO_CONNECTION`, `NO_CONTAINERD`, `BACKUP_DEST_NOT_FOUND`, `BACKUP_DEST_NOT_WRITABLE`, `UPDATE_CHECK_UNAVAILABLE`, `POWER_UNAVAILABLE`, `SMB_INVALID`, `SMB_MOUNT_UNAVAILABLE`, `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED`, `NETWORK_BRIDGE_UNAVAILABLE`, `NETWORK_BRIDGE_APPLY_FAILED` | Service unavailable — libvirt/containerd not connected, backup destination not accessible, host update/power scripts missing, SMB/mount issues, managed bridge helper/netplan failures, etc. |

Any unrecognized error code passed to `handleRouteError` defaults to **500**.

Server errors (status >= 500) are logged with full context (message, code, detail) via the request logger.

## SSE Error Payloads

### Long-lived streams (VM list, VM stats, host stats, etc.)

On failure, these streams may emit a JSON object that includes an `error` field:

```json
{ "error": "message", "detail": "raw detail", "code": "ERROR_CODE" }
```

The frontend distinguishes normal data events from error events by checking for the `error` property.

### Job progress streams (VM create, backup, library download)

Progress uses `step` on every event. **Failures** use the shared job-store terminal shape (no top-level `code`):

```json
{ "step": "error", "error": "message", "detail": "raw detail" }
```

The stream closes after that event. **Successful completion** uses `{ "step": "done", ...fields }` where the extra fields depend on the job (see [API.md](API.md) job SSE sections).

## Authentication Errors

| Scenario | Status | Response |
|----------|--------|----------|
| Missing token | 401 | `{ error: "Authentication required", detail: "Missing or malformed Authorization header" }` |
| Invalid/expired token | 401 | `{ error: "Authentication failed", detail: "Invalid or expired token" }` |
| Wrong password (login) | 401 | `{ error: "Invalid password", detail: "The provided password is incorrect" }` |
| Rate limited (login) | 429 | `{ error: "Too many login attempts", detail: "Try again after 60 seconds" }` |

Login rate limiting: 5 failed attempts per IP within a 60-second window.

## Frontend Error Display

The frontend uses several patterns for displaying errors to the user:

### Error bar

A persistent red bar below the VM header. Visible on both Overview and Console tabs. Used for VM action failures (start, stop, save, etc.). Remains until the user dismisses it or starts another VM header action—the store clears the error when that new action **begins**, not only after it succeeds (so errors are not auto-dismissed solely because some other operation later succeeds).

### Inline errors

Red error text displayed within a section card. Used for per-section save failures. Shows the `error` message with optional expandable `detail`.

### Job progress errors

For async operations (VM creation, backup, download), errors appear inline in the progress area. The progress display shows the error message with a red indicator and optionally exposes the raw detail.

### Global 401 handling

The frontend API client intercepts all 401 responses. On receiving a 401:
1. Clear the stored JWT from localStorage
2. Redirect to `/login`

This is automatic and applies to all API calls, handling token expiry and password changes.

## Validation Errors

### VM name validation

VM names are validated before route handlers execute (via a `preHandler` hook). Invalid names receive a 422 response with code `INVALID_VM_NAME`.

### Request body validation

Routes use schema validation. Invalid request bodies are rejected by the framework with a 400 status code before the handler is reached.

### Filename validation

Library file operations validate filenames: no path separators (`/`, `\`), no `..`, no leading dots, and the filename must equal its `basename()`.

## Backend Error Logging

- Server errors (status >= 500) are logged with `request.log.error()`
- Client errors (4xx) are not logged by default
- Background job failures (create, backup) are logged with `request.log.error()` at the job level
- DBus connection errors are logged to console and trigger automatic reconnection
