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
- **`detail`** is the human-readable text, always there: Wisp's message, followed by the
  error's raw cause when it has one that the message does not already say (`Failed to
  resize disk: qemu-img: …`). The cause is redacted (below); the message is not. An error
  with no code (a bug, a failure nothing turned into a code) has no message of Wisp's:
  its whole text is cause, redacted. There is no third key. A Wisp error wrapped by
  another keeps its message as Wisp's, so the detail reads `<outer message>: <inner
  message>: <inner cause, redacted>`, and an inner error that is not Wisp's is all cause,
  `<outer message>: <its text, redacted>` (settled 2026-11-20).

**Every channel** sends this body:

| Channel | Where the body goes |
|---------|---------------------|
| HTTP | The answer's body, with the status the code maps to |
| A job's error event | `{ "step": "error", "error", "detail" }`, the last event of the job's stream ([API.md → Background jobs](API.md#background-jobs)) |
| A stream's error frame | The frame's payload: the `data` of an `/api/events` topic frame, or the `data:` line of a scoped stream (stats, logs, disks, USB) |
| MCP | A failed tool call: `isError: true`, the body as its JSON text and as `structuredContent` ([MCP.md](MCP.md)) |

JSON-RPC protocol errors on `/mcp` (a malformed message, an unknown method or tool) keep
JSON-RPC's own `{ code, message }`: that shape is the protocol's contract, not Wisp's.

**Redaction applies to the cause, in one place**, where the body is built, so it covers
every channel (settled 2026-11-20). The message is Wisp's own text and names what the
operator needs: a mount path they typed, a share (`//nas/media`), a backup destination, a
duplicate container path. The cause is text from a tool or a library Wisp does not
control (qemu-img's stderr, a Node errno message): in it absolute filesystem paths become
`<path>` and UUIDs `<uuid>`. The detail is capped at 500 characters. A path counts only
where it starts a token: at the start, after whitespace, a quote, a bracket, or one of
`= , : ; < |` (so `file:/var/x`, `path</var/x>` and `see|/etc/x` are caught). Two slashes
start a URL's host or an SMB share, not a path, and a slash inside a word is not one: an
image reference (`docker.io/library/nginx:1.27`), a URL or `body/field` passes untouched,
and so do Wisp's own URL paths (`/api/…`, `/ws/…`, `/mcp`), which are not host layout. An
unquoted path that holds a space keeps what follows the space (`<path> VM/disk.qcow2`):
nothing in the text marks where such a path ends. The server log keeps the unredacted
error.

## Where errors come from

- Code throws structured errors, built by the one error factory or a manager's private
  one, which build the same shape (CODING-RULES §5): a code, Wisp's message, and the raw
  cause, a toolchain's or daemon's own text.
- **Routes throw; one handler answers.** No route builds an error body or picks a status.
  The one error handler answers every error that leaves a handler or a hook, and every
  refusal of the framework itself (a schema violation, a body too large, an unknown
  route).
- **One table** maps each code to its status. An error without a code from the table (a
  bug, a Node errno) answers **500** `INTERNAL_ERROR`, its message as the detail.
- **Wisp's own words are the factories' mark** (settled 2026-11-20): an error is Wisp's,
  its message shown whole and its raw text the cause, when a factory built it; the
  wrappers and the handler test that mark, never whether the code is in the table. An
  error built by hand with a code is not Wisp's: its whole text is cause. A marked error
  whose code the table lacks answers **500** `INTERNAL_ERROR`, its message kept (the code
  check keeps the table complete, so this is a bug).
- `npm run check` holds the code, the table and this document in step: it fails when the
  code throws a code the table lacks, when the table holds a code nothing throws, and
  when the table and the list below disagree.

### Framework refusals

| Refusal | Code |
|---------|------|
| A request that fails its schema (body, params, querystring) | **400** `VALIDATION_FAILED`, the detail naming the part and the field (`body/vlanId must be number`; an unknown key: `body: unknown key "foo"`) |
| Malformed JSON, an empty JSON body, a forbidden `__proto__` key | **400** `MALFORMED_JSON` |
| Bad percent-encoding in the URL | **400** `MALFORMED_URL` |
| A multipart body cut short, or with a forbidden field name | **400** `MALFORMED_MULTIPART` |
| A body that does not match its `Content-Length` | **400** `BAD_CONTENT_LENGTH` |
| No route for the method and path | **404** `ROUTE_NOT_FOUND` |
| A body, or a multipart body's parts, files or fields, over its limit | **413** `PAYLOAD_TOO_LARGE` |
| An upload over the multipart file size limit | **413** `UPLOAD_TOO_LARGE` |
| A route parameter over its length limit | **414** `URI_TOO_LONG` |
| An unsupported content type, or a multipart route sent something else | **415** `UNSUPPORTED_MEDIA_TYPE` |

These are the framework's refusals that can occur in Wisp. Fastify sets no request
timeout here, so there is no 408. Any other
4xx the framework might raise answers **400** `BAD_REQUEST`, and any 5xx **500**
`INTERNAL_ERROR`.

400 is deliberate, not 422: it is the framework's verdict on the request's shape, while
422 stays for a well-formed request that cannot be carried out.

Unmatched routes answer `ROUTE_NOT_FOUND` under `/api`, `/ws`, `/assets/` and `/vendor/`;
in production every other unmatched path serves the SPA shell. Unmatched requests run no
handler and so get no auth check (see [AUTH.md](AUTH.md) § Route access levels). The
decision uses the request's percent-decoded path, so `/%61pi/nope` is an API miss, not a
client-side route.

### Authentication

| Scenario | Code |
|----------|------|
| No session cookie, or no bearer token on `/mcp` | **401** `AUTH_REQUIRED` |
| An invalid or expired session, or an unknown bearer token | **401** `AUTH_INVALID` |
| A bearer token on a `session` route | **403** `SESSION_REQUIRED` |
| A token whose scope is below the route's or the tool's, or an `agent` token sending a part of an `agent` route that stays `admin` | **403** `SCOPE_INSUFFICIENT` |
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

The rate limit: [AUTH.md](AUTH.md), Login Rate Limiting.

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
| `VALIDATION_FAILED` | 400 | The request, or an MCP tool's arguments, fails its schema; the detail names the part and the field ([Request validation](#request-validation)) |
| `MALFORMED_JSON` | 400 | The JSON body is malformed or empty, or holds a forbidden `__proto__` key |
| `MALFORMED_URL` | 400 | The URL's percent-encoding is malformed |
| `MALFORMED_MULTIPART` | 400 | The multipart body was cut short, or has a forbidden field name |
| `BAD_CONTENT_LENGTH` | 400 | The body does not match its `Content-Length` |
| `BAD_REQUEST` | 400 | Another refusal of the framework's, none of the above |
| `UPLOAD_NO_FILE` | 400 | An upload request carries no file part |
| `BAD_MULTIPART_TOO_MANY_FILES` | 400 | More than one file part in a container mount upload |
| `AUTH_REQUIRED` | 401 | No session cookie, or no bearer token on `/mcp` |
| `AUTH_INVALID` | 401 | The session is invalid or expired, or the bearer token is unknown |
| `LOGIN_FAILED` | 401 | Wrong password at login |
| `SESSION_REQUIRED` | 403 | An API token on a route only a browser session may call |
| `SCOPE_INSUFFICIENT` | 403 | The token's scope is below what the route, the MCP tool or the part of the request needs |
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
| `SSH_KEY_NOT_FOUND` | 404 | No key with that id in Wisp's list |
| `GITHUB_KEYS_NOT_FOUND` | 404 | GitHub answered 404 for that user: no such user |
| `CERTIFICATE_NOT_FOUND` | 404 | The host has no certificate setting to renew |
| `METHOD_NOT_ALLOWED` | 405 | The path takes another method (`GET` or `DELETE /mcp`) |
| `PAYLOAD_TOO_LARGE` | 413 | The body, or the multipart parts, exceed their limit |
| `UPLOAD_TOO_LARGE` | 413 | The upload exceeds its size limit |
| `URI_TOO_LONG` | 414 | The URL or a route parameter is too long |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | A content type the route does not take |
| `VM_ALREADY_RUNNING` | 409 | The VM is already running |
| `VM_NOT_RUNNING` | 409 | The VM is not running |
| `VM_NOT_PAUSED` | 409 | The VM is not paused |
| `VM_EXISTS` | 409 | A VM by that name exists |
| `VM_DIR_EXISTS` | 409 | A directory for that VM name exists on disk |
| `VM_MUST_BE_OFFLINE` | 409 | The operation needs the VM stopped |
| `VM_BUSY` | 409 | Another operation holds the VM's [operation lock](BACKUPS.md#per-vm-operation-lock); the detail names it |
| `VM_TRANSIENT` | 409 | The VM is transient (not defined in libvirt, e.g. started with `virsh create`): Wisp does not change its definition |
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
| `SSH_KEY_DUPLICATE` | 409 | The key is already in Wisp's list |
| `UPDATE_BUSY` | 409 | An OS update check or upgrade runs, or the package manager is locked |
| `UPDATE_NOT_AVAILABLE` | 409 | No Wisp update is available to install |
| `UPDATE_JOBS_ACTIVE` | 409 | Other jobs that must finish run; the Wisp update install waits for them unless forced |
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
| `INVALID_VM_NAME` | 422 | A VM name that reached the VM manager breaks the [name rules](#name-validation) |
| `PATH_NOT_ALLOWED` | 422 | The path resolves outside the image library and the VM's directory, or a name or a timestamp is not one path segment of the directory it is joined into |
| `BACKUP_INVALID` | 422 | The backup archive or manifest fails validation |
| `BACKUP_DEST_UNKNOWN` | 422 | An unknown backup destination id |
| `BACKUP_DEST_NONE` | 422 | No backup destination was given or configured |
| `HASH_FAILED` | 422 | The password could not be hashed for cloud-init |
| `INVALID_URL` | 422 | The URL is not an HTTP or HTTPS URL |
| `SSRF_BLOCKED` | 422 | The URL resolves to a private, loopback or reserved address, redirects too often, or redirects from `https` to `http` |
| `DNS_FAILED` | 422 | The URL's host does not resolve |
| `DOWNLOAD_FAILED` | 422 | The download failed |
| `NO_BODY` | 422 | The download answered without a body |
| `INVALID_FILENAME` | 422 | The file name breaks the [file name rules](#filename-validation) |
| `PASSWORD_EMPTY` | 422 | The new password is empty |
| `INVALID_PASSWORD` | 422 | The current password is wrong on change-password |
| `INVALID_OIDC` | 422 | The SSO settings are incomplete or invalid |
| `INVALID_BACKUP_SCHEDULE` | 422 | The backup schedule is invalid |
| `INVALID_SETTINGS` | 422 | A settings value is invalid |
| `CERTIFICATE_TOKEN_REJECTED` | 422 | Cloudflare refused the API token of the certificate setting |
| `CERTIFICATE_ZONE_NOT_FOUND` | 422 | The token sees no Cloudflare zone that holds the certificate's domain |
| `TOKEN_INVALID` | 422 | The API token's label is whitespace only |
| `INVALID_APP_CONFIG` | 422 | The app container's configuration is invalid |
| `APP_CONFIG_ONLY` | 422 | An app container is configured through its app config, not this field or mount |
| `APP_RELOAD_FAILED` | 422 | The app refused its new configuration on reload |
| `UNKNOWN_APP_TYPE` | 422 | No app type by that name |
| `INVALID_CONTAINER_IMAGE_REF` | 422 | The image reference is malformed |
| `IMAGE_PULL_FAILED` | 422 | The image could not be pulled |
| `CONTAINER_IMAGE_ARCHIVE_INVALID` | 422 | The upload is not an image archive containerd can import; the detail carries its message. A job's error only |
| `CONTAINER_IMAGE_ARCHIVE_UNNAMED` | 422 | The uploaded archive names no image. A job's error only |
| `CONTAINER_IMAGE_PLATFORM_MISMATCH` | 422 | An image in the uploaded archive is not for the host's platform. A job's error only |
| `CONTAINER_IMAGE_LOCAL` | 422 | The image is under `localhost/`, this host's own, so it is not pulled. A check's `skipped` event only |
| `INVALID_CONTAINER_NAME` | 422 | A container name that reached the container manager breaks the [name rules](#name-validation) |
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
| `SSH_KEY_INVALID` | 422 | The text is not one SSH public key |
| `RATE_LIMITED` | 429 | Too many attempts from this address; the detail says when to retry |
| `INTERNAL_ERROR` | 500 | An error without a code: a fault on the server |
| `CONFIG_INVALID` | 500 | `wisp-config.json` fails its strict read |
| `LIBVIRT_ERROR` | 500 | libvirt refused or failed the call |
| `VM_DELETE_INCOMPLETE` | 500 | The VM was deleted, but its folder could not be removed; the detail names it |
| `CONTAINERD_ERROR` | 500 | containerd failed the call, or did not answer in time |
| `CONTAINER_DELETE_INCOMPLETE` | 500 | The container was deleted, but its network lease was not released; the detail names the cause |
| `DISK_INFO_FAILED` | 500 | The disk image could not be inspected |
| `NVRAM_COPY_FAILED` | 500 | The VM's UEFI NVRAM could not be copied |
| `BACKUP_FAILED` | 500 | The backup failed |
| `BACKUP_RESTORE_FAILED` | 500 | The restore failed |
| `CONTAINER_ZIP_EXTRACT_TIMEOUT` | 500 | The zip extract was stopped at its bound |
| `LIBRARY_IO_FAILED` | 500 | A read or write in the image library failed |
| `GITHUB_API` | 500 | GitHub's release API answered wrongly |
| `NO_ASSET` | 500 | The release has no tarball asset |
| `GITHUB_KEYS_UNAVAILABLE` | 502 | GitHub could not be asked for the user's keys, or answered neither 2xx nor 404 |
| `CERTIFICATE_DNS_UNAVAILABLE` | 502 | Cloudflare could not be asked about the certificate's domain |
| `CERTIFICATE_ISSUE_FAILED` | 502 | The certificate job failed; the detail names the step and carries the certificate authority's or Cloudflare's message. A job's error only |
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
| `SHUTTING_DOWN` | 503 | Wisp is shutting down: the job was not started; start it again once Wisp is back |

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
| `SMART_HELPER_UNAVAILABLE` | — | The same |
| `SMART_INVALID_DISK_NAME` | — | The same |
| `SMART_INVALID_JSON` | — | The same |
| `SMART_READ_FAILED` | — | The same: the helper failed, and its error line says why (smartctl not installed, no answer, past its limit) |
| `RUNTIME_ENV_INVALID` | — | The start: `config/runtime.env` fails its strict read |
| `CONFIG_PATH_NOT_ALLOWED` | — | The start: an installed Wisp is given `WISP_CONFIG_PATH`, which is for development and tests ([CONFIGURATION.md → Password Storage](CONFIGURATION.md#password-storage)) |
| `DEFAULT_BRIDGE_INVALID` | — | The start: `WISP_DEFAULT_BRIDGE` names no host bridge |
| `MIGRATION_SETUP` | — | The start: a state migration file is malformed |
| `MIGRATION_FAILED` | — | The start: a state migration failed |
| `SYSTEMD_NOTIFY_FAILED` | — | The start: the readiness message could not be sent |
| `DNS_FORWARDER_UNAVAILABLE` | — | The start: the containers' DNS forwarder could not bind |

## Request validation

Input is checked at the boundary by one validator, JSON Schema with ajv
(settled 2026-11-20): every route's params, querystring and
body, and every MCP tool's arguments. What it refuses answers **400** `VALIDATION_FAILED`,
the detail naming the part and the first field that fails (above).

- **Unknown keys are refused**, never dropped: every object a route or a tool accepts says
  which keys it takes, and a route that declares no querystring or no body takes none
  (`querystring: unknown key "x"`, `body: unknown key "x"`). A bodiless command accepts an
  empty object or no body.
- **A JSON body is not coerced**: `"22"` is not a number, `"true"` not a boolean. A
  querystring and path params arrive as strings and are coerced to the type their schema
  names (`?deleteFiles=false` is `false`, `/services/80` is `80`); a value that does not
  convert is refused.
- **A default fills a key left out** where the schema gives one (`safetyBackup`, a disk's
  `bus`, the stats `intervalMs`).
- The schema says the shape: required keys, types, enums, lengths, ranges, patterns. A
  route's own 4xx codes are for what a schema cannot say (a name of whitespace only, a
  duplicate, an id that names nothing, a path outside the allowed roots).
- `npm run check` fails a route that lacks a schema it needs: params for each URL param,
  a response schema for a success, every object, in the input and in the answers, listing
  its keys and taking no others (`additionalProperties: false`), and every array saying
  its `items`, at every depth of the schema. An object that takes keys it does not list
  (an app's config, a map, the OIDC provider's callback parameters, a branch that narrows
  keys its parent closes), or a value any JSON may be (the MCP envelope), is marked open
  on purpose; the check fails any other, and a schema that names no type.

### Name validation

A VM or container name is a path segment: letters, digits, dots, hyphens and
underscores, a leading letter or digit, no `..`, at most 128 characters for a VM and 63
for a container, and used as sent, never trimmed. The same schema checks a name in a URL, a body (a create, a
rename, a backup's and a restore's names) and an MCP tool's arguments, so a name that
breaks it is **400** `VALIDATION_FAILED`. The managers check a name they are given again
(`INVALID_VM_NAME`, `INVALID_CONTAINER_NAME`, 422), for callers that reach them without a
schema, and every path a manager builds from a name or a backup's timestamp is checked
where it is built: each name and timestamp is one path segment (not empty, `.` or `..`,
no `/` or NUL), and the path stays below the directory it is joined into (**422**
`PATH_NOT_ALLOWED`).

### Path policy for VM disks / ISOs

A path given for a VM's disk, CD-ROM or ISO (attach and create) that resolves — symlinks
followed, as `realpath` does — outside the image library or the VM's per-VM directory
returns **422 PATH_NOT_ALLOWED**.

### Filename validation

The library validates the file names it is given, where the path is built: no path separators (`/`, `\`), no `..`, no
leading dots, and the filename must equal its `basename()`; a name that breaks them
answers **422** `INVALID_FILENAME`.

## Backend Error Logging

- The one handler logs a 5xx at `error` with the whole error, and a 4xx that has a raw
  cause at `warn` with it. Other 4xx are not logged.
- Background job failures are logged by the job starter as `Background job failed`:
  at **warn** with the code, the message and the raw cause for codes that map to 4xx
  (e.g. a `VM_MUST_BE_OFFLINE` that a race let past the pre-check), at **error** with the full error/stack for unexpected
  failures.
- A failed MCP tool call is logged at `warn` with the tool, the code and the raw cause.
- DBus connection errors are logged and trigger automatic reconnection with backoff (see
  VM-MANAGEMENT.md); stream write errors (disk full, name collision) fail the job — never
  the process.

## Frontend Error Display

### One error object

Every error the client handles is one object, an `ApiError`: `status` (the HTTP status,
or none for a client-side error), `code` (the body's `error`) and `detail`. The REST
client, the upload client and the stream clients build it from the error body; a job's
error event becomes one on the job's row; client-side failures (a request timeout, a
lost job stream) are ApiErrors with codes of their own. Every component shows an error's
detail, and branches on its code, never on the text.

### Client codes

The client gives the errors it makes itself codes of its own, never sent by the server:

| Code | Meaning |
|------|---------|
| `TIMEOUT` | A REST call, or an upload's reply, past its deadline |
| `REQUEST_FAILED` | An error answer that is not the error body (a proxy's page, an empty body) |
| `UPLOAD_FAILED` | The browser could not send the upload |
| `UPLOAD_STALLED` | The upload made no progress for its idle bound |
| `UPLOAD_CANCELLED` | The upload was cancelled |
| `JOB_GONE` | The job a wait follows is gone: its progress stream answers 404 (it expired, or never existed). A dropped stream reconnects and replays instead |
| `JOB_CANCELLED` | The job a wait follows was cancelled before it finished (an interruptible job cut at shutdown): the command did not succeed (settled 2026-11-21) |

### Where an error shows

How an error is shown and how long it stays: `docs/FRONTEND-RULES.md`, Errors.

- **A workload's action error** (start, stop, save, …) shows in a bar below the
  workload's header (a VM's or a container's), on every tab. It remains until the user
  dismisses it or starts another action on that workload: the error is cleared when that
  new action **begins**, not only after it succeeds.
- **A card's own error** (a failed read, or a failed action of that card) shows within
  the card, below its header.
- **A job's error** shows inline in its progress area.

### Stream refusals

A stream (the events stream, a scoped stream, a job's progress) whose request is answered
with a 4xx carrying Wisp's error body (`{ error, detail }`) that is not a lost session
ends there: Wisp said no, so the stream client hands the caller the ApiError and does not
ask again, since asking again gets the same refusal. A 4xx without that body (a proxy's
401 or 403, an HTML page) is not Wisp's answer: it reconnects with backoff, as a lost
connection or a 5xx does. A lost session (`AUTH_REQUIRED`, `AUTH_INVALID`) goes to the
login page (settled 2026-11-20). A job's progress stream answering 404 is `JOB_GONE` to a
wait; another refusal is the wait's error. The events stream never ends silently: when
Wisp refuses it, the top bar's host stats show the refusal where they show the stream
connecting, until the page subscribes afresh.

### Stream error frames

On the `/api/events` topics (and the scoped streams) an error frame never replaces the
data: the client keeps the last good payload (host stats, VM/container lists, sections,
home, backups status, the job list), since consumers dereference its fields, and shows
the error's text beside it until a good frame comes.

### Global 401 handling

The frontend API client recognises a lost session by its code (`AUTH_REQUIRED`,
`AUTH_INVALID`). On one:

1. Write the `wisp_logout` localStorage signal so other tabs bounce too
2. Leave the error's text for the login page, which shows it once, so the user sees why
   they are signing in again
3. Redirect to `/login`

This is automatic and applies to all API calls, handling session expiry and password
changes from another device. Because it logs every tab out, the backend sends 401 only
for a missing or expired session (see [Authentication](#authentication)).

### Render errors

A render throw anywhere in the tree lands in the one top-level error boundary:
[UI.md](UI.md) § Render Error Screen.

### Stale responses for a previous selection

Every record a view shows (a workload's configuration, the settings, a list) is read
through one cache (settled 2026-11-20). A view never shows an older answer after a newer
one, and a failed read that a newer read has replaced shows nothing. A failed read keeps
the data already shown. A read is aborted when nothing shows its record any more, and a
page shows only the workload its URL names, so a slow answer for the previously-selected
workload never reaches the current one. The record's own not-found is the record being
gone, not an error.
