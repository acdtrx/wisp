# UI Specification

Layout, visual system, navigation, and user-visible behavior for Wisp. **API request/response contracts** belong in [API.md](API.md). **Row-level save rules, table chrome, and documented exceptions** (e.g. VM NIC full-array save, container env full-map save) are in [UI-PATTERNS.md](../UI-PATTERNS.md).

## Design Language

**Inspiration:** Linear, Vercel — clean, professional, light theme with subtle depth.

### Color Scheme

| Token | Value | Usage |
|-------|-------|-------|
| `surface` | `#f8fafc` | Main background |
| `surface-sidebar` | `#f1f5f9` | Left panel background |
| `surface-card` | `#ffffff` | Card backgrounds |
| `surface-border` | `#e2e8f0` | All borders and dividers |
| `accent` | `#2563eb` | Primary actions, active states |
| `accent-hover` | `#1d4ed8` | Hover state for accent elements |
| `status-running` | `#16a34a` | Running VMs, success states |
| `status-warning` | `#d97706` | Paused VMs, warnings, restart-required |
| `status-stopped` | `#dc2626` | Stopped VMs, errors, danger actions |
| `status-transition` | `#2563eb` | Transitioning states (starting, shutting down) |
| `text-primary` | `#0f172a` | Primary text |
| `text-secondary` | `#475569` | Secondary text, descriptions |
| `text-muted` | `#94a3b8` | Muted text, labels, placeholders |

### Typography

System fonts only — no web fonts, no CDN font loading:

```
font-family: system-ui, -apple-system, sans-serif
```

### Favicon

`frontend/public/favicon.png` (32×32, alpha) and `favicon.svg`. `index.html` declares the PNG first, then the SVG (`sizes="any"`), so browsers that composite SVG favicons poorly still get a bitmap with reliable transparency; others can use the SVG for sharp scaling.

### Spacing and Shape

- **Card border radius:** 8px
- **Card shadow:** `0 1px 3px rgba(0,0,0,0.08)` — subtle, not dramatic
- **Transitions:** 150ms on all interactive state changes

### Section headings

Small all-caps muted label style: `11px, font-semibold, uppercase, tracking-wider, text-muted`. Not large headers.

### Repeating lists and tables

For row-based persistence, **header add** controls (`Plus` or `Plus`+kind icon), icon-only row actions, shared table layout, and exceptions (bulk NIC/env saves), see [UI patterns](../UI-PATTERNS.md) (`docs/UI-PATTERNS.md`). Implement table shells with [DataTableChrome.jsx](../../frontend/src/components/shared/DataTableChrome.jsx) (`DataTableScroll`, `DataTable`, head/body class exports, **`DataTableTh`** / **`DataTableTd`** for consistent **`px-4`** cell inset).

---

## App Shell Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  TOP BAR                                                                     │
├──────────────┬───────────────────────────────────────────────────────────────┤
│              │                                                               │
│  LEFT PANEL  │   CENTER PANEL                                                │
│  280px       │   (flex-1, scrollable)                                        │
│  fixed       │                                                               │
│  scrollable  │                                                               │
│              ├───────────────────────────────────────────────────────────────┤
│              │  VM STATS BAR (when VM selected)                              │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

- **Full height:** `flex h-screen flex-col`
- **Top bar:** Single row, fixed at top
- **Below top bar:** `flex flex-1 overflow-hidden`
- **Left panel:** Fixed width ~280px, full height below top bar, scrollable, `bg-surface-sidebar`
- **Center panel:** Fills remaining width, `bg-surface`, content scrollable
- **VM stats bar:** Fixed at bottom of center panel when a VM is selected

---

## Top Bar

Single row containing (left to right):

1. **Wisp logo/label** + server display name
2. **Host stats pills** — CPU, RAM, Disk I/O, Net I/O, **RUNNING** (running VM count and running container count as `monitor · n | box · m`, embedded inline, centered in the remaining width)
3. **Background jobs** — list icon, always rendered. Dimmed and non-interactive when no jobs exist; otherwise carries a badge count of *running* jobs and opens a dropdown listing in-progress and recently finished jobs (VM create, container create, VM backup, library downloads). Each row shows title, step, optional detail, and a **gradient progress bar** when a numeric percent is available (running), or a full **success** bar when the job completed. **Dismiss** appears for completed or failed jobs. Jobs are tracked app-wide so progress continues if you navigate away from the panel that started the operation. After a full page reload, the shell loads the in-memory job list from **GET /api/background-jobs** and re-subscribes to each job’s progress SSE (server is source of truth for titles; jobs disappear after server TTL or process restart).
4. **Sign out** — rightmost, icon-only (LogOut). Hits `POST /api/auth/logout` and broadcasts the multi-tab logout signal.

The top bar shows "Wisp" text and the server display name (from settings). There is no logo image. The **browser tab title** is `{server display name} — Wisp` after settings load (same name as the top bar; default **My Server** when unset), so multiple tabs to different servers are easy to tell apart. The host stats are live (SSE, every 5 seconds) and use the `StatPill` component with color thresholds. Host management, Backups, Software (OS Update + Image Library), and App Config are accessed via the **Host** entry in the left panel.

---

