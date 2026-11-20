# Error Handling

One error path across the stack (settled 2026-11-20): code throws structured errors, one
handler answers them, one table gives each code its status, and every channel that
carries an error to a client sends the same body. The client has one error object and one
way to show it.

## The error body

Every error a client receives is

```json
{ "error": "VM_NOT_FOUND", "detail": "VM \"web\" not found" }
```

- **`error`** is the stable code: always there, always one of the [codes](#codes) below. A
  client branches on it, never on the text.
- **`detail`** is the human-readable message, always there: the error's message, followed
  by its raw cause when it has one that the message does not already say (`Failed to
  resize disk: qemu-img: …`). There is no third key.

**Every channel** sends this body:

| Channel | Where the body goes |
|---------|---------------------|
| HTTP | The answer's body, with the status the code maps to |
| A job's error event | `{ "step": "error", "error", "detail" }`, the last event of the job's stream ([API.md → Background jobs](API.md#background-jobs)) |
| A stream's error frame | The frame's payload: the `data` of an `/api/events` topic frame, or the `data:` line of a scoped stream (stats, logs, disks, USB) |
| MCP | A failed tool call: `isError: true`, the body as its JSON text and as `structuredContent` ([MCP.md](MCP.md)) |

JSON-RPC protocol errors on `/mcp` (a malformed message, an unknown method or tool) keep
JSON-RPC's own `{ code, message }`: that shape is the protocol's contract, not Wisp's.

**Redaction happens in one place**, where the body is built, so it covers every channel:
absolute filesystem paths become `<path>` and UUIDs `<uuid>`, and the detail is capped at
500 characters. A path counts only where it starts a token (at the start, after
whitespace, a quote, a bracket, `=` or `,`), so an image reference
(`docker.io/library/nginx:1.27`), a URL or `body/field` passes untouched, and so do
Wisp's own URL paths (`/api/…`, `/ws/…`, `/mcp`), which are not host layout. The server
log keeps the unredacted error.

## Where errors come from

- Code throws structured errors: `createAppError(code, message, raw?)` in
  `lib/appErrors.js`, or a manager's private factory (`vmError`, `containerError`), which
  build the same shape (CODING-RULES §5). `raw` holds a toolchain's or daemon's own text.
- **Routes throw; one handler answers.** No route builds an error body or picks a status.
  Fastify's error handler (`handleRequestError`) answers every error that leaves a
  handler or a hook, and every refusal of the framework itself (a schema violation, a body
  too large, an unknown route).
- **One table** maps each code to its status: `ERROR_STATUS` in `lib/errorCodes.js`. An
  error without a code from the table (a bug, a Node errno) answers **500**
  `INTERNAL_ERROR`, its message as the detail.
- `npm run check` (`scripts/check-error-codes.mjs`) holds the code, the table and this
  document in step: it fails when the code throws a code the table lacks, when the table
  holds a code nothing throws, and when the table and the list below disagree.

### Framework refusals

| Refusal | Code |
|---------|------|
| A request that fails its schema (body, params, querystring) | **400** `VALIDATION_FAILED`, the detail naming the part and the field (`body/vlanId must be number`; an unknown key: `body: unknown key "foo"`) |
| Malformed JSON, an empty JSON body, bad percent-encoding | **400** `BAD_REQUEST` |
| No route for the method and path | **404** `ROUTE_NOT_FOUND` |
| A body over its limit | **413** `PAYLOAD_TOO_LARGE`; an upload over the multipart file limit is **422** `UPLOAD_TOO_LARGE` |
| An over-long URL or route parameter | **414** `URI_TOO_LONG` |
| An unsupported content type, or a multipart route sent something else | **415** `UNSUPPORTED_MEDIA_TYPE` |

400 is deliberate, not 422: it is the framework's verdict on the request's shape, while
422 stays for a well-formed request that cannot be carried out.

Unmatched routes answer `ROUTE_NOT_FOUND` under `/api`, `/ws`, `/assets/` and `/vendor/`;
in production every other unmatched path serves the SPA shell. Unmatched requests run no
handler and so get no auth check (see [AUTH.md](AUTH.md) § Route access levels). The
decision uses the request's percent-decoded path (`routePath` in `app.js`), so
`/%61pi/nope` is an API miss, not a client-side route.

### Authentication

| Scenario | Code |
|----------|------|
| No session cookie, or no bearer token on `/mcp` | **401** `AUTH_REQUIRED` |
| An invalid or expired session, or an unknown bearer token | **401** `AUTH_INVALID` |
| A bearer token on a `session` route | **403** `SESSION_REQUIRED` |
| A `read` token on an `admin` route or tool | **403** `SCOPE_INSUFFICIENT` |
| A state-changing request whose CSRF header is missing or wrong | **403** `CSRF_FAILED` |
| Wrong password at login | **401** `LOGIN_FAILED` |
| Wrong current password on change-password | **422** `INVALID_PASSWORD` |
| Too many failed logins, password changes or bearer attempts | **429** `RATE_LIMITED` |

On `/mcp`, both 401s carry `WWW-Authenticate: Bearer realm="wisp"`.

**401 means "no or expired session", nothing else.** The client recognises a lost
session by `AUTH_REQUIRED` or `AUTH_INVALID` and logs every tab out, so a route that
rejects a *request* while the session is fine (a wrong current password on
change-password) answers 422. Login keeps 401 for a wrong password (`LOGIN_FAILED`): the
login page posts with a bare `fetch`, never through the shared client.

Login rate limiting: 5 failed attempts per IP within a 60-second window. The map is swept
every 60 s for expired entries and capped at 10 000 distinct IPs.

A `config/wisp-password` that exists but isn't in the expected `scrypt:salt:hash` shape,
or can't be read, stops the backend at startup (settled 2026-11-12,
[CONFIGURATION.md](CONFIGURATION.md#password-storage)). The file is read on each use, so
one broken while Wisp runs answers 503: `PASSWORD_FILE_UNSUPPORTED_FORMAT` for the shape,
`PASSWORD_FILE_UNREADABLE` for a read failure — run `wispctl password` to repair.
`NO_PASSWORD_CONFIGURED` (503) is returned when the file is missing.

`CONFIG_INVALID` is the strict config read's error
([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)), its message naming
the key. At startup it stops the boot; a `wisp-config.json` edited into an invalid state
while Wisp runs makes settings reads and writes answer it as **500** (the file, not the
request, is wrong) until it is fixed.

### containerd reachability

gRPC errors are mapped by containerManager: `NOT_FOUND` → `CONTAINER_NOT_FOUND`,
`ALREADY_EXISTS` → `CONTAINER_EXISTS`, `UNAVAILABLE` → `NO_CONTAINERD`, anything else
`CONTAINERD_ERROR`. A check that a name is free (create, rename, restore as new) or that
an image is local counts only `CONTAINER_NOT_FOUND` as "absent", never an unreachable
containerd (`NO_CONTAINERD`) or one that accepts the call but does not answer in time
(`CONTAINERD_ERROR`) (settled 2026-11-18). The name checks run before any work starts, so
the request answers 503 `NO_CONTAINERD` (or 500 `CONTAINERD_ERROR`) and nothing is
written. The image check runs inside the create and restore jobs, which end with that
code; the image `PATCH` and MCP `update_container_image` answer it directly; the
image-update sweep marks that image skipped and goes on. Image delete remaps image
`NOT_FOUND` to `CONTAINER_IMAGE_NOT_FOUND`.

## Codes

Each code a client can receive, with its status.

| Code | Status | Meaning |
|------|--------|---------|
| `VALIDATION_FAILED` | 400 | The request fails its schema; the detail names the part and the field |
| `BAD_REQUEST` | 400 | Malformed JSON, an empty JSON body, or a malformed URL |
| `UPLOAD_NO_FILE` | 400 | An upload request carries no file part |
| `BAD_MULTIPART_TOO_MANY_FILES` | 400 | More than one file part in a container mount upload |
| `AUTH_REQUIRED` | 401 | No session cookie, or no bearer token on `/mcp` |
| `AUTH_INVALID` | 401 | The session is invalid or expired, or the bearer token is unknown |
| `LOGIN_FAILED` | 401 | Wrong password at login |
| `SESSION_REQUIRED` | 403 | An API token on a route only a browser session may call |
| `SCOPE_INSUFFICIENT` | 403 | A `read` token on an `admin` route or MCP tool |
| `CSRF_FAILED` | 403 | A state-changing request without the matching CSRF header |
| `OIDC_SESSION_ONLY` | 403 | An `oidc` key in `PATCH /api/settings`: SSO settings change only through the session route |
| `CONTAINER_MOUNT_SECRET` | 403 | Raw content of a secret file mount was asked for |
| `ROUTE_NOT_FOUND` | 404 | No route for the method and path |
| `JOB_NOT_FOUND` | 404 | No such job: it never started, or ended more than 5 minutes ago |
| `VM_NOT_FOUND` | 404 | No VM by that name |
| `BACKUP_NOT_FOUND` | 404 | No such backup |
| `CONTAINER_NOT_FOUND` | 404 | No container by that name |
| `CONTAINER_MOUNT_NOT_FOUND` | 404 | The container has no mount by that name |
| `CONTAINER_SERVICE_NOT_FOUND` | 404 | The container has no such mDNS service |
| `CONTAINER_IMAGE_NOT_FOUND` | 404 | The image is not in containerd |
| `CONTAINER_RUN_NOT_FOUND` | 404 | The container has no run by that id |
| `LIBRARY_FILE_NOT_FOUND` | 404 | The image library has no file by that name |
| `MOUNT_NOT_FOUND` | 404 | No host mount with that id |
| `NETWORK_BRIDGE_NOT_FOUND` | 404 | No managed bridge by that name |
| `SECTION_NOT_FOUND` | 404 | No sidebar section with that id |
| `HOME_NOT_FOUND` | 404 | No home-page group or tile with that id |
| `TOKEN_NOT_FOUND` | 404 | No API token with that id |
| `GITHUB_KEYS_NOT_FOUND` | 404 | GitHub has no public keys for that user |
| `METHOD_NOT_ALLOWED` | 405 | The path takes another method (`GET` or `DELETE /mcp`) |
| `PAYLOAD_TOO_LARGE` | 413 | The body, or the multipart parts, exceed their limit |
| `URI_TOO_LONG` | 414 | The URL or a route parameter is too long |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | A content type the route does not take |
| `VM_ALREADY_RUNNING` | 409 | The VM is already running |
| `VM_NOT_RUNNING` | 409 | The VM is not running |
| `VM_NOT_PAUSED` | 409 | The VM is not paused |
| `VM_EXISTS` | 409 | A VM by that name exists |
| `VM_DIR_EXISTS` | 409 | A directory for that VM name exists on disk |
| `VM_MUST_BE_OFFLINE` | 409 | The operation needs the VM stopped |
| `VM_BUSY` | 409 | Another operation holds the VM's [operation lock](BACKUPS.md#per-vm-operation-lock); the detail names it |
| `DISK_SLOT_IN_USE` | 409 | The disk slot is taken |
| `BACKUP_EXISTS` | 409 | A backup with that timestamp exists |
| `CONTAINER_ALREADY_RUNNING` | 409 | The container is already running |
| `CONTAINER_NOT_RUNNING` | 409 | The container is not running |
| `CONTAINER_EXISTS` | 409 | A container by that name exists |
| `CONTAINER_MUST_BE_STOPPED` | 409 | The operation needs the container stopped |
| `CONTAINER_TASK_TRANSIENT` | 409 | The container's task is between states; retry |
| `CONTAINER_BUSY` | 409 | Another operation holds the container's [operation lock](CONTAINERS.md#per-container-operation-lock); the detail names it |
| `CONTAINER_IMAGE_IN_USE` | 409 | A container uses the image |
| `CONTAINER_SERVICE_DUPLICATE` | 409 | The container already has that mDNS service |
| `CONTAINER_LOCAL_DNS_DISABLED` | 409 | mDNS services need the container's Local DNS on |
| `LIBRARY_FILE_EXISTS` | 409 | The image library has a file by that name |
| `LIBRARY_FILE_IN_USE` | 409 | VMs use the library file; the detail names them |
| `MOUNT_DUPLICATE` | 409 | A host mount with that path or id exists |
| `MOUNT_IN_USE` | 409 | Containers use the host mount; the detail names them |
| `MOUNT_NOT_MOUNTED` | 409 | The host mount is not mounted |
| `NETWORK_BRIDGE_EXISTS` | 409 | A bridge by that name exists |
| `NETWORK_BRIDGE_IN_USE` | 409 | Workloads use the bridge |
| `SECTION_DUPLICATE` | 409 | A sidebar section by that name exists |
| `HOME_DUPLICATE` | 409 | A home-page group or tile like it exists |
| `UPDATE_BUSY` | 409 | An OS update check or upgrade runs, or the package manager is locked |
| `UPDATE_NOT_AVAILABLE` | 409 | No Wisp update is available to install |
| `UPDATE_JOBS_ACTIVE` | 409 | Other jobs run; the Wisp update install waits for them unless forced |
| `UPDATE_INSTALL_IN_PROGRESS` | 409 | A Wisp update install was already started |
| `INVALID_REQUEST` | 422 | The request is well-formed but its values contradict each other or the state |
| `PARSE_ERROR` | 422 | A definition or file could not be parsed |
| `CONFIG_ERROR` | 422 | The workload configuration change is invalid |
| `RESIZE_INVALID` | 422 | The new disk size is invalid (smaller than the current one) |
| `RESIZE_FAILED` | 422 | The disk resize failed |
| `CONVERT_FAILED` | 422 | The disk image conversion failed |
| `DISK_NOT_FOUND` | 422 | The VM has no disk in that slot, or the image file is missing |
| `DISK_FORMAT_UNSUPPORTED` | 422 | The disk image format is not supported |
| `DISK_IMAGE_UNSAFE` | 422 | The disk image has a backing file or data file outside the allowed roots |
| `USB_ATTACH_FAILED` | 422 | The USB device could not be attached |
| `USB_DETACH_FAILED` | 422 | The USB device could not be detached |
| `INVALID_VM_NAME` | 422 | The VM name breaks the [name rules](#vm-name-validation) |
| `INVALID_USB_ID` | 422 | The USB device id is malformed |
| `PATH_NOT_ALLOWED` | 422 | The path resolves outside the image library and the VM's directory |
| `BACKUP_INVALID` | 422 | The backup archive or manifest fails validation |
| `BACKUP_DEST_UNKNOWN` | 422 | An unknown backup destination id |
| `BACKUP_DEST_NONE` | 422 | No backup destination was given or configured |
| `HASH_FAILED` | 422 | The password could not be hashed for cloud-init |
| `INVALID_URL` | 422 | The URL is not an HTTP or HTTPS URL |
| `SSRF_BLOCKED` | 422 | The URL resolves to a private, loopback or reserved address, or redirects too often |
| `DNS_FAILED` | 422 | The URL's host does not resolve |
| `DOWNLOAD_FAILED` | 422 | The download failed |
| `NO_BODY` | 422 | The download answered without a body |
| `UPLOAD_TOO_LARGE` | 422 | The upload exceeds its size limit |
| `INVALID_FILENAME` | 422 | The file name breaks the [file name rules](#filename-validation) |
| `PASSWORD_EMPTY` | 422 | The new password is empty |
| `INVALID_PASSWORD` | 422 | The current password is wrong on change-password |
| `INVALID_OIDC` | 422 | The SSO settings are incomplete or invalid |
| `INVALID_BACKUP_SCHEDULE` | 422 | The backup schedule is invalid |
| `INVALID_SETTINGS` | 422 | A settings value is invalid |
| `TOKEN_INVALID` | 422 | The API token request is invalid (label, scope) |
| `INVALID_APP_CONFIG` | 422 | The app container's configuration is invalid |
| `APP_CONFIG_ONLY` | 422 | An app container is configured through its app config, not this field or mount |
| `APP_RELOAD_FAILED` | 422 | The app refused its new configuration on reload |
| `UNKNOWN_APP_TYPE` | 422 | No app type by that name |
| `INVALID_CONTAINER_IMAGE_REF` | 422 | The image reference is malformed |
| `IMAGE_PULL_FAILED` | 422 | The image could not be pulled |
| `INVALID_CONTAINER_NAME` | 422 | The container name breaks the name rules |
| `INVALID_CONTAINER_MAC` | 422 | The MAC address is malformed |
| `INVALID_CONTAINER_MOUNTS` | 422 | A mount's shape is invalid |
| `INVALID_CONTAINER_SERVICE` | 422 | An mDNS service's shape is invalid |
| `INVALID_CONTAINER_DEVICES` | 422 | A device passthrough entry is invalid |
| `CONTAINER_MOUNT_DUPLICATE` | 422 | Two mounts share a name or a container path |
| `CONTAINER_MOUNT_TYPE_MISMATCH` | 422 | The operation does not apply to this mount's type |
| `CONTAINER_ZIP_INVALID` | 422 | The upload is not a readable zip |
| `CONTAINER_ZIP_UNSAFE` | 422 | The zip holds entries that would land outside the mount |
| `CONTAINER_MOUNT_SOURCE_MISSING` | 422 | The mount's host source does not exist |
| `CONTAINER_MOUNT_SOURCE_WRONG_TYPE` | 422 | The mount's host source is not the expected file or directory |
| `CONTAINER_MOUNT_SOURCE_UNSAFE` | 422 | The mount's host source resolves outside its storage |
| `CONTAINER_MOUNT_FILE_TOO_LARGE` | 422 | The mount file exceeds the content cap |
| `CONTAINER_MOUNT_FILE_NOT_UTF8` | 422 | The mount file is not UTF-8 text |
| `MOUNT_INVALID` | 422 | The host mount's settings are invalid |
| `DISK_MOUNT_INVALID` | 422 | The removable disk mount's settings are invalid |
| `SMB_INVALID` | 422 | The SMB share's settings are invalid |
| `INVALID_NETWORK_BRIDGE_NAME` | 422 | The bridge name is invalid |
| `INVALID_NETWORK_BRIDGE_PARENT` | 422 | The bridge's parent interface is invalid |
| `INVALID_VLAN_ID` | 422 | The VLAN id is out of range |
| `SECTION_INVALID` | 422 | The sidebar section or assignment is invalid |
| `HOME_INVALID` | 422 | The home-page group or tile is invalid |
| `RATE_LIMITED` | 429 | Too many attempts from this address; the detail says when to retry |
| `INTERNAL_ERROR` | 500 | An error without a code: a fault on the server |
| `CONFIG_INVALID` | 500 | `wisp-config.json` fails its strict read |
| `LIBVIRT_ERROR` | 500 | libvirt refused or failed the call |
| `CONTAINERD_ERROR` | 500 | containerd failed the call, or did not answer in time |
| `DISK_INFO_FAILED` | 500 | The disk image could not be inspected |
| `NVRAM_COPY_FAILED` | 500 | The VM's UEFI NVRAM could not be copied |
| `BACKUP_FAILED` | 500 | The backup failed |
| `BACKUP_RESTORE_FAILED` | 500 | The restore failed |
| `CONTAINER_ZIP_EXTRACT_TIMEOUT` | 500 | The zip extract was stopped at its bound |
| `LIBRARY_IO_FAILED` | 500 | A read or write in the image library failed |
| `GITHUB_API` | 500 | GitHub's release API answered wrongly |
| `NO_ASSET` | 500 | The release has no tarball asset |
| `GITHUB_KEYS_UNAVAILABLE` | 502 | GitHub could not be asked for the user's keys |
| `NO_CONNECTION` | 503 | libvirt is not connected |
| `NO_CONTAINERD` | 503 | containerd is not reachable |
| `NO_PASSWORD_CONFIGURED` | 503 | `config/wisp-password` is missing |
| `PASSWORD_FILE_UNSUPPORTED_FORMAT` | 503 | `config/wisp-password` is not in the `scrypt:salt:hash` shape |
| `PASSWORD_FILE_UNREADABLE` | 503 | `config/wisp-password` cannot be read |
| `BACKUP_DEST_NOT_FOUND` | 503 | The backup destination's path does not exist |
| `BACKUP_DEST_NOT_WRITABLE` | 503 | The backup destination cannot be written |
| `BACKUP_MOUNT_FAILED` | 503 | The backup destination's mount could not be mounted |
| `UPDATE_CHECK_UNAVAILABLE` | 503 | The OS update helper is missing, failed, or went silent past its bound |
| `POWER_UNAVAILABLE` | 503 | The host power helper is missing or failed |
| `SMB_MOUNT_UNAVAILABLE` | 503 | The SMB share could not be mounted or reached |
| `DISK_MOUNT_UNAVAILABLE` | 503 | The removable disk could not be mounted or unmounted |
| `CONTAINER_MOUNT_SOURCE_NOT_MOUNTED` | 503 | The host mount behind a container mount is not mounted |
| `CONTAINER_DEVICE_MISSING` | 503 | A passthrough device is not present on the host |
| `CONTAINER_NETWORK_SETUP_FAILED` | 503 | The container's network could not be set up |
| `NETWORK_BRIDGE_UNAVAILABLE` | 503 | Managed bridges are not available on this host (no netplan, or the helper is missing) |
| `NETWORK_BRIDGE_NONE` | 503 | The host has no bridge for a new VM's NIC: setup was never finished |
| `NETWORK_BRIDGE_APPLY_FAILED` | 503 | netplan failed to apply the bridge change |

### Internal codes

Thrown, but never sent to a client: each is caught where it is thrown, or stops the start
before the port opens.

| Code | Status | Where it ends |
|------|--------|---------------|
| `ABORT_ERR` | — | An OS update step stopped by its caller |
| `AVAHI_TIMEOUT` | — | An avahi call past its bound; logged and retried by the reconcilers |
| `OIDC_CALLBACK_INVALID` | — | The OIDC callback, which redirects to `/login?sso=error` and logs it |
| `OIDC_DISCOVERY_FAILED` | — | The same |
| `OIDC_JWKS_FAILED` | — | The same |
| `OIDC_PROVIDER_UNREACHABLE` | — | The same |
| `OIDC_STATE_INVALID` | — | The same |
| `OIDC_TOKEN_EXCHANGE_FAILED` | — | The same |
| `OIDC_TOKEN_INVALID` | — | The same |
| `SMART_DEVICE_NOT_FOUND` | — | A disk's SMART read, which reports it as `smart.error` in the hardware inventory |
| `SMART_EMPTY_OUTPUT` | — | The same |
| `SMART_HELPER_UNAVAILABLE` | — | The same |
| `SMART_INVALID_DISK_NAME` | — | The same |
| `SMART_INVALID_JSON` | — | The same |
| `SMART_NOT_INSTALLED` | — | The same |
| `RUNTIME_ENV_INVALID` | — | The start: `config/runtime.env` fails its strict read |
| `DEFAULT_BRIDGE_INVALID` | — | The start: `WISP_DEFAULT_BRIDGE` names no host bridge |
| `MIGRATION_SETUP` | — | The start: a state migration file is malformed |
| `MIGRATION_FAILED` | — | The start: a state migration failed |
| `SYSTEMD_NOTIFY_FAILED` | — | The start: the readiness message could not be sent |
| `DNS_FORWARDER_UNAVAILABLE` | — | The start: the containers' DNS forwarder could not bind |

## Validation Errors

### VM name validation

VM names are validated before route handlers execute (via a `preHandler` hook). Invalid
names receive a 422 response with code `INVALID_VM_NAME`.

### Path policy for VM disks / ISOs

`assertPathInsideAllowedRoots(absPath, vmName)` is invoked by attach/create paths (CDROM,
ISO, sourcePath). Any path that resolves — symlinks followed, as `realpath` does —
outside the image library or the VM's per-VM directory returns **422 PATH_NOT_ALLOWED**.

### Filename validation

Library file operations validate filenames: no path separators (`/`, `\`), no `..`, no
leading dots, and the filename must equal its `basename()`; a name that breaks them
answers **422** `INVALID_FILENAME`.

## Backend Error Logging

- Errors that answer 5xx are logged at `error` with the full, unredacted error by the one
  handler; a 4xx whose raw cause the client sees only redacted is logged at `warn`. Other
  4xx are not logged.
- Background job failures are logged by the job store at **warn** (`Background job
  failed` with the code, the message and the raw cause). The job's own failure path adds
  a `log.error()` with the full error/stack only for unexpected failures — not for codes
  that map to 4xx (`isExpectedAppError` in `lib/appErrors.js`, e.g. a
  `VM_MUST_BE_OFFLINE` or `VM_BUSY` that a race let past the route's pre-check).
- A failed MCP tool call is logged at `warn` with the tool, the code and the raw cause.
- DBus connection errors are logged and trigger automatic reconnection with backoff (see
  VM-MANAGEMENT.md); stream write errors (disk full, name collision) fail the job — never
  the process.

## Frontend Error Display

### One error object

Every error the client handles is an `ApiError` (`frontend/src/api/errors.js`): `status`
(the HTTP status, or none for a client-side error), `code` (the body's `error`) and
`detail`. `api()`, the upload client and the stream clients build it from the error body;
a job's error event becomes one on the job's row; client-side failures (a request
timeout, a lost job stream) are ApiErrors with codes of their own. Every component shows
an error through `errorText(err)`, which takes the detail, and branches on `err.code`,
never on the text.

### Error bar

A persistent red bar below the VM header. Visible on both Overview and Console tabs. Used
for VM action failures (start, stop, save, etc.). Remains until the user dismisses it or
starts another VM header action—the store clears the error when that new action
**begins**, not only after it succeeds (so errors are not auto-dismissed solely because
some other operation later succeeds).

### Inline errors

Red error text displayed within a section card. Used for per-section save failures.

### Job progress errors

For async operations (VM creation, backup, download), errors appear inline in the
progress area, with a red indicator.

### Stream error frames

On the `/api/events` topics an error frame is ignored and the store keeps its last good
payload (host stats, VM/container lists, sections, home, backups status): consumers
dereference the payload's fields, so storing the error object in its place would crash
the render.

### Global 401 handling

The frontend API client (`api()` in `api/client.js`) recognises a lost session by its
code (`AUTH_REQUIRED`, `AUTH_INVALID`). On one:

1. Write the `wisp_logout` localStorage signal so other tabs bounce too
2. Redirect to `/login`

This is automatic and applies to all API calls, handling session expiry and password
changes from another device. Because it logs every tab out, the backend sends 401 only
for a missing or expired session (see [Authentication](#authentication)).

### Render errors

A render throw anywhere in the tree lands in the top-level `AppErrorBoundary` (wraps the
router in `main.jsx`), which replaces the page with a recovery card and a **Reload**
button instead of unmounting to a blank page. See [UI.md](UI.md) § Render Error Screen. It
is a last resort — data errors are still handled where they occur (store guards, inline
errors).

### Stale responses for a previous selection

Selecting a VM or container fetches its config asynchronously. The stores (`vmStore`,
`containerStore`) bump a selection sequence number on every selection change (select,
deselect, rename-follow) and drop any `getVM` / `getContainer` response — success or error
— that comes back after the selection changed, so a slow response for the
previously-selected workload never overwrites the current one. The same
newest-request-wins guard applies to the container Logs run list and to the Image
Library's per-filter list fetch.
