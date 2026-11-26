# UI: the host pages

What the Host panel's tabs show, the image library and the backups list. The shell, the
sidebar and the shared components are in [UI.md](UI.md); the three shapes (view, edit,
act) are in `FRONTEND-RULES.md`, Data.

## Image Library

See [IMAGE-LIBRARY.md](IMAGE-LIBRARY.md) for functionality. Accessed inside the **Software** tab of the Host panel (stacked below OS Update), and as a picker modal from VM creation/overview.

- The card's header holds the type filter (All / ISO / Disk Image / OCI) and the actions for VM files: **Upload**, **Download from URL**, and a menu of named images (Ubuntu Server cloud, Arch Linux cloud, Home Assistant OS); download progress also shows in background jobs. When the **OCI** filter is active, the header's **Upload** takes an image archive (a `.tar`) instead of a VM file, its import showing in background jobs, and a **Check for updates** action appears in the header and a status line "Checked {relative} · N updated · N containers flagged" (or "Checking {ref} (i/total)…") appears above the table.
- File table: filename, type badge, digest (OCI), size, last modified; **rename/delete** per row. OCI rows also have a per-row **Check this image** action (disabled while any check is running) next to **Delete**. A `localhost/` image's row has no **Check this image**.
- **Picker modal:** the same table with a Select button per file, auto-filtered by context; it omits **Digest** and **Modified**.

---

## Backups Panel

Accessed as the **Backups** tab inside the Host panel. Panel heading "Backups" with short description (backup coverage per workload; scheduler configured in Host Mgmt).

**One collapsible card per workload** (VM or container), not a flat table. Only workloads that **carry at least one backup** appear — plus two exceptions that also earn a card: a failed last backup attempt (the failure signal has no other surface) and a currently running backup/restore job. Backups whose workload no longer exists keep their card (dimmed, amber `workload deleted` badge). Workloads with zero backups are hidden — the first backup is started from the VM/container page (or by the scheduler). Live workloads sort first, then by name. Cards start collapsed; the header carries the full summary:

- **Workload name**, kind badge (`vm` / `container`).
- Containers: auto-backup badge — green `auto · daily HH:MM` (from `settings.backupSchedule`), `auto · scheduler off` when the toggle is on but the scheduler disabled, or a dashed `auto off`.
- **Status dot + line** from the `backups` events topic and the newest on-disk backup: green (recent good backup), amber (stale: >26 h for scheduled containers, >7 days otherwise), red `last attempt failed · good <rel>` (persisted attempt status), gray (no backups / deleted workload). While a backup or restore job for the workload runs, the status line is replaced by a spinner with the job title and percent.
- Backup count + total size.
- **Back up now** header action — opens the backup dialog (destination checkboxes, progress). Disabled for running VMs (title explains), `pausing`/`unknown` containers, deleted workloads, and while any job on the workload runs (its title the reason).

Expanding a card shows the backup table:

| Column | Content |
|--------|---------|
| When | Timestamp folder name + relative time |
| Origin | `scheduled` / `manual` |
| Location | Destination label (Local, NAS, …) |
| Size | Formatted size |
| Actions | **Restore in place** (container cards only), **Restore as new**, **Delete** |

