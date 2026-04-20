# Implementation Plan

This plan breaks the project into atomic phases that can be implemented, tested, and validated independently. Each phase builds on the previous one. Within each phase, implement the backend first, verify via direct API calls, then implement the frontend.

All phases must comply with the architectural rules defined in the spec documents. Serial console (xterm.js) is excluded from all phases.

---

## Phase 1 — Scaffold and Authentication

**Goal:** Working project scaffold with login, auth middleware, and basic libvirt connectivity.

### Backend

- Project scaffold: entry point, plugin registration, env loading, graceful shutdown
- vmManager connection module: connect to libvirt via DBus system bus, proxy `org.libvirt.Connect`, call `GetLibVersion()` to confirm, log result. Auto-reconnect on DBus error (2-second delay). macOS dev mode (skip libvirt).
- Auth module: JWT sign/verify using Node.js crypto (no library), password verification with timing-safe compare, password file support
- `POST /api/auth/login` — verify password, return JWT. Rate limiting (5 attempts/60s/IP).
- `POST /api/auth/change-password` — verify current, write new to `.wisp-password`
- Auth hook: validate `Authorization: Bearer` on all routes except login. Support `?token=` query param for WebSocket.
- `GET /api/host` — hostname, Node/libvirt/QEMU versions, uptime, kernel, OS release
- Error handling: `routeErrors.js` with `createAppError`, `handleRouteError`, `sendError`, error code-to-status mapping

### Frontend

- Project scaffold: build tool config, CSS framework setup with custom theme (colors, fonts, shadows, radii), PostCSS
- App shell: top bar (empty), empty left panel, empty center panel
- Login page: password input, submit, store JWT in localStorage, redirect to app
- Protected route wrapper: redirect to `/login` if no valid JWT
- API client: fetch wrapper with Bearer token injection, 401 redirect
- Auth store

### Acceptance

- Login works end-to-end
- JWT stored in localStorage, persists across reload
- Protected routes redirect unauthenticated users to login
- libvirt connection logged on startup (Linux) or dev mode message (macOS)
- `GET /api/host` returns version info

---

## Phase 2 — App Layout and Host Stats

**Goal:** Full app shell with live host stats in the top bar.

### Backend

