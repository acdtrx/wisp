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
- **204:** uploaded; the list follows on the `library` cue
- **409:** `LIBRARY_FILE_EXISTS` — file already exists
- **422:** `INVALID_FILENAME` — invalid filename

### DELETE /api/library/:filename · `admin`

Delete a file from the library.

- **204:** deleted; announced like an upload
- **404:** `LIBRARY_FILE_NOT_FOUND` — file not found
- **409:** `LIBRARY_FILE_IN_USE` — file in use, referenced by one or more VMs (detail lists names)

### PATCH /api/library/:filename · `admin`

Rename a file.

- **Body:** `{ name: string }`
- **204:** renamed; announced like an upload
- **404:** `LIBRARY_FILE_NOT_FOUND` — file not found
- **409:** `LIBRARY_FILE_EXISTS` — new name already taken, or `LIBRARY_FILE_IN_USE` — source file is referenced by one or more VMs

### GET /api/library/check-url · `admin`

Check if a URL is reachable (HEAD request).

- **Query:** `?url=https://...`
- **200:** `{ ok: boolean, contentLength: number | null, error?: string, status?: number }`

### POST /api/library/download · `admin`

Start downloading a file from a URL: a [job](API.md#job-routes) (kind `library-download`) on `GET /api/jobs/:jobId/progress`.

- **Body:** `{ url: string }`
- **202:** `{ jobId: string, title: string }` — a job; `title` matches the truncated URL display rule used in the UI. The finished download is announced like an upload
- **Progress events:** `{ step: "progress", percent, loaded, total }` while downloading (`loaded` and `total` are `null` for the three named images below); the HAOS flow then sends one `{ step: "decompressing" }` when the download is complete and xz decompression starts (no percent — xz reports none, so the UI shows an indeterminate "Uncompressing…" until `done`).
- **`done` result:** `{ name, type, size, modified }` — the same shape as a library file row
- **422:** `INVALID_URL` — invalid URL (only HTTP/HTTPS allowed)

### POST /api/library/download-ubuntu-cloud · `admin`

Download Ubuntu Server LTS cloud image.

- **202:** `{ jobId: string, title: string }` — like `POST /api/library/download`

### POST /api/library/download-arch-cloud · `admin`

Download latest Arch Linux x86_64 cloud image (qcow2) from the pkgbuild mirror.

- **202:** `{ jobId: string, title: string }` — like `POST /api/library/download`

### POST /api/library/download-haos · `admin`

Download Home Assistant OS image.

- **202:** `{ jobId: string, title: string }` — like `POST /api/library/download`