## Left Panel

### Host entry

A **Host** row appears above the Virtual Machines section. It shows a Server icon, the label "Host", a secondary line with physical CPU count and total RAM (same `formatMemory` style as VM list rows, from host stats SSE), and an optional badge dot when pending OS updates are available (from the background hourly check). Clicking it navigates to `/host/overview` and renders the Host panel in the center with tabs: Overview, Host Mgmt, Software, Backups, App Config. The Host row height is fixed at **`h-11`** (44px) to match the central-panel top bars, and has active state styling (accent border) when the Host panel is visible.

### Workloads — Header

"Workloads" label + **New VM** (Plus + Server) and **New Container** (Plus + Box) buttons on the right (icons only, tooltips describe the action).

### Search

Text input with placeholder for client-side instant filtering by workload name (VMs and containers when shown).

### Sort toggle

A small text button below the search: "○ Alphabetical" (default) or "● Running first" when toggled. Running-first sorts running VMs above stopped ones, then alphabetically within each group.

### Sections

Workloads are grouped under user-defined **sections**. A synthetic **Main** section (`id: "main"`) always exists implicitly and holds anything not explicitly assigned. Sections render as thin rule-with-label dividers (the same minimal style as the container Logs marker line). New workloads default to **Main**; users move them via the Organize toggle below. Empty Main is hidden when other sections exist (and when not in organize mode); empty user-defined sections stay visible so they can receive drops.

### Organize mode

A single full-width **Organize** button sits at the bottom of the sidebar (above the panel border). Toggling it puts the sidebar into editing mode:

- The button flips to an accent-filled **Done** state.
- Each workload row's start/stop/reboot/restart actions are replaced with a single **Move to section** icon (lucide `FolderInput`); clicking it opens a small popover listing every section + Main, with a check mark next to the current one. The popover also has a **+ New section…** entry at the bottom that mints a new section (default name with auto-suffix, auto-rename input opens immediately) and assigns the workload to it — same flow as dropping on the Create Section ghost zone.
- Row click navigation is suppressed (clicking a row does nothing while organizing) and the row gets a `cursor-grab` pointer.
- Workloads can be **drag-and-dropped** onto any section. The whole section block (header + items area) is the drop target — not just the thin header line — so dropping is forgiving. The block tints accent while a drag hovers it. The drag payload uses MIME type `application/x-wisp-workload` (`{ type, name }`).
- Section headers expose **ChevronUp** / **ChevronDown** (reorder), **Pencil** (rename) and **Trash** (delete) icon affordances inline. Up/down arrows are disabled at the top/bottom of the user-defined range; Main always stays at the top and is never reorderable. Deleting a section returns its workloads to Main; Main itself cannot be renamed or deleted.
- A **Create Section** ghost zone (dashed border, `FolderPlus` icon) renders at the bottom of the list. Dropping a workload onto it creates a new section (default name `New Section`, auto-suffixed if taken), assigns the workload, and auto-opens the new section's rename input so the user can give it a real name immediately. The ghost stays visible for further drops; it disappears on **Done**.
- Organize mode automatically exits when the user navigates away from the workloads view (route change), so stale edit state never leaks across views.

### VM list items

Each VM is a full-width flat row (no rounded corners, edge-to-edge in the list area; no gap between rows):

- **VM icon** (small, from icon picker or default by OS type) **colored by state** — green (running), grey (stopped), amber (paused), blue (transitioning). The icon appears before the name; there is no separate status dot.
- **VM name** (bold) on the same line as the icon
- **vCPU and RAM** summary on the line below in muted text (e.g. "4 vCPU / 4 GB")
- **Hover actions:** contextual action icons (Start / Stop / Reboot — only relevant ones shown), revealed on row hover. In organize mode these are replaced by the Move-to-section picker.

### Behavior

- VM list is updated via an SSE stream at a configurable interval (from Settings: refresh interval in seconds), not periodic GET requests.
- Click to select → loads Overview panel in center
- Selected VM uses the same active styling as Host entry: subtle card background with a left accent border only (no full outline or rounded corners)
- Escape key deselects the current VM
- Sorting: default alphabetical, toggle to running-first
- Sign out moved to the **top bar** (rightmost icon).

---

## View Switching

The center panel content is controlled by the URL. `AppLayout` is a shell that renders `TopBar`, `LeftPanel`, and a react-router `<Outlet />`; which route renders inside the outlet determines the view. Refreshing the browser restores the same view and tab.

| URL | Content |
|-----|---------|
| `/` | Redirects to `/host/overview` |
| `/host/:tab` | Host panel (`tab` ∈ `overview`, `host-mgmt`, `software`, `backups`, `app-config`) |
| `/vm/:name/:tab?` | Overview panel + VM Stats Bar (`tab` ∈ `overview`, `console`; default `overview`) |
| `/container/:name/:tab?` | Container Overview panel + Container Stats Bar (`tab` ∈ `overview`, `logs`, `console`; default `overview`) |
| `/create/vm` | Create VM panel |
| `/create/container` | Create Container panel |
| `/login` | Login page |
| `*` | Redirects to `/host/overview` |