- `/proc` reader module: parse `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, `/proc/diskstats` — no npm library
- Host hardware detection (CPU cores, total memory)
- vmManager: running VM allocation totals (vCPUs, memory across active domains)
- `GET /api/stats` — SSE endpoint pushing combined host metrics every 3 seconds
- SSE helper module: `setupSSE(reply)` for consistent SSE response setup

### Frontend

- Host stats bar: subscribes to `/api/stats` SSE, renders live pills with color thresholds (green <60%, amber 60-85%, red >85%)
- Full app shell layout: top bar with "Wisp" label, server name, host stats pills, right-side icons
- Left panel: "Virtual Machines" header + "New VM" button (with Plus icon), empty list area
- Center panel: empty placeholder ("Select a VM or create a new one")
- SSE helper: `createSSE(url, onMessage, onError)` with auth token, reconnection, cleanup
- Stats store

### Acceptance

- Stats bar updates every 3 seconds
- CPU and RAM pills color-code at thresholds
- Running VM allocation counts update when VMs start/stop
- SSE reconnects after connection loss

---

## Phase 3 — Image Library

**Goal:** Complete image management with upload, download, delete, rename.

### Backend

- File type detection by extension (ISO vs disk)
- `GET /api/library` — list files with type/size/modified, optional `?type=` filter
- `POST /api/library/upload` — streaming multipart to disk (pipeline, no memory buffering)
- `DELETE /api/library/:filename`
- `PATCH /api/library/:filename` — rename with validation
- `GET /api/library/check-url` — HEAD request URL check
- `POST /api/library/download` — background URL download with job store + SSE progress
- `POST /api/library/download-ubuntu-cloud` — Ubuntu LTS cloud image download
- `POST /api/library/download-haos` — HAOS download with decompression
- `GET /api/library/download-progress/:jobId` — SSE stream
- Job store module for async background jobs
- Filename validation (no traversal, no hidden files)

### Frontend

- Image Library page (top bar button)
- `ImageLibraryModal` — same UI in a modal with Select action
- Type filter: All / ISO / Disk Image, auto-set by context
- Upload: drag-and-drop zone + file picker, progress display
- Download: URL input, Ubuntu Cloud, HAOS preset buttons with progress
- Delete with confirmation, inline rename
- UI store: `centerView = 'library'`

### Acceptance

- Files listed with correct type badges and sorted alphabetically
- Upload streams to disk without memory spike (test with large file)
- Delete and rename work
- URL download shows progress
- Modal auto-filters by caller context (tested in Phase 5)

---

## Phase 4 — VM List, Lifecycle, and VM Stats

**Goal:** VM list in the left panel, lifecycle actions, per-VM stats.

### Backend

- vmManager modules: connection, list, lifecycle, stats, XML parsing
- `listVMs()` — list all domains (active + inactive) with summary
- `getVMConfig(name)` — full config parsed from XML
- Lifecycle: `startVM`, `stopVM`, `forceStopVM`, `rebootVM`, `suspendVM`, `resumeVM`
- `GET /api/vms` — list all VMs
- `GET /api/vms/stream` — SSE stream of VM list at configurable interval
- `GET /api/vms/:name` — full VM config
- `POST /api/vms/:name/{start,stop,force-stop,reboot,suspend,resume}`
- `GET /api/vms/:name/stats` — SSE stream of per-VM stats every 3s
- VM name validation (preHandler hook)
- DomainEvent listener for state change tracking

### Frontend

- Left panel VM list: VM icon (colored by state) before name, vCPU/RAM summary below, hover actions (Start/Stop/Reboot)
- VM list updates via SSE stream at configurable interval (from settings)
- Search input for client-side filtering
- Click VM to select → loads Overview header in center panel
- Selected VM highlighted
- Action bar: Start, Stop, Force Stop, Reboot, Suspend, Resume (context-sensitive disabled states)
- VM stats bar at bottom of center panel
- VM store: selected VM, vmConfig, vmStats, action dispatchers
- Escape key deselects VM

### Acceptance

- All VMs listed with VM icon colored by state (green/grey/amber/blue)
- Lifecycle actions work and status updates without page reload
- VM stats bar shows live metrics for running VMs; "Stopped" or "Paused" when not running
- Search filters instantly

---

## Phase 5 — VM Overview Panel

**Goal:** Complete Overview tab with all section cards, config editing, and disk management.

### Backend

- vmManager: `updateVMConfig`, `attachDisk`, `detachDisk`, `resizeDiskBySlot`, `attachISO`, `ejectISO`
- vmManager: `listHostBridges`, `listHostFirmware`
- `PATCH /api/vms/:name` — update config, return `{ requiresRestart }`
- `POST /api/vms/:name/disks`, `DELETE /api/vms/:name/disks/:slot`, `POST /api/vms/:name/disks/:slot/resize`
- `POST /api/vms/:name/cdrom/:slot`, `DELETE /api/vms/:name/cdrom/:slot`
- `GET /api/host/bridges`, `GET /api/host/firmware`
- `GET /api/vms/:name/xml` — raw domain XML
- `POST /api/vms/:name/clone` — clone with disk copy
- `DELETE /api/vms/:name` — delete with optional `?deleteDisks=true`

### Frontend

- SectionCard component: collapsible, save button, dirty state, restart-required badge, lock icon, error
- GeneralSection: name, auto-start, OS type/variant (segmented), CPU, RAM
- DisksSection: sda/sdb rows (mount/unmount/resize), sdc/sdd CDROM rows (attach/eject via ImageLibraryModal), sde cloud-init row (read-only)
- AdvancedSection (collapsed by default): Network block (NIC list, bridge dropdown, VLAN, model, MAC, add/remove), firmware, machine type, CPU model, video, graphics, boot order, toggles
- SnapshotsSection: placeholder (populated in Phase 8)
- Overview and Console tabs in header
- Action buttons: Clone dialog, Delete confirmation (with "delete disks" checkbox), View XML modal (read-only, copy button)
- Backup button and modal (populated in Phase 9)
- Per-section dirty state tracking and Save
- Offline-only field locking (lock icon when running, editable when stopped)
- Error bar below header
- `isCreating` prop on shared sections (false for Overview)

### Acceptance

- All sections render correctly with data from VM config
- Section save works with correct live vs offline behavior
- ISO hot-attach/eject works on running VM
- Disk mount/unmount/resize works on stopped VM
- Clone creates a working copy
- Delete removes VM (with/without disks)
- View XML shows current domain XML
- Offline-only fields lock when VM is running

---

## Phase 6 — USB Passthrough

**Goal:** USB device management in the Overview panel.

### Backend

- vmManager: `getVMUSBDevices`, `attachUSBDevice`, `detachUSBDevice`, `listHostUSBDevices`
- `GET /api/host/usb`, `GET /api/vms/:name/usb`, `POST /api/vms/:name/usb`, `DELETE /api/vms/:name/usb/:id`

### Frontend

- USBSection in Overview: attached devices (with Detach), host devices (with Attach)
- Auto-refresh every 5 seconds
- Immediate actions (no Save button)

### Acceptance

- Host USB devices listed and refresh
- Hot-attach/detach on running VM
- Persistent config attach/detach on stopped VM
- Attached devices shown first

---

## Phase 7 — Cloud-Init

**Goal:** Cloud-init configuration, ISO generation, GitHub key import.

### Backend

- Cloud-init module: user-data/meta-data YAML generation, password hashing via `openssl passwd -6`, ISO generation via `cloud-localds` (fallback: `genisoimage`)
- vmManager: `generateCloudInit`, `attachCloudInitDisk`, `detachCloudInitDisk`, `getCloudInitConfig`, `updateCloudInit`
- `GET /api/vms/:name/cloudinit`, `PUT /api/vms/:name/cloudinit`, `DELETE /api/vms/:name/cloudinit`
- `GET /api/github/keys/:username` — server-side GitHub fetch
- Per-VM storage: cloud-init.iso + cloud-init.json in VM directory

### Frontend

- CloudInitSection in Overview: read-only summary (masked password, SSH key status, toggles), Edit/Regenerate/Disable buttons
- Edit mode: full form with all fields, GitHub SSH key import with server-side fetch and confirmation
- `isCreating=true` mode: full editable form
- sde disk row shown/hidden based on cloud-init enabled state
- Hidden for Windows OS type

### Acceptance

- ISO generated with correct user-data
- sde attached/detached correctly
- GitHub key import works (server-side)
- Edit + Save regenerates and hot-swaps ISO
- Summary shows masked password
- Hidden for Windows VMs

---

## Phase 8 — VNC Console and noVNC

**Goal:** In-browser graphical console.

### Backend

- vmManager: `getVNCPort(name)` — parse VNC port from domain XML `<graphics>` element
- `/ws/console/:name/vnc` — WebSocket route: verify JWT from `?token=`, TCP connect to `127.0.0.1:<port>`, bidirectional pipe WebSocket-to-TCP

### Frontend

- Vendor noVNC: `vendor-novnc.sh` + `ensure-novnc.js`, build config externalization
- VNCConsole component: dynamic `import('/vendor/novnc/core/rfb.js')`, create RFB instance with WebSocket URL
- ConsolePanel: toolbar + viewport, lazy-loaded
- ConsoleToolbar: Ctrl+Alt+Del, Paste, Screenshot, Fullscreen (viewport only), Disconnect/Reconnect
- Auto-reconnect on VM state transition to running
- `scaleViewport = true`

### Acceptance

- VNC console connects and displays running VM
- Toolbar is permanent above viewport, never overlapping
- Fullscreen expands viewport only
- noVNC loads via vendored ESM dynamic import (no npm, no bundler)
- Console reconnects after VM reboot

---

## Phase 9 — Create VM

**Goal:** Full VM creation with templates, disk provisioning, and progress.

### Backend

- Disk operations module: `qemu-img create`, `qemu-img convert -O qcow2 -p` (with progress parsing), `qemu-img resize`
- vmManager: `createVM(spec, callbacks)` — full creation flow with template defaults, Windows optimizations, XML generation
- `POST /api/vms` — async creation job, returns jobId
- `GET /api/vms/create-progress/:jobId` — SSE progress stream
- Create job store

### Frontend

- CreateVMPanel: shared section components with `isCreating=true`
- Template selector: 5 cards (Ubuntu Server, Ubuntu Desktop, Windows 11, HAOS, Custom), auto-fill on selection
- Disks: New Disk / Existing Image toggle, size input, bus selection, image picker, optional resize
- Cloud-init form (visible for Existing Image + non-Windows/HAOS)
- Sticky Create button + spinner + progress text via SSE
- On success: VM appears in list, auto-selected
- On error: red inline error card

### Acceptance

- All 5 templates produce working VMs
- Windows VMs have Hyper-V optimizations and vTPM
- Disk copy from library works (source never modified)
- Disk resize works
- Progress is event-driven (no sleep/setTimeout)
- Shared sections with Overview via `isCreating` prop (no duplicated field logic)

---

## Phase 10 — Snapshots

**Goal:** Snapshot create, list, revert, delete.

### Backend

- vmManager: `listSnapshots`, `createSnapshot`, `revertSnapshot`, `deleteSnapshot`
- `GET /api/vms/:name/snapshots`, `POST /api/vms/:name/snapshots`, `DELETE /api/vms/:name/snapshots/:id`, `POST /api/vms/:name/snapshots/:id/revert`

### Frontend

- SnapshotsSection: compact table (name, created, state), Create Snapshot button, row actions (Revert, Delete with confirmation)
- Non-qcow2 note when disk format doesn't support snapshots
- Empty state when no snapshots

### Acceptance

- Snapshots created (live + offline)
- Revert restores VM to snapshot state
- Delete removes snapshot without affecting current VM
- Non-qcow2 note displayed correctly

---

## Phase 11 — Backups and Settings

**Goal:** Full backup/restore system and application settings.

### Backend

- vmManager: `createBackup`, `listBackups`, `restoreBackup`, `deleteBackup`
- `POST /api/vms/:name/backup`, `GET /api/vms/backup-progress/:jobId`
- `GET /api/backups`, `POST /api/backups/restore`, `DELETE /api/backups`
- Settings module: read/write `wisp-config.json` with mutex, password masking
- `GET /api/settings`, `PATCH /api/settings`
- Mount module: SMB mount/unmount/check via `wisp-mount` helper
- `GET /api/host/mounts`, `POST|PATCH|DELETE /api/host/mounts[/:id]`, `GET /api/host/mounts/status`, `POST /api/host/mounts/check`, `POST /api/host/mounts/:id/mount`, `POST /api/host/mounts/:id/unmount`
- Mount auto-mount + hard-converge at startup
- Backup job store
- OS updates: `POST /api/host/updates/check`, `POST /api/host/updates/upgrade`

### Frontend

- Settings page: general settings, backup destinations (SMB management), password change, about section
- BackupsPanel: table of all backups, restore dialog, delete confirmation
- BackupModal: destination selection for VM backup
- Host Management panel: host info, bridges, OS updates
- Settings store
- Backup progress via SSE

### Acceptance

- Backup creates valid archive (domain.xml, gzipped disks, NVRAM, cloud-init)
- Restore creates a working VM with new name/UUID/MACs
- SMB mount/unmount/check works
- Settings save and persist across restarts
- Password change invalidates existing tokens
- OS update check/upgrade works (when wisp-apt configured)

---

## Phase 12 — Deployment Scripts and Polish

**Goal:** Deployment automation and final polish.

### Scripts

- `setup-server.sh` — system package installation, groups, permissions, sanity checks, optional helper scripts
- `install.sh` — prerequisite validation + build delegation
- `wispctl.sh` — build, local start/stop/restart/status/logs, systemd install/uninstall/start/stop
- `push.sh` — rsync deploy + remote rebuild + restart
- `package.sh` — create deployment zip
- `vendor-novnc.sh` — clone noVNC into frontend vendor
- `ensure-novnc.js` — prebuild noVNC check
- Systemd service templates with placeholder substitution

### Polish

- Error handling audit: all vmManager errors correctly mapped to HTTP status
- All API calls show visible user-facing error feedback
- Loading states on all async operations
- Empty states: no VMs, empty library, empty snapshots, empty backups
- VM icon picker (icon stored in-memory per session)
- Visual polish: spacing, alignment, transitions (150ms)

### Acceptance

- `setup-server.sh`: all deps installed, groups/permissions correct, sanity checks pass
- `install.sh`: builds successfully, services start
- `push.sh`: rsync deploy works, services restart, access URL printed
- No unhandled promise rejections
- App fully functional with zero internet access on server
- vmManager is the only libvirt caller (verified by searching for dbus-next imports)
- No sleep/setTimeout for race conditions (only the 2s reconnect delay)
- No CDN assets

---

## Cross-Phase Rules

These rules apply to every phase:

1. **vmManager is the only DBus/libvirt caller.** No route or other module imports dbus-next.
2. **No sleep/setTimeout for race conditions.** The only permitted setTimeout is the 2-second reconnect in `linux/vmManager/vmManagerConnection.js`.
3. **No duplicated functionality.** Overview and Create VM share section components via `isCreating` prop.
4. **No CDN assets.** App must be fully functional offline. System fonts only.
5. **Error shape.** Backend: `{ code, message, raw? }` from vmManager. Routes: `{ error, detail }`.
6. **No regex for XML.** Use fast-xml-parser for all XML parsing and building.
7. **Streaming uploads.** File uploads pipeline to disk, never buffer entire file in memory.
8. **CPU topology.** Always full topology block in domain XML. Never flat vcpu alone.
9. **Dual CDROM.** Every VM defines sdc and sdd at creation, even empty.