- **Restore in place** (containers only — VMs restore as new, [BACKUPS.md → Scope](BACKUPS.md#scope-settled-2026-10-16)) — enabled only when the container exists and is stopped (disabled title explains why). Opens a confirm dialog with a summary, a **safety backup** checkbox (default on), and a **type-the-name-to-confirm** input; on confirm the restore job registers in the background-jobs tray and the card header mirrors its progress.
- **Restore as new** — inline strip inside the card prompting for the new name.
- **Delete** — asks first.

Data flow: workload lists come from the `vms`/`containers` topics (container rows carry `autoBackup`); backup lists via one-time GETs re-fetched whenever the `backups` events topic pushes (attempt recorded, delete, prune) — no polling.
- Empty state (no backups anywhere): points to the VM/container pages to create the first backup.

---

## Host Panel

The Host panel is opened from the left panel "Host" entry. It uses the same layout pattern as the VM detail view: a header row with icon, name ("Host"), tabs, and action buttons.

### Header row

- **Left:** "Host" label, tab strip: **Home** | **Overview** | **Host Mgmt** | **Software** | **Backups** | **App Config**.
- **Right:** Power Off button, Restart button (each opens a simple confirmation dialog before executing)
- **Badge:** A dot on the "App Config" tab while the last attempt to get or renew the host's certificate failed (`certificateFailed` in the host stats SSE); the Certificate group says why. A dot on the "Software" tab when **either** a Wisp self-update is available (from `wispUpdate.available` in the host stats SSE) **or** pending OS package updates are available (background hourly check or manual check). The same dot serves both signals — clicking the tab takes the user to the Software panel where the relevant section explains which one.

### Tab: Home

The launcher, and the app's landing page — homelab-homepage tiles for the services this Wisp hosts, derived from data Wisp already holds. First tab, before Overview. No host-vitals strip: the top bar already carries it.

Data comes from the **`home`** topic on `/api/events` (see [API-WORKSPACE.md](API-WORKSPACE.md)). The server sends the full `{ tiles, groups }` envelope, so the page is correct on first paint with **zero configuration**.

#### Tile derivation

Tiles are links, not workloads — **a workload with no published URL gets no tile** (the sidebar covers workloads). Three sources, descending priority, deduped by URL:

1. **App modules** — `getPublishedLinks(appConfig)` on any container carrying `metadata.app` (see [CUSTOM-APPS.md](CUSTOM-APPS.md)). Every app container is iterated; no container name is hardcoded, so zero, one, or many Caddy instances all work.
2. **Declared mDNS services** of type `_http._tcp` / `_https._tcp` on containers with Local DNS on → `http(s)://<hostname>.local:<port>`.
3. **Manual links** the user added.

Each derived link joins back to a workload by its **target** hostname (container name / `<name>.local` / running IP; VM name / guest hostname / `<guest hostname>.local`, the name the guest announces / IP) — that join is what gives the tile live state. A link whose target resolves to nothing (a Caddy host fronting another machine) renders as a **stateless external tile**. A link with no target at all — a Jellyfin `publishedUrl`, a zot `externalUrl`, an mDNS service — *is* its publisher's own address, so it joins to the publishing container. Manual links never join.

Same-URL collisions keep one tile: app beats mDNS beats manual, and within a tier the link whose backing container **runs** wins. The losers appear on the winner's `conflicts` and are surfaced in edit mode; a duplicate raised by the *same* publisher (a Jellyfin container that both publishes a URL and advertises `_http._tcp` on that port) is one fact stated twice and is not reported.

#### Layout — the "Lanterns" design

- **Header:** time-of-day greeting (`Good morning/afternoon/evening.`), a counts line (`5 lanterns lit · 3 asleep · 2 links live elsewhere on the network`), and **Edit home**.
- **Groups** render as small labels with a count over a grid of tiles. An empty group is hidden outside edit mode. The implicit **Ungrouped** group is always last and goes unlabelled when it is the only group (a zero-config page is just a grid).
- **Tile:** icon well + name + hostname. State is the light — a running workload's well glows and **breathes**, a stopped one wears an **asleep** chip on a dimmed card, an external one gets a flat ringed well and a `· elsewhere` suffix on its hostname and shows no state at all. An amber dot follows `updateAvailable`.
- **Two actions, both always visible:** the whole tile opens the URL in a new tab (a launch notch in its top border is the cue), and a cogwheel navigates to the workload's Wisp page. External tiles have no cogwheel.
- **Motion** — the breathing glow, the ambient motes, and the tile transitions all stop under `prefers-reduced-motion`. A parked lantern is still lit: a static glow remains.
- Colours come only from the palette tokens.

**Home in the dark theme** *(settled 2026-08-25)*. Light and dark are two settings
of one system, not two designs — the theme only changes which way each mix goes.
Light **lifts toward white**; dark **sinks toward the surface and lets the accent
emit**.

#### Edit mode

**Edit home** toggles in-place controls (interaction style follows the sidebar's Organize mode); **Done** exits. The header gains **Add link** (a modal form) and **Add group** (mints an auto-suffixed "New Group" and opens its rename input immediately).

- **Group labels** offer reorder, rename and delete (asks first; its tiles return to Ungrouped). Ungrouped has none of these.
- **Tiles** stop being links and offer hide/show, rename, move to group (every group plus "New group…"), reorder within a real group, and delete for manual links only. Clicking the tile's icon well opens the icon picker.
- Hidden tiles stay visible in edit mode at reduced opacity with a dashed border so they can be brought back; outside edit mode they are not rendered.
- Renaming a **manual** link edits the link itself; renaming a **derived** tile writes an override, so the tile keeps tracking the workload it points at.

Empty state (no visible tiles): "No lanterns yet", explaining that a container with a published URL appears here on its own, and pointing at **Edit home → Add link** for everything else.

### Tab: Overview

Section cards, in this order. What each figure is and where it comes from: [HOST-MONITORING.md](HOST-MONITORING.md).

- **CPU** — model, cores/threads, MHz, cache, load average (1/5/15 min), temperature when available (its tooltip shows the max and critical values when the thresholds are known), and **Power: W** only when the backend reports `cpuPowerWatts`; per-core usage bars below.
- **Memory** — total, used, cached, buffers; the RAM bar is used plus cached, without swap; swap total and used, with a bar of their own, when swap is present.
- **Storage** — filesystem usage per mount point.
- **Network** — one row per adapter: interface, MAC, speed, state. Real-time I/O is in the top bar stats.
- **Software** — host, OS, kernel, IP; Wisp, Node, libvirt and QEMU versions.
- **Hardware** — board, system and BIOS when available, the motherboard temperature when present; one table (Type, Device, Vendor, Driver, Address, Temp) of RAM modules, block devices (model, size, disk health, temperature) and PCI devices, in three sections: **Main** (RAM modules, drives, network and storage controllers), **I/O** (display, audio, USB host controllers) and **Misc** (the rest). A drive is listed under its PCI controller; its temperature is the SMART one when present, else the NVMe reading from the stats stream; its power-on time is shown compactly in months, days and hours (30-day months, `2m 3d 12h`). PCI bridge devices are omitted.

### Tab: Host Mgmt

Each block is a card:

- **Network Bridges** — table with columns **Name**, **Parent**, **VLAN Id**, **Status**, **Actions**. Create is a modal form (parent select, VLAN id, derived-name preview). Delete is available on phones.
- **Storage** — SMB shares and adopted removable drives. Read-only table rows; all create/edit flows use **modal form editors** (see [FRONTEND-RULES.md](../FRONTEND-RULES.md) § Modal form editor), so add/edit/adopt/delete work at every breakpoint. The share form: label, share, mount path, username, password with keep-on-empty semantics, and **Test connection** with inline OK/error text. The drive form (row **Edit**, and **Adopt** on a detected drive): the UUID and filesystem as text, label, mount path, read-only + auto-mount checkboxes; NTFS forces read-only. Mount state is a **status dot before the label** (green mounted / gray unmounted-or-present / red disconnected) — there is no Status column. An SMB row's **Check** shows its result on the button: green when the connection is fine, red when it failed, with the error as its tooltip. On phones **tapping a row expands its actions** (mount, check, edit, delete) under it. The **Detected drives** table is visible on phones.
- **Backup**: the local backup path and the second destination, as text, with an Edit. The second destination is none, or any mount from Storage, shown with its type (SMB share or drive).
- **Scheduled backups**: a switch (back up on schedule) that acts at once; the time, the destinations and what is kept, as text, with an Edit. The form holds the time, the destinations (Local, and the second destination when one is set; at least one), and how many days and weeks to keep (1 to 365 days, 0 to 52 weeks; a number outside is refused with a reason).

### Tab: Software

Two update cards side by side (one column below `lg`), **Image Library** stacked below. Both cards have the same shape: **Check** / **Update** buttons and a status row (success/warn/error icon + message, `Checked hourly` + relative-time `Checked Xm ago`).

- **Wisp Update** — shows current/latest version, plus a quiet "Beta channel — pre-releases included." note while the host is on beta. Update is disabled when no release is newer. A compact **Channel** select (Stable / Beta) PATCHes `settings.updateChannel` and then runs the normal check, so the card immediately reflects the new channel; disabled while checking or installing. When an update is available, a **Release notes** link opens the notes, with a "View on GitHub" link. An install banner replaces the status row while the install is running. See [UPDATES.md](UPDATES.md).
- **OS Update** — the Update label gets a `· N` count badge when packages are pending; disabled when nothing to do. A **View packages** link opens a list of each upgradable package (name, from→to versions) plus the total download size; the package list is fetched lazily from `GET /api/host/updates/packages` on first open and refetched after a fresh check or completed upgrade; the subtitle says when the check the list comes from ran (`checkedAt`, *not checked yet* before any), and the modal's refresh runs the check (`POST /api/host/updates/check`, then the list once its job is done) — reading the list never starts one. A **Reboot-required banner** appears inline when `stats.rebootRequired` is true; it shows the reasons and a **Restart now** button that opens the existing host Restart confirm dialog.
- **Image Library** — [above](#image-library).

### Tab: Backups

The Backups view described under [Backups Panel](#backups-panel) above.

### Tab: App Config

Groups, in this order ([SETTINGS.md](SETTINGS.md)):

- **This server**: the name and the advertised URL, as text, with an Edit; LAN discovery as a switch that acts at once.
- **Storage paths**: the VM path and the image library path, with an Edit. The form says that what is already there stays where it is.
- **Password**: change the application password (current and new).
- **SSH keys**: the list of keys, with Add, Import from GitHub, a default mark, Rename and Remove.
- **Single sign-on**: issuer, client ID and whether a client secret is set, with an Edit; the redirect URI to register with the provider, with a copy action; a switch (sign in with SSO) that acts at once, off with its reason until issuer, client ID and secret are stored. The secret is write-only: the form's field is empty and keeps the stored one, and must be typed again when the issuer or client ID changes.
- **Certificate** ([CERTIFICATES.md](CERTIFICATES.md)): the domain and whether a Cloudflare token is set, as text, with an Edit (the token's field is empty and keeps the stored one). Below them the state: valid until a date and renewing around a date; getting the certificate, while its job runs; or the last attempt's failure with its message and time, beside the certificate that still serves, if any. **Renew now** starts the job. **Remove** asks first, saying that the sites of the Caddy apps stop being served. With no setting the group says what the certificate is for and offers Set up.
- **API tokens**: the tokens (label, scope, created), with create and revoke; a new token's text is shown once. Create offers the three scopes ([AUTH.md](AUTH.md#the-agent-scope)), **Agent** chosen, each with a line on what it allows: Read-only (see everything, change nothing), Agent (build, run and update containers; no deletes, no VMs, no host), Admin (everything a token can do).
