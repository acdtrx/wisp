# Image Library

The image library is a central place to manage **VM disk and ISO files** on disk and **OCI container images** stored in containerd (same namespace as Wisp containers). VM files live in a flat directory with type detection by extension; container images are listed and deleted via the containerd API (see [API-CONTAINERS.md](API-CONTAINERS.md) `GET/DELETE /api/containers/images`).

## Container (OCI) images

The **All** filter shows **VM library files and OCI images in one sorted list** (name order). The **OCI** filter lists only containerd images. Images appear after pulls (e.g. when creating a container) **or** after an operator loads one on the server with `ctr -n wisp image import foo.tar` — anything in the `wisp` containerd namespace is listed. **Delete** removes the image from containerd unless a Wisp container still references it (409), or Wisp cannot tell whether one does (the delete is refused with the failed read as its reason).

## Storage

All images are stored in a single flat directory (no subdirectories). The path is configured via `imagePath` in `config/wisp-config.json` (default: `/var/lib/wisp/images`).

## File Types

Files are categorized by extension:

| Type | Extensions |
|------|-----------|
| `iso` | `.iso` |
| `disk` | `.qcow2`, `.img`, `.raw`, `.vmdk` |
| `unknown` | Any other extension |

Type detection is automatic and based solely on the file extension.

**Using a disk image for a VM** (create with an existing disk, attach an existing disk) accepts only qcow2 and raw images without a backing file or external data file: `.qcow2`, `.raw`, and `.img` (qcow2 or raw, told apart by the qcow2 header). A `.vmdk` is listed as a disk image but refused there (**422 `DISK_FORMAT_UNSUPPORTED`**) — convert it on the host with `qemu-img convert -O qcow2`. Why, and how the format is pinned: [VM-MANAGEMENT.md § Untrusted images](VM-MANAGEMENT.md#untrusted-images).

## Operations

### Listing

Returns all files in the image directory, sorted alphabetically. Each file includes: name, detected type, size in bytes, and last modified timestamp (ISO 8601). Hidden files (starting with `.`) are skipped.

Optional type filter: `?type=iso` or `?type=disk` restricts the returned list.

### Upload

Files are uploaded via streaming multipart: the file is never buffered in memory, which supports very large files (up to 50GB).

Filename validation: no path separators (`/`, `\`), no `..`, no leading dots. The filename must equal its own basename.

If a file with the same name already exists, the upload is rejected (409 `LIBRARY_FILE_EXISTS`).

If the configured size limit is exceeded, the partial file is unlinked and the request returns **413** `UPLOAD_TOO_LARGE`. Any other pipeline error also unlinks the partial file before responding 500 `LIBRARY_IO_FAILED`.

### Delete

Removes a file from the image directory. Returns 404 `LIBRARY_FILE_NOT_FOUND` if the file doesn't exist. Returns **409** `LIBRARY_FILE_IN_USE` when the file is still referenced by any VM (any disk's `<source file="...">` matches the absolute path) — the response detail lists the VM names so the operator can detach first.

### Rename

Renames a file within the image directory. Validates both the old and new filenames. Returns 409 `LIBRARY_FILE_EXISTS` if the new name is already taken, or `LIBRARY_FILE_IN_USE` if the source file is referenced by any VM.

### URL Download

1. **Generic URL download** — downloads from any HTTP/HTTPS URL. Only HTTP and HTTPS protocols are allowed. Returns a job ID. Progress events include percent, bytes loaded, and total bytes. The URL dialog can be closed while the download runs; progress continues in the app-wide **background jobs** list.

#### SSRF protection

Every such fetch holds three invariants:

1. **Single DNS resolve.** The host is resolved once and the fetch is refused if any returned address is private/loopback/CGNAT/multicast/reserved, or IPv6 unique-local/link-local/site-local (`fec0::/10`)/multicast. An IPv6 address that wraps an IPv4 one — IPv4-mapped (`::ffff:0:0/96`), IPv4-translated (`::ffff:0:0:0/96`), IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) — is judged by the IPv4 address it carries; local-use NAT64 (`64:ff9b:1::/48`), Teredo (`2001::/32`) and an address that does not parse are refused.
2. **DNS-pinned connection.** The connection is pinned to exactly the resolved addresses: a second lookup at connect time would allow a rebinding bypass.
3. **Each redirect re-checked.** No redirect is followed automatically; each `Location` is resolved and pinned again. Up to 5 redirects are followed.

This applies to:
- `POST /api/library/download` (user-supplied URL)
- the URL check
- the Ubuntu cloud, Arch cloud, and HAOS preset downloads (so a hostile mirror cannot redirect to a private IP).

Outside the library, the GitHub keys lookup ([SETTINGS.md](SETTINGS.md), SSH keys) and the self-update's requests to GitHub ([UPDATES.md](UPDATES.md)) go through it too. The one outbound request that does not is to the operator's OIDC issuer, which may be on the LAN ([AUTH.md → OIDC / SSO login](AUTH.md#oidc--sso-login)).

2. **Preset downloads** — Three server-side presets: **Ubuntu Server** (latest LTS cloud image), **Arch Linux** (latest x86_64 cloud qcow2 from pkgbuild mirrors), and **Home Assistant OS** (latest HAOS QEMU image, xz-decompressed to qcow2; after the download's progress events, one `decompressing` event marks the indeterminate xz phase). Each returns a job ID, through the matching `POST /api/library/download-*` route.

All downloads run as background jobs (kind `library-download`, result `{ name, type, size, modified }`). Progress is streamed via SSE on `GET /api/jobs/:jobId/progress` — one `progress` event per integer percent change, not per received chunk (≤ ~101 per download); without a `Content-Length` only the final 100% is reported. Replay and retention follow the shared [job store contract](API.md#background-jobs).

**Naming and failure.** The destination name is reserved by an exclusive create: when the name is taken — an existing file or a concurrent download of the same image — the next ` (n)` variant is used, so two simultaneous downloads of one preset both succeed under distinct names. A download that fails (network, disk full) removes its partial file and fails the job with `{ step: 'error' }`; the HAOS flow also removes its hidden temporary file, and succeeds only when the output finished writing **and** `xz` exited 0 (a corrupt archive never lands as a truncated image).

### URL Check

A HEAD request to verify a URL is reachable before starting a download. Returns the HTTP status and content length (if available).

## Picker

The library is also a picker, opened from disk and CDROM fields of a VM and from a container's **Image** field:

- **VM picker** (disk and CDROM fields) — filters **All / ISO / Disk Image**; OCI is hidden. Auto-filters by context (CDROM → ISO, disk → Disk Image).
- **Container picker** (the Image field) — the **only** filter is **OCI**; VM files are hidden.
- Selecting a row closes the picker. A VM file returns its name; an OCI image returns `{ kind: 'oci', name, digest }`, so the caller can fill the field with the exact containerd ref.

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) Downloads (through the SSRF guard): connect **10 s**, response headers **30 s**, and **120 s** between body chunks — an idle bound, no total, so a large image on a slow link still finishes. The URL check (`HEAD`) **15 s**; the HAOS release lookup **15 s**; decompressing an `.xz` image is stopped after **10 min** without output. Uploads from the browser: no total; aborted after **60 s** without upload progress, then **45 s** for the server's reply, the short-request bound (settled 2026-11-13: what takes longer, such as a zip extract, is a job). The server drops an upload whose body sends nothing for **60 s** (settled 2026-11-13).
