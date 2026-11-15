# API — Image library

VM disk and ISO files: list, upload, download, rename, delete. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Image Library

### GET /api/library · `read`

List image files in the library.

- **Query:** `?type=iso|disk` (optional filter)
- **200:**

```json
[
  {
    "name": "ubuntu-24.04-server.iso",
    "type": "iso",
    "size": 2147483648,
    "modified": "2025-01-10T08:00:00.000Z"
  }
]
```

### POST /api/library/upload · `admin`

Upload a file to the image library. Streaming multipart — not buffered in memory.

- **Body:** Multipart file upload
- **200:** `{ name, type, size, modified }`
- **409:** File already exists
- **422:** Invalid filename

### DELETE /api/library/:filename · `admin`

Delete a file from the library.

- **200:** `{ ok: true }`
- **404:** File not found
- **409:** File in use — referenced by one or more VMs (detail lists names)

### PATCH /api/library/:filename · `admin`

Rename a file.

- **Body:** `{ name: string }`
- **200:** `{ name, type, size, modified }`
- **404:** File not found
- **409:** New name already taken, or source file is referenced by one or more VMs

### GET /api/library/check-url · `admin`

Check if a URL is reachable (HEAD request).

- **Query:** `?url=https://...`
- **200:** `{ ok: boolean, contentLength: number | null, error?: string, status?: number }`

### POST /api/library/download · `admin`

Start downloading a file from a URL. Returns job ID.

- **Body:** `{ url: string }`
- **201:** `{ jobId: string, title: string }` — `title` matches the truncated URL display rule used in the UI
- **422:** Invalid URL (only HTTP/HTTPS allowed)

### POST /api/library/download-ubuntu-cloud · `admin`

Download Ubuntu Server LTS cloud image.

- **201:** `{ jobId: string, title: string }`

### POST /api/library/download-arch-cloud · `admin`

Download latest Arch Linux x86_64 cloud image (qcow2) from the pkgbuild mirror.

- **201:** `{ jobId: string, title: string }`

### POST /api/library/download-haos · `admin`

Download Home Assistant OS image.

- **201:** `{ jobId: string, title: string }`

### GET /api/library/download-progress/:jobId · `read`

SSE stream for download progress.

- **Progress events:** `{ step: "progress", percent, loaded, total }` while downloading; the HAOS flow then sends one `{ step: "decompressing" }` when the download is complete and xz decompression starts (no percent — xz reports none, so the UI shows an indeterminate "Uncompressing…" until `done`).
- **Completion (from job store):** `{ step: "done", name, type, size, modified }` — same flattened shape as a successful library file row (no nested `result` object).
- **Failure (terminal):** `{ step: "error", error: string, detail: string }`
