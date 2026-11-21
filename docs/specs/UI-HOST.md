# UI: the host pages

What the Host panel's tabs show, the image library and the backups list. The shell, the
sidebar and the shared components are in [UI.md](UI.md); the three shapes (view, edit,
act) are in `FRONTEND-RULES.md`, Data. Split from UI.md on 2026-11-22; the App Config
tab and Host Mgmt's Backup and Scheduled backups were rewritten then, the rest moved as
it was.

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

Accessed as the **Backups** tab inside the Host panel. Panel heading "Backups" with short description (backup coverage per workload; scheduler configured in Host Mgmt).

**One collapsible card per workload** (VM or container), not a flat table. Only workloads that **carry at least one backup** appear — plus two exceptions that also earn a card: a failed last backup attempt (the failure signal has no other surface) and a currently running backup/restore job. Backups whose workload no longer exists keep their card (dimmed, amber `workload deleted` badge). Workloads with zero backups are hidden — the first backup is started from the VM/container page (or by the scheduler). Live workloads sort first, then by name. Cards start collapsed; the header carries the full summary:

- Chevron, **workload name**, kind badge (`vm` / `container`).
- Containers: auto-backup badge — green `auto · daily HH:MM` (from `settings.backupSchedule`), `auto · scheduler off` when the toggle is on but the scheduler disabled, or a dashed `auto off`.
- **Status dot + line** from the `backups` events topic and the newest on-disk backup: green (recent good backup), amber (stale: >26 h for scheduled containers, >7 days otherwise), red `last attempt failed · good <rel>` (persisted attempt status), gray (no backups / deleted workload). While a backup or restore job for the workload runs, the status line is replaced by a spinner with the job title and percent.
- Backup count + total size.
- **Back up now** header action (accent `Plus`+`Archive` icon button) — opens the shared `BackupModal` (destination checkboxes, progress). Disabled for running VMs (title explains), `pausing`/`unknown` containers, deleted workloads, and while any job on the workload runs (its title the reason).

Expanding a card shows the backup table (shared DataTable chrome, actions on row hover):

| Column | Content |
|--------|---------|
| When | Timestamp folder name (mono) + relative time |
| Origin | `scheduled` (accent badge) / `manual` (outline badge) |
| Location | Destination label (Local, NAS, …) |
| Size | Formatted size |
| Actions | **Restore in place** (`ArchiveRestore`, container cards only), **Restore as new** (`CopyPlus`), **Delete** (`Trash2`) |