VM/container selection is derived from the URL: `VmRoute` / `ContainerRoute` read `:name` from params and call `selectVM` / `selectContainer` on mount, `deselectVM` / `deselectContainer` on unmount. Tab buttons and sidebar list items call `navigate()` rather than setting store state.

---

## Login Page

Centered card with:
- Title "Wisp" and subtitle "Sign in to manage your VMs"
- Password input with placeholder "Enter password"
- Submit button labeled "Sign in" (shows "Signing in…" while loading)
- Error message in red on failed login

Redirects to the main app on success. The main app redirects here if no valid JWT is stored.

---

## VM Overview Panel

When a VM is selected, the center panel shows two tabs: **Overview** and **Console**.

### Header row

A single horizontal bar containing:

- **VM icon** — clickable, opens the Icon Picker modal. The icon is colored by VM state (green running, grey stopped, amber paused, blue transitioning); there is no separate status badge pill.
- **VM name** — bold, truncated if long, followed by a small muted **vm** pill (same style as the **container** pill on the container overview header)
- **Tabs** — Overview | Console (underline style with border-bottom; active tab has accent border + bold label)
- **Action buttons** (right-aligned): Start, Stop, Force Stop, Reboot, Suspend, Resume, (divider), Backup, Clone, Delete, View XML

Action buttons are **context-sensitive**: irrelevant ones are disabled with muted style, not hidden.

- **Clone** — opens dialog prompting for new VM name (user types the name; dialog starts with empty field)
- **Backup** — opens modal to select backup destinations; while a backup is running, **Continue in background** closes the dialog (job progress remains in the top bar). **Start** is disabled while a backup is in progress for this VM (including after the modal is dismissed).
- **Delete** — opens confirmation dialog with "Also delete disk images" checkbox
- **View XML** — opens modal with read-only domain XML and Copy button

### Error bar

A red bar below the header, visible on both tabs. Appears when an action or save fails. Includes a dismiss (X) button.

### Overview tab content

A single scrollable panel with section cards, in this order:

1. **General** — Name, Auto-start, OS Type (segmented: Linux/Windows), OS Variant (segmented, dependent on OS Type), CPU Cores, RAM (number + GB/MB toggle). Per-section dirty state and Save button.

2. **Disks** — `SectionCard` with header **+ New disk** / **+ Select image** (block disks) and **+ CD-ROM**. Create flow starts with no block disk rows; the same header actions add the first disk (`sda`) and, when `sda` is set, the second (`sdb`), using inline draft rows (confirm/cancel) like the overview flow for `sdb`. Table columns: **Disk**, **Size**, **Image**, **Image type** (e.g. qcow2, ISO, cloud-init), **Bus**, **Actions** (icon-only, hover-reveal). Fixed slot convention:
   - `sda` / `sdb` — block disks: **Actions** → **Edit** (pencil) puts the row in inline edit for **Size** and **Bus** (stopped VM); **Save** / **Cancel** apply or discard; **Unmount** remains in Actions. **New disk** / **Select image** on an existing VM opens an `sdb` draft row (inline size + bus, confirm runs create); **Select image** opens the image library, then an `sdb` draft row (optional resize-to-GB, bus, confirm runs attach and optional resize). **+ CD-ROM** opens the image library; a CD-ROM row appears only after an ISO is chosen (`sdc` then `sdd`).
   - `sdc` / `sdd` — CD-ROMs: row actions are **Change ISO** (opens the library to swap media) and **Eject** (clears the row). Attach, change, and eject all hot-plug while the VM is running — only the **+ CD-ROM** header button hides itself when both slots are filled.
   - `sde` — cloud-init seed ISO (read-only, shown when cloud-init enabled); **Actions** cell is empty (no em dash)

3. **USB Devices** — **Table** (DataTable chrome) of devices **attached to this VM** only; columns **Name**, **ID**, **Bus / device**, **Actions** (Detach, icon-only **hover-reveal** via `DataTableRowActions`). **Attach** in the section header (`Plus`+`Usb`) opens a modal (same shell as the image library picker) listing **available** host USB devices in a second table with **Attach** per row; a successful attach **closes** the modal (also dismiss via backdrop, close, or Escape — Escape does not deselect the VM). When the host reports no USB devices, the header control is disabled. Immediate actions, no Save button. Host list is driven by SSE (`/api/host/usb/stream`); VM-attached devices are fetched on load and after attach/detach.

