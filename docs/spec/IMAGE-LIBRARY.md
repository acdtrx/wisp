# Image Library

The image library is a central place to manage **VM disk and ISO files** on disk and, on the Host **Library** page, **OCI container images** stored in containerd (same namespace as Wisp containers). VM files live in a flat directory with type detection by extension; container images are listed and deleted via the containerd API (see [API.md](API.md) `GET/DELETE /api/containers/images`).

## Container (OCI) images

On the standalone Host **Library** page, the **All** filter shows **VM library files and OCI images in one sorted list** (name order). The **OCI** filter lists only containerd images. Images appear after pulls (e.g. when creating a container) **or** after an operator loads one on the server with `ctr -n wisp image import foo.tar` — anything in the `wisp` containerd namespace is listed. **Delete** removes the image from containerd unless a Wisp container still references it (409). The VM file picker (disk/CDROM) does **not** include the OCI filter — only ISO/disk files are selectable there. The **Create Container** form has its own picker (see below) that shows **only** OCI images.

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

## Operations

### Listing

Returns all files in the image directory, sorted alphabetically. Each file includes: name, detected type, size in bytes, and last modified timestamp (ISO 8601). Hidden files (starting with `.`) are skipped.

Optional type filter: `?type=iso` or `?type=disk` restricts the returned list.

### Upload

Files are uploaded via streaming multipart. The file data is piped directly from the request to a write stream — the entire file is never buffered in memory. This supports very large files (up to 50GB).

Filename validation: no path separators (`/`, `\`), no `..`, no leading dots. The filename must equal its own basename.

If a file with the same name already exists, the upload is rejected (409 conflict).

If the configured size limit is exceeded, the partial file is unlinked and the request returns **422**. Any other pipeline error also unlinks the partial file before responding 500. This prevents disk-fill from a truncated or aborted upload.

### Delete

Removes a file from the image directory. Returns 404 if the file doesn't exist.

### Rename

Renames a file within the image directory. Validates both the old and new filenames. Returns 409 if the new name is already taken.

### URL Download

1. **Generic URL download** — downloads from any HTTP/HTTPS URL. Only HTTP and HTTPS protocols are allowed (SSRF protection). Returns a job ID. Progress events include percent, bytes loaded, and total bytes. The URL dialog can be closed while the download runs; progress continues in the app-wide **background jobs** list.

#### SSRF protection

`ssrfSafeFetch` enforces three layers (see `backend/src/lib/downloadFromUrl.js`):

1. **Single DNS resolve.** `assertUrlNotPrivate` calls `dns.lookup` once and rejects if any returned address is private/loopback/CGNAT/multicast/reserved/IPv4-mapped-IPv6/etc. (full list in `isPrivateIPv4` / `isPrivateIPv6`).
2. **DNS-pinned connection.** The resolved addresses are fed to an `undici.Agent` with a `connect.lookup` hook that pins the connection to those exact IPs. A second DNS lookup at connect time would otherwise enable a rebinding bypass.
3. **Manual redirect re-validation.** All fetches use `redirect: 'manual'`; each `Location` is re-resolved + re-pinned. Up to 5 redirects are followed.

This applies to:
- `POST /api/library/download` (user-supplied URL)
- `HEAD`-style URL check
- `downloadWithProgress` used by Ubuntu cloud, Arch cloud, and HAOS preset downloaders (so a hostile mirror cannot redirect to a private IP).

2. **Preset downloads** — Three server-side presets, exposed in the UI as one **preset image** control (cloud icon + chevron) that opens a custom menu (not the browser’s native `<select>`): each row has an icon and label for **Ubuntu Server** (latest LTS cloud image), **Arch Linux** (latest x86_64 cloud qcow2 from pkgbuild mirrors), or **Home Assistant OS** (latest HAOS QEMU image, xz-decompressed to qcow2; progress events can include a `decompressing` phase). Each choice returns a job ID and uses the same background job + SSE flow as the matching `POST /api/library/download-*` routes.

All downloads run as background jobs. Progress is tracked via a job store and streamed to the frontend via SSE.

### URL Check

A HEAD request to verify a URL is reachable before starting a download. Returns the HTTP status and content length (if available).

## Dual Mode: Page and Modal

The image library appears in two contexts:

### Standalone page

Accessed via a top-bar button. On the Host **Library** tab the UI is a single **`SectionCard`** (same bordered white card as Host Overview sections), with **`Images`** **`titleIcon`**, type filter and actions in **`headerAction`**, and the table in the card body. Shows the full file list with type badges, file size, and last modified. Supports upload via an **Upload** icon in the section header (opens a file picker), delete with confirmation, and inline rename.

A type filter (All / ISO / Disk Image / **OCI**) sits in the **`SectionCard`** header next to icon-only actions (**Upload**, **Download from URL**, **Preset image** menu — same on every filter including **OCI**). **All** merges VM files and OCI images in one table (name, type, digest, size, modified). **ISO** and **Disk Image** use the same columns; digest is blank for files. The **OCI** tab lists only containerd images. Preset downloads also appear in the app-wide background jobs list.

### Picker modal

Opened from disk and CDROM fields in the VM overview and create forms, and from the **Image** field in the Create/edit Container form. Wrapped in **`ImageLibraryModal`**: modal frame uses the page-style background; the library itself is still a **`SectionCard`** (same as the Host tab). Same UI but:
- Table columns **Name**, **Type**, **Size**, and **Select** only — **Digest** and **Modified** are omitted so the modal stays narrow
- Shows a "Select" action button per row (in addition to delete/rename for VM files)
- The `pickerKind` prop controls which tabs appear:
  - `pickerKind="vm"` (default, used by disk/CDROM pickers) — tabs are **All / ISO / Disk Image**; OCI is hidden. Auto-filters by context (CDROM → ISO, disk → Disk Image).
  - `pickerKind="container"` (used by the Container Image field) — the **only** tab is **OCI**; VM files are hidden.
- Selecting a row closes the modal. VM files return `file.name` + full path (for attaching to a VM); OCI images return `{ kind: 'oci', name, digest }` so the caller can populate the text field with the exact containerd ref.

## Frontend Integration

The image library component accepts a `mode` prop and, in picker mode, a `pickerKind` prop:
- `mode="page"` — standalone view with upload, download, delete, rename, and OCI list/delete
- `mode="picker"`, `pickerKind="vm"` — modal view with select action for VM files (ISO/disk); OCI tab hidden
- `mode="picker"`, `pickerKind="container"` — modal view that shows only OCI images, each row has a Select button that emits `{ kind: 'oci', name, digest }`

The picker mode is wrapped in a modal component (`ImageLibraryModal`) that handles overlay, close, and value return.
