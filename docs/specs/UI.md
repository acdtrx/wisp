# UI Specification

Layout, visual system, navigation, and user-visible behavior for Wisp. **API request/response contracts** belong in [API.md](API.md) and its `API-*.md` area files. **Row-level save rules, table chrome, and documented exceptions** (e.g. VM NIC full-array save, container env full-map save) are in [FRONTEND-RULES.md](../FRONTEND-RULES.md), UI patterns.

## Design Language

The palette, both themes, typography and the shared list, table and modal patterns are
[`FRONTEND-RULES.md`](../FRONTEND-RULES.md), Design and UI patterns.

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
│              │                                                               │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

- **Full height:** `flex h-dvh flex-col` (`dvh` so mobile browser chrome doesn't hide the bottom)
- **Top bar:** fixed at top; one row at `lg` and up, two below
- **Below top bar:** `flex flex-1 overflow-hidden`
- **Left panel:** Fixed width ~280px, full height below top bar, scrollable, `bg-surface-sidebar`
- **Center panel:** Fills remaining width, `bg-surface`, content scrollable

### Responsive behavior (below `lg`, 1024px)

The desktop shell above applies at `lg` and up. Below 1024px (phones, portrait tablets):

- **Tailwind classes only** *(settled 2026-08-25)*: express every breakpoint as a class; no JavaScript reads the viewport size (the container console's `ResizeObserver` fits the terminal to its element, which is not viewport detection).
- **Left panel becomes an off-canvas drawer** below the top bar's first row (`fixed top-[calc(3rem+env(safe-area-inset-top))] bottom-0` — the `h-12` row plus whatever the top bar's `pt-safe` added — full-width on phones, 280px from `sm`) over a `bg-black/40` backdrop, toggled by a hamburger (`Menu` ↔ `X`) button that appears leftmost in the top bar. It closes on backdrop tap, Escape, and any route change. Drawer state lives in `uiStore.sidebarOpen`.
- **Top bar splits into two rows** — first row: hamburger + brand + server name on the left, jobs + sign-out on the right; second row: the host stats pills full-width (left-aligned, horizontally scrollable). At `lg`+ it's the single centered-stats row.
- **Row actions are always visible** — the desktop hover-reveal (`lg:opacity-0 lg:group-hover:opacity-100`) only applies at `lg`+; touch devices see the lifecycle/table actions directly, with larger hit targets (`p-2` below lg).
- **Detail headers wrap** — the VM/container/host header rows (`min-h-11 flex-wrap`) break into title / actions rows instead of clipping. Below `lg` the action cluster becomes a **full-width horizontally-scrollable row** (primary actions leftmost and always visible; swipe for the rest — nothing is dropped). The VM tab strip is hidden (Overview is the only tab once Console is hidden) and **View XML** (a debug affordance) is desktop-only; the container keeps its Overview/Logs tabs on the title row. Host power buttons become icon-only.
- **Consoles are desktop-only** — the VM Console and container Console tab buttons are hidden below `lg` (container Logs stays). Create flows and drag-to-organize remain desktop-oriented (the tap-based section picker still works).
- **Content gutters** shrink to `px-4 py-4`; modal overlays carry `p-4` so dialogs never sit edge-to-edge; wide tables keep their horizontal scroll.
- **Wide data tables collapse to the essential columns** — Host Overview (network, hardware), Image Library, and Host Mgmt (SMB, removable drives, bridges) hide secondary columns below `sm` and stack their values on a muted second line inside the first cell, so each fits without horizontal scroll.
- **Host Mgmt is fully manageable on phones** — SMB shares, removable drives, and bridges create/edit through modal form editors (`SmbShareEditorModal`, `RemovableDriveEditorModal`, `BridgeCreateModal` — see `docs/FRONTEND-RULES.md` § Modal form editor); row actions expand under the row on tap below `sm`. The Backup form (path + network-mount select) reflows inline.
- **Touch devices render form controls at ≥16px** *(settled 2026-08-25)* — iOS Safari auto-zooms the page whenever a focused `input` / `select` / `textarea` computes below 16px, and never zooms back out, so a `(hover: none) and (pointer: coarse)` block in `index.css` floors every text-entry control at `max(16px, 1em)` and floors `input-field`'s height at 34px (the dense `h-7` / `h-8` row variants otherwise clip the taller text). Pointer devices keep the designed `text-sm` / `text-xs` sizes exactly. Deliberately a pointer query, not a `max-sm:` variant — an iPad in landscape is wider than `sm` and still touch. The `maximum-scale=1` viewport meta was rejected: it stops the zoom by disabling pinch-zoom for everyone. The block is unlayered because Tailwind's size utilities live in the utilities layer and would win over `@layer base`; components must not try to opt out with a smaller `text-*` class.
- **Safe-area insets keep chrome off the iOS home indicator.** `index.html` sets `viewport-fit=cover`, which is what makes `env(safe-area-inset-*)` report real values; the `pt-safe` / `pb-safe` / `px-safe` utilities (`index.css`) then apply them. This matters most for a bar at the bottom of the screen: launched from the home screen the app renders edge-to-edge, and a horizontally-scrollable strip sitting in the bottom gesture band gets its swipes taken by the iOS app switcher instead of scrolling. Each bar wraps its `h-11` scroll row in a `pb-safe` element that carries the border and card background, so the pills sit above the band and the card colour still paints the indicator strip. Same treatment on the drawer's Organize footer. `px-safe` on the app shell and the drawer keeps them out of the landscape notch; `pt-safe` on the top bar means the shell never slides under the status bar, and the drawer's top offset is written against it. All inert where the insets are `0` (desktop, Android, notch-less phones, and iOS's default opaque status bar).
- **The VM and container pages are fully manageable on phones**: the same groups in one column, forms as a sheet from the bottom ([UI-VM.md](UI-VM.md), [UI-CONTAINER.md](UI-CONTAINER.md)).
- **USB devices** — the ID column is hidden below `sm` (Name gets the room), and the bus/device cell shows bare numbers (`<bus> · <device>`) under the "Bus / device" header on all screen sizes instead of repeating the `Bus …`/`Device …` labels.
- **PWA-lite:** `manifest.webmanifest` (standalone display, teal theme color) + apple-touch-icon, so Wisp can be pinned to a phone home screen. A service worker keeps the app shell for a launch with the server unreachable (`docs/ARCHITECTURE.md`, Offline shell); there is no offline use.

---

## Top Bar

At `lg` and up, a single row containing (left to right):

1. **Wisp logo/label** + server display name. When other Wisp instances are discovered on the LAN (the `discovery` topic on `/api/events`, see [DISCOVERY.md](DISCOVERY.md)), the server name grows a small chevron (`ChevronDown`) and becomes a dropdown trigger; the menu lists each discovered server (display name, plus the advertised URL's hostname and version muted underneath — the label reflects where the link goes, not the mDNS SRV host) and each row opens that server's URL in a **new tab**. With zero peers the name renders as plain text — no chevron, no button.
2. **Host stats pills** — CPU, RAM, Disk I/O, Net I/O, **RUNNING** (running VM count and running container count as `monitor · n | box · m`, embedded inline, centered in the remaining width)
3. **Background jobs** — list icon, always rendered. Dimmed and non-interactive when no jobs exist; otherwise carries a badge count of *running* jobs and opens a dropdown listing in-progress and recently finished jobs — every job, whatever started it. Each row shows title, step, optional detail, and a **gradient progress bar** when a numeric percent is available (running), or a full **success** bar when the job completed. **Dismiss** appears for completed or failed jobs. Jobs are tracked app-wide so progress continues if you navigate away from the panel that started the operation. After a full page reload, the shell loads the in-memory job list from **GET /api/jobs** and re-subscribes to each job’s progress SSE (`GET /api/jobs/:jobId/progress`, one route for every kind) (server is source of truth for titles; jobs disappear after server TTL or process restart). A finished row leaves the tray 5 minutes after it finished — the server's TTL, measured the same way from completion — each row on its own clock (one timer, re-armed for the next expiry).
4. **Theme** — icon-only three-state control (`Sun` / `Moon` / `Monitor`) cycling light → dark → system. See § Design Language → Theme activation and persistence.
5. **Sign out** — rightmost, icon-only (LogOut). Hits `POST /api/auth/logout` and broadcasts the multi-tab logout signal.

The top bar shows "Wisp" text and the server display name (from settings; rendered by `ServerSwitcher.jsx`). There is no logo image. The **browser tab title** is `{server display name} — Wisp` after settings load (same name as the top bar; default **My Server** when unset), so multiple tabs to different servers are easy to tell apart — which is also why discovered peers open in a new tab. The host stats are live (SSE, every 5 seconds) and use the `StatPill` component with color thresholds. Host management, Backups, Software (OS Update + Image Library), and App Config are accessed via the **Host** entry in the left panel.

---

## Left Panel

### Host entry

A **Host** row appears above the Virtual Machines section. It shows a Server icon, the label "Host", a secondary line with physical CPU count and total RAM (same `formatMemory` style as VM list rows, from host stats SSE), and an optional badge dot when pending OS updates are available (from the background hourly check). Clicking it navigates to `/host/overview` and renders the Host panel in the center with tabs: Home, Overview, Host Mgmt, Software, Backups, App Config. The Host row height is fixed at **`h-11`** (44px) to match the central-panel top bars, and has active state styling (accent border) when the Host panel is visible.

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
- **VM name** (bold) on the same line as the icon, followed by a small amber **restart dot** when the VM needs a stop + start: its restart-required flag is set (`pendingRestart` non-null, tooltip *saved changes apply on the next start*) or its qemu binary was replaced since it started (`staleBinary`)
- **vCPU and RAM** summary on the line below in muted text (e.g. "4 vCPU / 4 GB")
- **Hover actions:** contextual action icons (Start / Stop / Reboot — only relevant ones shown), revealed on row hover. In organize mode these are replaced by the Move-to-section picker.

### Behavior

- VM list is updated by the `vms` topic of the SSE stream, sent when the list changes, not by periodic GET requests.
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
| `/` | Redirects to `/host/home` |
| `/host/:tab` | Host panel (`tab` ∈ `home`, `overview`, `host-mgmt`, `software`, `backups`, `app-config`) |
| `/vm/:name/:tab?` | The VM page, [UI-VM.md](UI-VM.md) (`tab` ∈ `overview`, `console`; default `overview`) |
| `/container/:name/:tab?` | The container page, [UI-CONTAINER.md](UI-CONTAINER.md) (`tab` ∈ `overview`, `logs`, `console`; default `overview`) |
| `/create/vm` | Create VM panel |
| `/create/container` | Create Container panel |
| `/login` | Login page |
| `*` | Redirects to `/host/home` |

`/host/home` is the app's landing page: `/`, a bare `/host`, and any unknown path all land there, as does a host tab id that doesn't exist. The top-bar brand (glyph + wordmark) is a button back to `/host/home` from anywhere. Escape from a VM/container view and the "back to host" actions still go to `/host/overview` — those mean "leave this workload", not "go home"; the left panel's Host row likewise opens `/host/overview`, the host's own page.

VM/container selection is derived from the URL: the VM and container routes read `:name` from the path and select that workload while they are mounted, deselecting it when they unmount. Tab buttons and sidebar list items call `navigate()` rather than setting store state. A page shows the workload its URL names, so switching quickly from A to B always ends on B (see [ERROR-HANDLING.md](ERROR-HANDLING.md) § Stale responses).

**A workload that is gone** (settled 2026-11-20): when the server answers that the workload a page names does not exist — deleted from another tab, by an agent, or never there (a mistyped or stale URL) — the page says so ("No VM named `x`", "No container named `x`") with a way back to the host overview. It never spins and never leaves on its own. While the workload's configuration loads, the header paints from its list entry and the sections wait. A workload renamed elsewhere is followed: when its page finds it gone and the list holds the same workload under a new name, the page moves to that name.

---

## Login Page

Centered card with:
- Title "Wisp" and subtitle "Sign in to manage your server"
- Password input with placeholder "Enter password"
- Submit button labeled "Sign in" (shows "Signing in…" while loading)
- Error message in red on failed login

Redirects to the main app on success. The main app redirects here if no valid session cookie is present.

**SSO (when configured).** On load the page queries `GET /api/auth/oidc/status`. If SSO is enabled **and** the URL has no `?sso=` marker, it auto-redirects to the provider (a spinner shows during the check so the password form doesn't flash). If it returns from a cancelled or failed attempt (`?sso=cancelled` / `?sso=error`), from a server where SSO is off (`?sso=disabled`), or from a sign-out (`?sso=signedout`, "You are signed out."), it shows a notice and the password form with a **"Sign in with SSO"** button below the Sign in button (separated by an "or" divider) so the user can retry SSO or fall back to the password. The `?sso=` marker is what prevents an auto-redirect loop. See [AUTH.md](AUTH.md) § OIDC.

A failed sign-in that never reached the server (VPN down, no network) shows **"Can't reach Wisp. Check your VPN or network connection."** rather than the browser's raw `fetch` message.

---

## Server Unreachable Screen

Shown by `ProtectedRoute` when the boot probe (`GET /api/host`) fails — the app is installed to a home screen and launched away from the VPN, or the service is restarting. It replaces what used to be a blank page.

Centered card matching the Login page, with:
- The Wisp glyph, then a round tinted badge (`bg-status-stopped-soft`) holding a status icon
- **Offline** (request never reached the server, including a timeout): `WifiOff`, title "Can't reach Wisp", body "Your device can't reach the server. If you're away from home, connect to your VPN and try again."
- **Server** (server answered with an HTTP error): `ServerCrash`, title "Wisp isn't responding", body "The server answered, but Wisp is not ready yet. It may be restarting or finishing an update."
- Full-width accent **Retry** button (`RefreshCw`). Deliberately static — it never shows a pending/disabled state. A probe against an unreachable server settles in a couple of milliseconds, so reflecting it would flash the button on every backoff tick.
- Footer hint: "Retrying automatically. Wisp reconnects on its own once the server is reachable."

The screen re-probes on its own (backoff 1 s → 15 s, plus immediately on `online` and on tab re-focus), so it clears itself once the VPN is back — the button only skips the wait.

**Boot spinner.** While the first probe is in flight the route renders nothing for 500 ms (so a fast load never flashes), then a centered spinner (`FullScreenSpinner`, shared with the Login SSO check). The page is never left blank indefinitely.

**Offline fallback page.** If the service worker has no cached shell at all (worker installed while offline, or storage evicted), it serves a small self-contained HTML page with the same "Can't reach Wisp" copy and a Retry link. Inline styles only — the CSP forbids inline scripts.

---

## Render Error Screen

Shown by `AppErrorBoundary` (wraps the router in `main.jsx`) when any component throws during render — the alternative is React unmounting the whole tree to a blank page, which an iOS home-screen launch can't even reload from. One boundary for the whole app *(settled 2026-10-16)*: it is a last resort, not a substitute for handling bad data where it arrives.

Same centered card as the Server Unreachable screen: the Wisp glyph, a `bg-status-stopped-soft` badge with `AlertTriangle`, title "Something went wrong", body "Wisp hit an unexpected error while drawing this page. Reloading usually fixes it.", the error message in small muted monospace, and a full-width accent **Reload** button (`RefreshCw`) that reloads the page. React logs the error itself; the boundary adds no logging.

---

## The VM page

The VM page: [UI-VM.md](UI-VM.md). Its Console tab: [CONSOLE.md](CONSOLE.md).

---

## New VM

The New VM form: [UI-VM.md](UI-VM.md), New VM.

---

## The host pages

The Host panel's tabs, the image library and the backups list: [UI-HOST.md](UI-HOST.md).

---

## Component Patterns

### Cards

A page's content sits in cards: a title in sentence case (with an optional icon and
help icon), the card's actions as icon buttons at the right of its header, and its
content. A card holds values as text, a list, or a table; it never holds a form with a
Save. An error of the card's own shows in it, below the header, and can be dismissed.

### ConfirmDialog

Modal dialog for destructive actions: title, message, optional checkbox, Cancel/Confirm
buttons. It is a modal like any other (`docs/FRONTEND-RULES.md`, Modals and dialogs).

### StatPill

Compact inline stat display:
- Label + value
- Optional slim progress bar with color thresholds (green/amber/red)
- Used in the host stats bar

### Toggle

Boolean switch component with on/off states.

### Radio Pills

Content-sized single-choice chips (`shared/RadioPills.jsx`): selected = accent-soft wash + accent border, unselected = muted border; optional per-option icons; groups wrap instead of stretching. The app-wide control for binary/small-set form choices (OS Type, firmware, CPU model, NIC model, restart policy, disk add mode) — replaced the full-width segmented bars (settled 2026-08-29). The segmented style survives only in the sidebar's type filter, which is view chrome rather than a form field.

### Action Buttons

Three variants:
- **Default:** bordered, secondary text, hover background
- **Primary:** accent background, white text
- **Danger:** red-bordered, red text, red hover background

All buttons: disabled state at 40% opacity, not-allowed cursor.

### Modals

The card is centred; below `sm` every modal is a sheet from the bottom, full width
(settled 2026-11-21). Backdrop, layer, focus and Escape: `docs/FRONTEND-RULES.md`,
Modals and dialogs.

### Tables

Used in Image Library, Backups, and other DataTable-based lists. On **Host** tabs, table views are normally wrapped in **`SectionCard`** (see [FRONTEND-RULES.md](../FRONTEND-RULES.md) §Section shell) so the list sits in the same bordered card as Overview sections.

- Shared chrome from [DataTableChrome.jsx](../../frontend/src/components/shared/DataTableChrome.jsx): **`dataTableInteractiveRowClass`** on body rows that have hover-reveal actions, and **`DataTableRowActions`** for the actions cell (hover-reveal at `lg` and up only, always visible below; **`forceVisible`** when editing or loading)
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
- **Home tiles:** Same picker. A tile inherits the `iconId` of the workload it points at (or its own, for a manual link) and falls back to `globe`; the picker writes a per-tile override in the `homepage` config.

---

## Empty States

- **No VMs in list:** Left panel shows "No virtual machines" and "Click \"+ New VM\" to create one". Center panel shows "Select a VM or create a new one".
- **Search with no matches:** Left panel shows "No matches for \"…\"" with the search term.
- **Empty library (VM files):** Message pointing to the **upload** control in the **section** header. **All** (Host Library page): empty when there are neither VM files nor OCI images. **OCI** filter: empty state explains containerd images and that images in use by a container cannot be deleted until those containers are removed or reconfigured.
- **No backups:** a message pointing to the VM and container pages to create the first backup.

---

## Loading States

- Every view that reads has a loading, an empty and an error state (settled 2026-11-20): a loading line or skeleton until its first read answers; its own empty text when the read holds nothing; its read's error, with a Retry when nothing is shown yet, or dismissible above the data already shown, which stays.
- Async operations show a spinner (`Loader2` icon with `animate-spin`)
- Action buttons show spinner and disable during the operation
- Create VM button shows spinner with progress text

---

## Keyboard Shortcuts

- **Escape:** While a VM or container view is open (`/vm/:name/...` or `/container/:name/...`), navigates back to `/host/overview`. Handled inside `VmRoute` / `ContainerRoute`. Does **not** close tabs within the Host panel.
- **Escape in modals:** an open modal, popover or drawer takes Escape first: it closes the top layer, and the route-level handler stands down while any layer is open (`docs/FRONTEND-RULES.md`, Modals and dialogs).

---

## Container Views

Containers share the same unified list in the left panel as VMs. They use the **Box** icon by default (or a user-chosen icon from the same picker as VMs); the image name appears as a subtitle instead of vCPU/memory specs.

### Left Panel (updated)

- **Workloads header** replaces "Virtual Machines" — with two create buttons: **New VM** (Plus + Server icons only) and **New Container** (Plus + Box icons)
- **Type filter** segmented control: All | VMs | Containers (default: All)
- Merged list sorted alphabetically (or running-first), search filters across both types

### Container List Item

- **Icon**: user-selected workload icon or default **Box**, colored by state (green=running, gray=stopped)
- **Name**: container name, with a small orange **Update** pill when the image update checker has flagged this container (`updateAvailable`), and an amber **Restarting in N s** pill (`ScheduledRestartBadge`) while the restart policy has a restart scheduled (`scheduledRestart`)
- **Subtitle**: shortened OCI image reference
- **Hover actions**: Start (if stopped), Stop (if running, or stopped with a scheduled restart — cancels it), Restart (if running)

### The container page

The container page and New container: [UI-CONTAINER.md](UI-CONTAINER.md).