4. **Network interfaces** — **Table** (DataTable chrome): one row per NIC (bridge, model, MAC, VLAN when applicable). **Add NIC** in section header (`Plus`+network). Stopped VM or create flow: rows as inputs where allowed; running VM: read-only row + **Edit** → inputs + row **Save**/**Cancel**. Persistence rules: [UI-PATTERNS.md](../UI-PATTERNS.md) § Variants (**VM — Network interfaces**). Row actions follow **hover-reveal** unless the row is editing or busy.

5. **Advanced** (collapsed by default) — Compact grid only (no NIC block): Firmware (BIOS/UEFI/UEFI+SecureBoot), Machine type (Q35/i440fx), CPU model, Video driver, Graphics, Boot order, Boot menu toggle, Memory balloon toggle, Guest agent toggle, vTPM toggle, VirtIO RNG toggle, Nested virt toggle, **Local DNS** toggle, Windows optimizations (read-only indicator). **Section Save** for these fields. Offline-only fields show a lock icon when VM is running.

6. **Cloud-Init** (hidden for Windows) — Read-only summary: Cloud Init on/off, hostname, username, masked password, SSH key status, option toggles. Edit opens the form; save with Cloud Init off soft-disables (ISO removed, json kept). **Remove** deletes cloud-init entirely. Regenerate rebuilds the ISO when enabled.

7. **Snapshots** — Compact table: Name, Created, State. **Create snapshot** via section header (`Plus`+camera) when the disk is qcow2; empty state points to that control. Row actions: Revert, Delete (icon-only, **hover-reveal**). Note about qcow2 requirement if applicable.

### Console tab

Console toolbar (permanent bar above viewport) + VNC console viewport. See [CONSOLE.md](CONSOLE.md).

---

## Create VM Panel

Replaces the center panel when "+ New VM" is clicked. No Console tab, no VM stats bar.

### Template selector

5 compact cards in a horizontal row at the top: Ubuntu Server, Ubuntu Desktop, Windows 11, Home Assistant OS, Custom. Defaults to Ubuntu Server. Selecting a template silently pre-fills all fields.

### Sections

Uses the same section components as Overview with `isCreating=true`:

- **General** — same fields as Overview, name field prominent
- **Disks** — same table layout and header actions as the overview Disks section (including **Image type** after **Image**). Block disks start empty; the user adds **sda** then **sdb** via **+ New disk** / **+ Select image**, with a draft row to confirm size, bus, and optional resize for existing images. Committed rows support **Remove disk** (minus), image pick/clear for existing images, and the same helper text about copies. **Second disk** appears only after the first is configured.
  - **CD-ROM:** Header **+ CD-ROM** opens the image library; a row for `sdc` or `sdd` appears only after an ISO is selected. Remove ISO clears the row.
- **Network interfaces** — same NIC table as Overview (`isCreating`)
- **Advanced** — same as Overview (grid only, no NICs), collapsed by default
- **Cloud-Init** — visible only for Existing Image + non-Windows/HAOS. Full editable form laid out in three rows:
  - **Row 1 (3 columns):** Hostname | Username | Password (with show/hide toggle)
  - **Row 2 (flex):** SSH Public Key single-line input (flex-1, monospace) | GitHub Username input (fixed width) | Fetch button. When GitHub returns multiple keys, a key-selector list appears below this row.
  - **Row 3 (5 columns on wide viewports):** **Cloud Init** (master toggle, default on) | Grow Partition | Package Upgrade | QEMU Guest Agent | Avahi Daemon. When Cloud Init is off, the other fields are disabled and creation skips the seed ISO.

### Create button

Sticky at the bottom of the center panel, always visible without scrolling. Shows spinner when creating. Inline progress text reflects the current step: Validating…, Copying image…, Creating disk…, Resizing disk…, Generating cloud-init ISO…, Defining VM…, Done ✓ (or Error on failure).

On error: red inline error card above button, with optional expandable raw detail.

---

## Image Library

See [IMAGE-LIBRARY.md](IMAGE-LIBRARY.md) for functionality. Accessed inside the **Software** tab of the Host panel (stacked below OS Update), and as a picker modal from VM creation/overview.

### Page mode layout (Host → Software tab)

- **`SectionCard`** (same visual shell as Host Overview sections): **`Images`** **`titleIcon`**, **`headerAction`** = type filter (All / ISO / Disk Image / OCI) plus VM-file **icon-only** actions — **Upload** (accent), **Download from URL**, **Ubuntu Cloud**, **Home Assistant** (URL opens a modal; download progress also in background jobs). When the **OCI** filter is active, a **Check for updates** icon button (`RefreshCw`, icon-only) appears in the header and a status line "Checked {relative} · N updated · N containers flagged" (or "Checking {ref} (i/total)…") appears above the table.
- Optional strip below the section header (inside the card) when uploading or when upload/preset errors need to be shown
- File table: filename, type badge, digest (OCI), size, last modified (**picker** modal omits **Digest** and **Modified**); **rename/delete** in the actions column use the shared **hover-reveal** row pattern (add/ingest controls stay in the **`SectionCard`** header, not in the HTML `<thead>`). OCI rows also have a per-row **Check this image** action (`RefreshCw`, hover-revealed; disabled while any check is running) next to **Delete**.

### Picker modal

Same layout but with Select button per file. Auto-filtered by context.

---

## Backups Panel

Accessed as the **Backups** tab inside the Host panel. Panel heading "Backups" with short description (restore as new VM or delete; create backups from VM Overview; configure destinations in Host → Host Mgmt).

Table of all backups across destinations:

| Column | Content |
|--------|---------|
| VM | Name of the backed-up VM |
| Location | Label (Local, NAS, etc.) |
| Timestamp | When the backup was created |
| Size | Total backup size (formatted) |
| Actions | Restore, Delete (icons **on row hover**, shared `DataTableRowActions`) |

- **Restore** opens a dialog prompting for new VM name
- **Delete** opens confirmation dialog
- Empty state: points to **Host → Host Mgmt → Backup** for paths and **VM Overview → Backup** to create a backup.

---

## Host panel: settings-related tabs

These are tabs inside the Host panel (not a separate `/settings` page):

Section-based layout:

1. **App Config tab** — General (server name, VM storage path, image library path, refresh interval). Save button. Password change (current + new, Change button).
2. **Host Mgmt tab** — **Network Storage** (SMB/CIFS mounts in a **table** with shared DataTable chrome; header **`Plus`+server** adds a row; icon-only row actions; **Pencil** enters inline edit, then save/cancel icons; combined **mount/unmount** control with **green background when mounted**; **Check** (shield) turns **green after success** and **red after failure** (failure text on hover), not inline under the row; delete as icon; no separate “mounted” text column); **Backup** (one row: local path input and network-mount select aligned to the same control height; optional `(none)` or one configured mount). **Software tab** renders **Wisp Update** and **OS Update** side-by-side in a 2-column grid (1 col below `lg`), then the **Image Library** stacked below.
3. **Overview tab** — Software section shows Wisp, Node.js, libvirt, QEMU, OS info (see Host Panel).

---

## Host Panel

The Host panel is opened from the left panel "Host" entry. It uses the same layout pattern as the VM detail view: a header row with icon, name ("Host"), tabs, and action buttons.

### Header row

- **Left:** Server icon (non-clickable), "Host" label, tab strip: **Overview** | **Host Mgmt** | **Software** | **Backups** | **App Config**. Height is fixed at **`h-11`** (44px) to match the left-sidebar Host row, the VM header, and the container header.
- **Right:** Power Off button, Restart button (each opens a simple confirmation dialog before executing)
- **Badge:** A dot on the "Software" tab when **either** a Wisp self-update is available (from `wispUpdate.available` in the host stats SSE) **or** pending OS package updates are available (background hourly check or manual check). The same dot serves both signals — clicking the tab takes the user to the Software panel where the relevant section explains which one.

### Tab: Overview

Scrollable content with section cards:

- **CPU** — One compact line: model, cores/threads, MHz, cache, load average (1/5/15 min), Temp: °C when available, **Power: W** only when the backend reports `cpuPowerWatts` (e.g. Intel RAPL on Linux); the line is omitted when power is unavailable (macOS, AMD, most VMs). Temp uses the primary CPU reading from backend sensor priority on Linux; when threshold metadata is available, hover tooltip shows max/critical values. Per-core usage bars below (from SSE).
- **Memory** — Subsection **Usage** only: Total, Used (blue dot), Cached (yellow dot), Buffers; RAM bar (used + cached, no swap); when swap present: Swap total, Swap used; swap bar under it. (RAM module details are in **Hardware** → Main.)
- **Storage** — Filesystem usage per mount point with bars (from /proc/mounts + statfs; network-namespace bind mounts under `/run/netns` are omitted). Block devices are listed under **Hardware** → Main.
- **Network** — **Table** (DataTable chrome, no row actions): columns **Interface**, **MAC**, **Speed**, **State** (per-adapter). Linux: from `/sys/class/net`. macOS: interfaces without a usable MAC are omitted from the list. Real-time I/O is in the top bar stats.
- **Software** — First line: Host, OS, Kernel, IP. Second line: Wisp, Node, libvirt, QEMU (versions).
- **Hardware** — Last section. Optional summary line: DMI board, system, and BIOS when available; **Motherboard:** temperature from the first ACPI `acpitz` thermal zone when present (tooltip explains platform vs CPU). A single table (columns **Type**, **Device**, **Vendor**, **Driver**, **Address**, **Temp**) with section separator rows (**Main**, **I/O**, **Misc**): **Main** — RAM modules (Type: form factor and slot; Device: type, size, speed, voltage; Vendor: manufacturer; Driver/Address/Temp: **—**); block devices (Type: Storage (NVMe/SSD/HDD) from device name and `rotational`; Device: first line model and size, second line disk health / SMART-derived summary without a `SMART:` prefix (health, power-on duration compact **M**/**D**/**H** (30-day months, e.g. `2m 3d 12h`), NVMe wear/spare when present, ATA SSD life % remaining and non-zero realloc/pending/uncorrectable counts when present) in smaller secondary text — temperature is **not** repeated here (see **Temp** column); warnings on a further line when present; Driver: kernel block name e.g. `nvme0n1`; Temp: SMART temp when present, else NVMe °C from stats SSE when matched); network PCI (`02xx`) and remaining storage PCI (`01xx`); when a block device’s `pciAddress` matches a PCI function, the **PCI controller row is shown first**, then the drive row(s) for that controller **below** it (indented **└** Type, same primary text colour as other inventory rows; optional subtle row background). **I/O** — Display (`03xx`), multimedia/audio (`04xx`), USB host controllers (`0c03`). **Misc** — remaining PCI (e.g. communication, SMBus). PCI bridge devices (class `0x06`) are omitted everywhere. **Temp** for PCI rows uses the stats SSE stream when `thermalZones` matches `pciAddress`; otherwise **—**.

### Tab: Host Mgmt

Scrollable page with **`px-6 py-5 space-y-5`**, same as Overview. Each block is a **`SectionCard`** with a **`titleIcon`** (same pattern as Overview):

- **Network Bridges** — **`Network`** icon. Table with columns **Name**, **Parent**, **VLAN Id**, **Status**, **Actions**. Header **`Plus`+network** adds an **inline table row** for create (fields + confirm/cancel icons). Delete is icon-only on existing rows.
- **Storage** — **`Server`** icon. Unified section for SMB shares (and, with disk support enabled, adopted removable drives). Table layout; header **`Plus`+server** adds a row; icon-only actions; mount state shown on the **mount/unmount** button background (e.g. green when mounted), not as a separate status label; **Check** uses green/red on the shield button after an SMB test (error detail on hover), not extra lines under the row; edit mode per row where applicable.
- **Backup** — **`Archive`** icon. Local backup path and extra-mount-for-backup select on one row (equal-height controls); optional `(none)` or a mount from Storage.

### Tab: Software

Scrollable page with **`px-6 py-5 space-y-5`**, same gutters as Overview / Host Mgmt. Two-column update grid (1 col below `lg`) on top, **Image Library** stacked below:

- **Wisp Update** (left) — **`Rocket`** **`titleIcon`**. Shared `UpdateCard` shell. Description shows current/latest version. Buttons: **Check** / **Update** (Update disabled when no release is newer). When an update is available, a **Release notes** link opens an `UpdateDetailsModal` (centered overlay, ESC + backdrop close, "View on GitHub" link in the footer). Inline install banner replaces the status row while the install is running. Status row uses the unified state machine (success/warn/error icon + message, `Checked hourly` + relative-time `Checked Xm ago`). See [UPDATES.md](UPDATES.md).
- **OS Update** (right) — **`Package`** **`titleIcon`**. Same `UpdateCard` shell. Buttons: **Check** / **Update** (Update label gets a `· N` count badge when packages are pending; disabled when nothing to do). **View packages** link opens a `UpdateDetailsModal` listing each upgradable package (name, from→to versions) plus the total download size; the package list is fetched lazily from `GET /api/host/updates/packages` on first open and refetched after a fresh check or completed upgrade. **Reboot-required banner** appears inline when `stats.rebootRequired` is true; it shows the reasons and a **Restart now** button that opens the existing host Restart confirm dialog. Status row mirrors the Wisp card.
- **Image Library** (below) — **`Images`** **`titleIcon`**, type filter and header icon actions (upload, URL download modal, Ubuntu/HA presets) in **`headerAction`**, then the file/OCI table in the card body. `ImageLibrary` is rendered with `mode="embedded"` so it contributes its `SectionCard` directly to the shared scroll, without its own outer scroll wrapper. See [IMAGE-LIBRARY.md](IMAGE-LIBRARY.md).

Both update cards share the same `UpdateCard` (`frontend/src/components/host/UpdateCard.jsx`) and `UpdateDetailsModal` (`UpdateDetailsModal.jsx`) so button labels, status icons, "Checked hourly" footer, and modal chrome stay aligned.

### Tab: Backups

Same as the former Backups panel: table of backups with restore/delete; description that backups are created from VM Overview and destinations are configured in Host Mgmt.

### Tab: App Config

- **General** — Server display name, VM storage path, image library path, refresh interval (seconds). Save button when dirty.
- **Password** — Change application password (current + new).

---

## Component Patterns

### SectionCard

The primary container for all form sections. Features:

- **Shell:** `rounded-card border border-surface-border bg-surface-card` — white card on the page background.
- Title (11px uppercase muted label); optional `titleIcon` (Lucide **14px**, `strokeWidth={2}`, decorative icon before the title — Host Overview, Host Mgmt, Image Library, and other host-style sections)
- Optional: collapsible (chevron icon), collapsed state — **right-side controls** (restart badge, Save, `headerAction`) do not trigger collapse (`stopPropagation` on that cluster)
- Optional: "Restart required" amber badge (left of Save in the header right cluster)
- Optional: Save button (appears when `isDirty`, before `headerAction`)
- Optional: lock icon with "Offline only" message
- Optional: error message (red banner below header)
- Optional: **`headerAction`** — placed **last** on the right (e.g. **add** = accent **`Plus`+kind icon**); primary place for collection **add** actions
- Content area separated by border-top

### ConfirmDialog

Modal dialog for destructive actions:
- Overlay: fixed inset-0, z-50, centered
- Backdrop: black/30 opacity
- Content: rounded card with shadow
- Title, message, optional checkbox, Cancel/Confirm buttons
- Escape key to close (via `useEscapeKey` hook)

### StatPill

Compact inline stat display:
- Label + value
- Optional slim progress bar with color thresholds (green/amber/red)
- Used in both host stats bar and VM stats bar

### Toggle

Boolean switch component with on/off states.

### Segmented Control

Row of toggle buttons in a rounded container with a subtle inner background. Used for binary or small-set choices (OS Type, firmware, NIC model, etc.).

### Action Buttons

Three variants:
- **Default:** bordered, secondary text, hover background
- **Primary:** accent background, white text
- **Danger:** red-bordered, red text, red hover background

All buttons: disabled state at 40% opacity, not-allowed cursor.

### Modals

- Overlay: `fixed inset-0 z-50 flex items-center justify-center`
- Backdrop: `absolute inset-0 bg-black/30`
- Content: `relative z-10 rounded-card bg-surface-card shadow-lg`
- Close via Escape key

### Tables

Used in Image Library, Backups, Snapshots, and other DataTable-based lists. On **Host** tabs, table views are normally wrapped in **`SectionCard`** (see [UI-PATTERNS.md](../../UI-PATTERNS.md) §Section shell) so the list sits in the same bordered card as Overview sections.

- Shared chrome from [DataTableChrome.jsx](../../frontend/src/components/shared/DataTableChrome.jsx): **`dataTableInteractiveRowClass`** on body rows that have hover-reveal actions, and **`DataTableRowActions`** for the actions cell (`opacity-0 group-hover:opacity-100`; **`forceVisible`** when editing or loading)
- `border-b border-surface-border` between rows (via head/body row classes)

### Form inputs

- `.input-field` class: rounded border, focus ring in accent color, disabled state
- Labels: 11px uppercase tracking-wider muted text
- Number inputs: no spinner (custom class hides webkit spinners)

---

## Icon System

- **UI icons:** lucide-react (tree-shakeable, no CDN).
- **VM icons:** Custom selectable set; default follows OS type. Choice is **persisted** in libvirt domain metadata (`iconId` via the VM config API).
- **Container icons:** Same picker; **`iconId`** is stored in the container’s persisted config.

---

## Empty States

- **No VMs in list:** Left panel shows "No virtual machines" and "Click \"+ New VM\" to create one". Center panel shows "Select a VM or create a new one".
- **Search with no matches:** Left panel shows "No matches for \"…\"" with the search term.
- **Empty library (VM files):** Message pointing to the **upload** control in the **section** header. **All** (Host Library page): empty when there are neither VM files nor OCI images. **OCI** filter: empty state explains containerd images and that images in use by a container cannot be deleted until those containers are removed or reconfigured.
- **No snapshots:** "No snapshots" message
- **No backups:** Empty table with message pointing to **Host → Host Mgmt → Backup** for destinations and **VM Overview → Backup** to create backups.

---

## Loading States

- Async operations show a spinner (`Loader2` icon with `animate-spin`)
- Action buttons show spinner and disable during the operation
- Section save buttons show spinner while saving
- Create VM button shows spinner with progress text

---

## Keyboard Shortcuts

- **Escape:** While a VM or container view is open (`/vm/:name/...` or `/container/:name/...`), navigates back to `/host/overview`. Handled inside `VmRoute` / `ContainerRoute`. Does **not** close tabs within the Host panel.
- **Escape in modals:** Overlays that use `useEscapeKey` and mark their content panel with **`data-wisp-modal-root`** take precedence: the route-level Escape handler skips when that attribute is in the DOM so the overlay closes first. Image Library, USB attach, confirms, etc. follow this pattern.

---

## Container Views

Containers share the same unified list in the left panel as VMs. They use the **Box** icon by default (or a user-chosen icon from the same picker as VMs); the image name appears as a subtitle instead of vCPU/memory specs.

### Left Panel (updated)

- **Workloads header** replaces "Virtual Machines" — with two create buttons: **New VM** (Plus + Server icons only) and **New Container** (Plus + Box icons)
- **Type filter** segmented control: All | VMs | Containers (default: All)
- Merged list sorted alphabetically (or running-first), search filters across both types

### Container List Item

- **Icon**: user-selected workload icon or default **Box**, colored by state (green=running, gray=stopped)
- **Name**: container name, with a small orange **Update** pill when the image update checker has flagged this container (`updateAvailable`)
- **Subtitle**: shortened OCI image reference
- **Hover actions**: Start (if stopped), Stop (if running), Restart (if running)

### Container Overview Panel

Header bar with:
- **Icon** — clickable, opens the Icon Picker (same set as VMs), colored by state; default matches **Box**
- Container name + **container** badge (muted pill)
- Tabs: **Overview** | **Logs** | **Console**
- Action buttons: Start, Stop, Kill, Restart, Delete

When `config.updateAvailable` is `true`, an orange banner sits above the tab content: "New image version available. Restart to apply." The message has no button of its own — the user restarts via the primary **Restart** action button in the header row just above. `startExistingContainer` detects the digest drift and re-prepares the snapshot from the new image layers (see CONTAINERS.md → *Image updates*). `updateAvailable` is a derived backend field — it's only ever `true` when the container is running (or paused) with a digest older than the library's current one; stopped containers always read as `false`.

#### Overview tab

Sections (each in a SectionCard):

1. **General** — Name (read-only), image, command override, **CPU Cores**, **Memory (MiB)**, **Restart Policy** (segmented control ~18rem wide — between the ~15.5rem compact and ~26rem wide bars), **Auto Start** (same `Toggle` as VM Advanced). Labels align on one row with CPU/RAM.
2. **Environment Variables** — **Table** (DataTable chrome); header **`Plus`+braces** adds a row; **view** / **Edit** / row **Save**/**Cancel**; remove icon-only; **no section Save**. Persistence: [UI-PATTERNS.md](../UI-PATTERNS.md) (**Container environment** — full **`env`** map on row save, documented exception).
3. **Mounts** — Section header: **Plus + File** / **Plus + Folder** (add mount). **Table:** type icon, container path, mount name, **Source**, **Sub-path**, read-only toggle, actions. Source is `Local` by default; for **directory** mounts the dropdown also lists configured **Storage** mounts (from Host Mgmt → Storage). When a Storage source is picked, **Sub-path** becomes an editable relative path (empty = mount root; leading `/` and `..` rejected). File mounts are always Local (Source column shows a static "Local" label). Rows whose Source references a missing or not-currently-mounted Storage entry surface an **`AlertCircle`** icon with hover tooltip. Zip upload is disabled for Storage-sourced rows with tooltip "Zip upload is available on Local mounts only". Mutations use **row-scoped** container mount APIs (add / update / delete / upload); see [UI-PATTERNS.md](../UI-PATTERNS.md) and [CONTAINERS.md](CONTAINERS.md). **Hover-reveal** actions when not editing; per-row edit/save/cancel where applicable.
4. **Network** — **Local DNS** toggle, Type, **interface selector** (host bridge list), **IP** (from CNI/DHCP; shows "—" until known), **MAC** (persisted; **Stop** required to edit — input + **Save**, shuffle button to randomize like VM Advanced NICs), **Status** (**Up** / **Down**). Section header shows offline-only lock while the task is running, paused, or pausing.

   **Exposed Ports** subsection (rendered below the network fields when the container has exposed ports or any configured services): pill-row of ports + an inline disclosure strip for per-port mDNS service editing.

   - **Pills:** one per port. EXPOSE-derived ports use a solid border; user-added ports (configured service on a port not in EXPOSE) use a dashed border. A small `Radio` icon appears inside the pill when a service is configured (no color encoding — icon presence is the state). Tooltip shows the service type when configured.
   - **`+` pill:** trailing dashed pill — clicking opens the strip in *add* mode with an empty Port input so users can advertise on a port the image did not declare.
   - **Inline disclosure strip:** clicking a pill (or `+`) opens the strip directly below the pill row inside the same SectionCard. **One strip open at a time.** Switching pills discards unsaved changes silently. Strip layout: type dropdown sourced from the built-in catalog (SMB, HTTP, HTTPS, SSH, SFTP, FTP, IPP, IPPS, WebDAV, AFP, NFS, RDP, VNC) plus a **Custom…** option that reveals a free-text type input. Selecting a known type pre-fills sensible TXT defaults (e.g. `path=/` for HTTP, `rp=ipp/print` for IPP). TXT records are an editable list of key/value pairs with **+ add TXT** and per-row remove. Footer: **Remove advertisement** (when editing existing) on the left; **Cancel** / **Save** on the right.
   - **Local DNS gating:** when `localDns` is off, pills render inert (no hover, no `+`, no strip) with a small helper line "Enable Local DNS to advertise services". Toggle Local DNS on (and **Save** the section) to activate the per-pill editor.
   - **Persistence:** mutations use the row-scoped service endpoints (`POST` / `PATCH` / `DELETE` `/api/containers/:name/services[/:port]`); no section Save button. Container is refreshed after each mutation.