- **Restore in place** (containers only — VMs restore as new, [BACKUPS.md → Scope](BACKUPS.md#scope-settled-2026-10-16)) — enabled only when the container exists and is stopped (disabled title explains why). Opens a `ConfirmDialog` with a summary, a **safety backup** checkbox (default on), and a **type-the-name-to-confirm** input; on confirm the restore job registers in the background-jobs tray and the card header mirrors its progress.
- **Restore as new** — inline strip inside the card prompting for the new name (as before).
- **Delete** — shared `ConfirmDialog`.

Data flow: workload lists come from the `vms`/`containers` topics (container rows carry `autoBackup`); backup lists via one-time GETs re-fetched whenever the `backups` events topic pushes (attempt recorded, delete, prune) — no polling.
- Empty state (no backups anywhere): points to the VM/container pages to create the first backup.

---

## Host Panel

The Host panel is opened from the left panel "Host" entry. It uses the same layout pattern as the VM detail view: a header row with icon, name ("Host"), tabs, and action buttons.

### Header row

- **Left:** Server icon (non-clickable), "Host" label, tab strip: **Home** | **Overview** | **Host Mgmt** | **Software** | **Backups** | **App Config**. Height is fixed at **`h-11`** (44px) to match the left-sidebar Host row, the VM header, and the container header.
- **Right:** Power Off button, Restart button (each opens a simple confirmation dialog before executing)
- **Badge:** A dot on the "Software" tab when **either** a Wisp self-update is available (from `wispUpdate.available` in the host stats SSE) **or** pending OS package updates are available (background hourly check or manual check). The same dot serves both signals — clicking the tab takes the user to the Software panel where the relevant section explains which one.

### Tab: Home

The launcher, and the app's landing page — homelab-homepage tiles for the services this Wisp hosts, derived from data Wisp already holds. First tab, before Overview. No host-vitals strip: the top bar's `HostStatsBar` already carries it.

Components live in `frontend/src/components/home/` (`HomePanel.jsx`, `HomeGroup.jsx`, `HomeTile.jsx`, `HomeMotes.jsx`, `TileGroupPicker.jsx`, `ManualLinkModal.jsx`); data comes from `homeStore` subscribing to the **`home`** topic on `/api/events` (see [API-WORKSPACE.md](API-WORKSPACE.md)). The server sends the full `{ tiles, groups }` envelope, so the page is correct on first paint with **zero configuration**.

#### Tile derivation

Tiles are links, not workloads — **a workload with no published URL gets no tile** (the sidebar covers workloads). Three sources, descending priority, deduped by URL:

1. **App modules** — `getPublishedLinks(appConfig)` on any container carrying `metadata.app` (see [CUSTOM-APPS.md](CUSTOM-APPS.md)). Every app container is iterated; no container name is hardcoded, so zero, one, or many Caddy instances all work.
2. **Declared mDNS services** of type `_http._tcp` / `_https._tcp` on containers with Local DNS on → `http(s)://<hostname>.local:<port>`.
3. **Manual links** the user added.

Each derived link joins back to a workload by its **target** hostname (container name / `<name>.local` / running IP; VM name / guest hostname / `<guest hostname>.local`, the name the guest announces / IP) — that join is what gives the tile live state. A link whose target resolves to nothing (a Caddy host fronting another machine) renders as a **stateless external tile**. A link with no target at all — a Jellyfin `publishedUrl`, a zot `externalUrl`, an mDNS service — *is* its publisher's own address, so it joins to the publishing container. Manual links never join.

Same-URL collisions keep one tile: app beats mDNS beats manual, and within a tier the link whose backing container **runs** wins. The losers appear on the winner's `conflicts` and are surfaced in edit mode; a duplicate raised by the *same* publisher (a Jellyfin container that both publishes a URL and advertises `_http._tcp` on that port) is one fact stated twice and is not reported.

#### Layout — the "Lanterns" design

- **Header:** time-of-day greeting (`Good morning/afternoon/evening.` in `font-display`), a counts line (`5 lanterns lit · 3 asleep · 2 links live elsewhere on the network`), and **Edit home**.
- **Groups** render as small uppercase labels with a count over a `repeat(auto-fill, minmax(236px, 1fr))` grid. An empty group is hidden outside edit mode. The implicit **Ungrouped** group is always last and goes unlabelled when it is the only group (a zero-config page is just a grid).
- **Tile:** icon well + name + hostname. State is the light — a running workload's well glows and **breathes** (`wisp-breathe`, 4.2s), a stopped one wears an **asleep** chip on a dimmed card, an external one gets a flat ringed well and a `· elsewhere` suffix on its hostname and shows no state at all. An amber dot follows `updateAvailable`.
- **Right edge is one action lane**, both affordances always visible:
  - **Launch notch** — a 26×15px tab sitting *in* the top border at `right: 15px`, filling accent on hover. The whole tile opens the URL in a new tab; the notch is its cue.
  - **Cogwheel** below it, vertically centred, 28px, navigating to the workload's Wisp page. It renders outside the anchor (a button can't nest in a link) at `right: 15px` so its axis lands 29px from the card's outer edge — exactly where the notch's axis falls from inside the 1px border. External tiles have no cogwheel.
- **Ambient:** four blurred accent motes drift across the canvas on long unsynchronised loops.
- **Motion** — the breathing glow, the motes, and the tile transitions all carry `motion-reduce:` variants, so `prefers-reduced-motion` parks the page. A parked lantern is still lit: `home-lantern-lit` carries a static glow under the animation, which is what remains when the keyframes are switched off.
- Colours come only from the palette tokens; the canvas wash, glow, mote tints, and asleep-card shade are `color-mix` derivations of `--color-accent` / `--color-surface` declared in `index.css`.

**Home in the dark theme** *(settled 2026-08-25)*. Light and dark are two settings
of one system, not two designs — the theme only changes which way each mix goes.
Light **lifts toward white**; dark **sinks toward the surface and lets the accent
emit**:

| | Light | Dark |
|---|---|---|
| Canvas wash | `accent-soft` at 80%, a pale tint | the **accent itself** at 15→9→4% over the canvas, four stops (`accent-soft` is *darker* than the spruce canvas — reusing it would dim the corner instead of lighting it, and a two-stop ramp this wide bands visibly on a near-black surface) |
| Asleep tile | `surface` lifted 55% toward white | `surface-card` sunk 50% toward `surface` — the border keeps it a tile, the missing light keeps it unlit |
| Lit well fill | `accent-soft` → `accent-soft` toward white | `accent` mixed **into the card**, 42% at the centre → 13% at the edge: glass with a light behind it |
| Lit well ring / glow | `accent` 22% toward white, 18px @ 32% | `accent` @ 50%, 22px @ 42% |
| Breathe | 14px @ 24% ↔ 24px @ 42% | 18px @ 34% ↔ 30px @ 55% — a lantern is meant to be the brightest thing in a dark frame |
| Motes | accent @ 42% / pale @ 40% | accent @ 85% / `accent-text`-based pale @ 78%, so they read as actual wisps rather than smudges |

Every value is a variable on `:root`, overridden under `:root[data-theme='dark']`,
and read by both the `home-*` utilities **and the `wisp-breathe` keyframes**.
Keyframes are global, so a second dark keyframe set would have meant a second
animation name and a `dark:` class swap in `HomeTile`; one variable pair keeps
that out of the JSX, and a theme flip re-resolves it on the running animation.

#### Edit mode

**Edit home** toggles in-place controls (interaction style follows the sidebar's Organize mode); **Done** exits. The header gains **Add link** (`Plus`+`Link`, opens `ManualLinkModal` — a modal form editor) and **Add group** (`Plus`+`FolderPlus`, mints an auto-suffixed "New Group" and opens its rename input immediately).

- **Group labels** grow inline **ChevronUp** / **ChevronDown** (reorder), **Pencil** (rename) and **Trash2** (delete, confirm dialog; its tiles return to Ungrouped). Ungrouped has none of these.
- **Tiles** stop being links and grow a toolbar under their text: **Eye/EyeOff** (hide/show), **Pencil** (rename — inline input with confirm/cancel), **FolderInput** (move to group, popover listing every group plus "New group…"), **ChevronLeft/ChevronRight** (reorder within a real group), and **Trash2** for manual links only. The tile's **icon well itself is the icon button** — clicking it (accent ring on hover) opens the shared `IconPickerModal`.
- Hidden tiles stay visible in edit mode at reduced opacity with a dashed border so they can be brought back; outside edit mode they are not rendered.
- Renaming a **manual** link edits the link itself; renaming a **derived** tile writes an override, so the tile keeps tracking the workload it points at.

Empty state (no visible tiles): "No lanterns yet", explaining that a container with a published URL appears here on its own, and pointing at **Edit home → Add link** for everything else.

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

- **Network Bridges** — **`Network`** icon. Table with columns **Name**, **Parent**, **VLAN Id**, **Status**, **Actions**. Header **`Plus`+network** opens **`BridgeCreateModal`** (modal form editor: parent select, VLAN id, derived-name preview). Delete is icon-only on existing rows and available on phones.
- **Storage** — **`Server`** icon. Unified section for SMB shares (and, with disk support enabled, adopted removable drives). Read-only table rows; all create/edit flows use **modal form editors** (see [FRONTEND-RULES.md](../FRONTEND-RULES.md) § Modal form editor), so add/edit/adopt/delete work at every breakpoint: header **`Plus`+server** and row **Edit** open **`SmbShareEditorModal`** (label, share, mount path, username, password with keep-on-empty semantics; footer-left **Test connection** with inline OK/error text); drive row **Edit** and detected-drive **Adopt** open **`RemovableDriveEditorModal`** (read-only UUID/FS identity box, label, mount path, read-only + auto-mount checkboxes; NTFS forces read-only). Mount state is a **status dot before the label** (green mounted / gray unmounted-or-present / red disconnected, `title` tooltip) — there is no Status column. On phones the Actions column is hidden and **tapping a row expands its action strip** (mount, check, edit, delete) under the stacked text; on desktop actions stay in the hover-reveal Actions column. Mount state also tints the **mount/unmount** button background; row **Check** uses green/red on the shield button after an SMB test (error detail on hover). The **Detected drives** table is visible on phones (device cell stacks FS/size/mounted-at below `sm`).
- **Backup**: the local backup path and the second destination, as text, with an Edit. The second destination is none, or any mount from Storage, shown with its type (SMB share or drive).
- **Scheduled backups**: a switch (back up on schedule) that acts at once; the time, the destinations and what is kept, as text, with an Edit. The form holds the time, the destinations (Local, and the second destination when one is set; at least one), and how many days and weeks to keep (1 to 365 days, 0 to 52 weeks; a number outside is refused with a reason).

### Tab: Software

Scrollable page with **`px-6 py-5 space-y-5`**, same gutters as Overview / Host Mgmt. Two-column update grid (1 col below `lg`) on top, **Image Library** stacked below:

- **Wisp Update** (left) — **`Rocket`** **`titleIcon`**. Shared `UpdateCard` shell. Description shows current/latest version, plus a quiet "Beta channel — pre-releases included." note while the host is on beta. Buttons: **Check** / **Update** (Update disabled when no release is newer). A compact **Channel** select (Stable / Beta) sits in the card body above the status row — it PATCHes `settings.updateChannel` and then runs the normal check, reusing the Check button's busy state, so the card immediately reflects the new channel; disabled while checking or installing. When an update is available, a **Release notes** link opens an `UpdateDetailsModal` (centered overlay, ESC + backdrop close, "View on GitHub" link in the footer). Inline install banner replaces the status row while the install is running. Status row uses the unified state machine (success/warn/error icon + message, `Checked hourly` + relative-time `Checked Xm ago`). See [UPDATES.md](UPDATES.md).
- **OS Update** (right) — **`Package`** **`titleIcon`**. Same `UpdateCard` shell. Buttons: **Check** / **Update** (Update label gets a `· N` count badge when packages are pending; disabled when nothing to do). **View packages** link opens a `UpdateDetailsModal` listing each upgradable package (name, from→to versions) plus the total download size; the package list is fetched lazily from `GET /api/host/updates/packages` on first open and refetched after a fresh check or completed upgrade; the subtitle says when the check the list comes from ran (`checkedAt`, *not checked yet* before any), and the modal's refresh runs the check (`POST /api/host/updates/check`, then the list once its job is done) — reading the list never starts one. **Reboot-required banner** appears inline when `stats.rebootRequired` is true; it shows the reasons and a **Restart now** button that opens the existing host Restart confirm dialog. Status row mirrors the Wisp card.
- **Image Library** (below) — **`Images`** **`titleIcon`**, type filter and header icon actions (upload, URL download modal, Ubuntu/HA presets) in **`headerAction`**, then the file/OCI table in the card body. `ImageLibrary` is rendered with `mode="embedded"` so it contributes its `SectionCard` directly to the shared scroll, without its own outer scroll wrapper. See [IMAGE-LIBRARY.md](IMAGE-LIBRARY.md).

Both update cards share the same `UpdateCard` (`frontend/src/components/host/UpdateCard.jsx`) and `UpdateDetailsModal` (`UpdateDetailsModal.jsx`) so button labels, status icons, "Checked hourly" footer, and modal chrome stay aligned.

### Tab: Backups

Same as the former Backups panel: table of backups with restore/delete; description that backups are created from VM Overview and destinations are configured in Host Mgmt.

### Tab: App Config

Groups, in this order ([SETTINGS.md](SETTINGS.md)):

- **This server**: the name and the advertised URL, as text, with an Edit; LAN discovery as a switch that acts at once.
- **Storage paths**: the VM path and the image library path, with an Edit. The form says that what is already there stays where it is.
- **Password**: change the application password (current and new).
- **SSH keys**: the list of keys, with Add, Import from GitHub, a default mark, Rename and Remove.
- **Single sign-on**: issuer, client ID and whether a client secret is set, with an Edit; the redirect URI to register with the provider, with a copy action; a switch (sign in with SSO) that acts at once, off with its reason until issuer, client ID and secret are stored. The secret is write-only: the form's field is empty and keeps the stored one, and must be typed again when the issuer or client ID changes.
- **API tokens**: the tokens (label, scope, created), with create and revoke; a new token's text is shown once.