#### Logs tab

Full-height log viewer:
- Filter input for searching log lines
- Auto-scroll toggle button
- Line count indicator
- SSE-streamed live log data

#### Console tab

Lazy-loaded (`ContainerConsolePanel`). **xterm.js** terminal + toolbar (Paste, Fullscreen, Disconnect/Reconnect). Connects to **`/ws/container-console/:name`** with JWT; live I/O is WebSocket binary frames (see [API.md](API.md)). When the container is **not** running, shows a short message to start the container first (no shell session).

### Create Container Panel

- Back button to return to default view
- Short explanation: new containers stay **stopped** after create so settings can be configured on the overview before **Start**
- **App selector**: dropdown in the General section header (right). Options: "Generic Container" (default) plus each registered app (e.g. "Caddy Reverse Proxy"). Selecting an app prefills the image field with the app's default image (editable when `allowCustomImage` is true).
- **General** section: **Name** and **Image** only (same SectionCard as overview, create mode)
- Create button with progress (validating → pulling → creating → done); no env/network/app config on this screen — configure on the container overview after creation

### Custom App Container Overview

When `config.metadata?.app` is set and recognized:
- **Overview tab** replaces ContainerEnvSection + ContainerMountsSection with the app's dedicated component (e.g. CaddyAppSection) wrapped in AppConfigWrapper
- ContainerGeneralSection and ContainerNetworkSection remain unchanged
- **pendingRestart badge** in the header (visible across all tabs) when `config.pendingRestart` is true
- **Eject button** below the app component — converts to generic container (one-way, with confirmation dialog). See [CUSTOM-APPS.md](CUSTOM-APPS.md).

### Container Stats Bar

Bottom bar (same position as VM stats bar):
- CPU%, Memory (used / limit), Uptime, **IP** (LAN address from `network.ip` when known — same idea as VM guest IP), PID
- Optional **mDNS** pill (`<hostname>.local`) when Local DNS is enabled and registration is active
- Shows "Stopped" or "Paused" when not running
