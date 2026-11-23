# UI Specification

Layout, visual system, navigation, and user-visible behavior for Wisp. **API request/response contracts** belong in [API.md](API.md) and its `API-*.md` area files. **Row-level save rules, table chrome, and documented exceptions** (e.g. VM NIC full-array save, container env full-map save) are in [FRONTEND-RULES.md](../FRONTEND-RULES.md), UI patterns.

## Design Language

The palette, both themes, typography and the shared list, table and modal patterns are
[`FRONTEND-RULES.md`](../FRONTEND-RULES.md), Design and UI patterns.

---

## App Shell Layout

A top bar fixed at the top; below it a left panel (about 280px wide, scrollable) and a center panel that fills the remaining width and scrolls. The app is as tall as the visible viewport (`dvh`), so mobile browser chrome doesn't hide the bottom.

### Responsive behavior (below `lg`, 1024px)

The desktop shell above applies at `lg` and up. Below 1024px (phones, portrait tablets):

- **Tailwind classes only** *(settled 2026-08-25)*: express every breakpoint as a class; no JavaScript reads the viewport size (the container console's `ResizeObserver` fits the terminal to its element, which is not viewport detection).
- **Left panel becomes an off-canvas drawer** below the top bar's first row (full-width on phones, 280px from `sm`) over a backdrop, toggled by a hamburger button that appears leftmost in the top bar. It closes on backdrop tap, Escape, and any route change.
- **Top bar splits into two rows** — first row: hamburger + brand + server name on the left, jobs + sign-out on the right; second row: the host stats pills full-width (left-aligned, horizontally scrollable). At `lg`+ it's the single centered-stats row.
- **Row actions are always visible** — the desktop hover-reveal only applies at `lg`+; touch devices see the lifecycle/table actions directly, with larger hit targets.
- **Detail headers wrap** — the VM/container/host header rows break into title / actions rows instead of clipping. Below `lg` the action cluster becomes a **full-width horizontally-scrollable row** (primary actions leftmost and always visible; swipe for the rest — nothing is dropped). The VM tab strip is hidden (Overview is the only tab once Console is hidden) and **View XML** (a debug affordance) is desktop-only; the container keeps its Overview/Logs tabs on the title row. Host power buttons become icon-only.
- **Consoles are desktop-only** — the VM Console and container Console tab buttons are hidden below `lg` (container Logs stays). Create flows and drag-to-organize remain desktop-oriented (the tap-based section picker still works).
- **Wide data tables collapse to the essential columns** — Host Overview (network, hardware), Image Library, and Host Mgmt (SMB, removable drives, bridges) hide secondary columns below `sm` and stack their values on a muted second line inside the first cell, so each fits without horizontal scroll.
- **Host Mgmt is fully manageable on phones** — SMB shares, removable drives, and bridges create/edit through modal form editors; row actions expand under the row on tap below `sm`.
- **Touch devices render form controls at ≥16px** *(settled 2026-08-25)* — every text-entry control computes at 16px or more on a touch device, because iOS Safari zooms the page on a smaller focused control and never zooms back out. Pointer devices keep the designed sizes exactly. It is a pointer query, not a width breakpoint: an iPad in landscape is wide and still touch. Not the `maximum-scale=1` viewport meta, which disables pinch-zoom for everyone. Components must not opt out with a smaller text class.
- **Safe-area insets keep chrome off the iOS home indicator.** A bar at the bottom of the screen, the drawer's Organize footer, the app shell and the top bar are padded by the safe-area insets (`viewport-fit=cover`), so a horizontally-scrollable strip never sits in the bottom gesture band, where iOS takes its swipes for the app switcher, and nothing slides under the notch or the status bar. All inert where the insets are `0`.
- **The VM and container pages are fully manageable on phones**: the same groups in one column, forms as a sheet from the bottom ([UI-VM.md](UI-VM.md), [UI-CONTAINER.md](UI-CONTAINER.md)).
- **PWA-lite:** `manifest.webmanifest` (standalone display, teal theme color) + apple-touch-icon, so Wisp can be pinned to a phone home screen. A service worker keeps the app shell for a launch with the server unreachable (`docs/ARCHITECTURE.md`, Offline shell); there is no offline use.

---

## Top Bar

At `lg` and up, a single row containing (left to right):

1. **Wisp label** + server display name. There is no logo image. When other Wisp instances are discovered on the LAN (the `discovery` topic on `/api/events`, see [DISCOVERY.md](DISCOVERY.md)), the server name becomes a dropdown trigger; the menu lists each discovered server (display name, plus the advertised URL's hostname and version muted underneath — the label reflects where the link goes, not the mDNS SRV host) and each row opens that server's URL in a **new tab**. With zero peers the name renders as plain text — no chevron, no button.
2. **Host stats pills** — CPU, RAM, Disk I/O, Net I/O, **RUNNING** (running VM count and running container count), centered in the remaining width. Live (SSE, every 5 seconds), with color thresholds.
3. **Background jobs** — always rendered. Dimmed and non-interactive when no jobs exist; otherwise carries a badge count of *running* jobs and opens a dropdown listing in-progress and recently finished jobs — every job, whatever started it. Each row shows title, step, optional detail, and a progress bar when a numeric percent is available (running), or a full success bar when the job completed. **Dismiss** appears for completed or failed jobs. Jobs are tracked app-wide so progress continues if you navigate away from the panel that started the operation. After a full page reload, the shell loads the job list from **GET /api/jobs** and follows each job's progress again (the server is the source of truth for titles; jobs disappear after the server TTL or a process restart). A finished row leaves the tray 5 minutes after it finished — the server's TTL, measured the same way from completion — each row on its own clock.
4. **Theme** — icon-only three-state control cycling light → dark → system ([FRONTEND-RULES.md](../FRONTEND-RULES.md), Design).
5. **Sign out** — rightmost, icon-only. Hits `POST /api/auth/logout` and broadcasts the multi-tab logout signal.

The **browser tab title** is `{server display name} — Wisp` after settings load (same name as the top bar; default **My Server** when unset), so multiple tabs to different servers are easy to tell apart — which is also why discovered peers open in a new tab. Host management, Backups, Software (OS Update + Image Library), and App Config are accessed via the **Host** entry in the left panel.

---

## Left Panel

### Host entry

A **Host** row appears above the workloads. It shows the label "Host", a secondary line with physical CPU count and total RAM, and a badge dot when pending OS updates are available (from the background hourly check). Clicking it navigates to `/host/overview` and renders the Host panel in the center with tabs: Home, Overview, Host Mgmt, Software, Backups, App Config. It has active state styling (accent border) when the Host panel is visible.

### Workloads

VMs and containers share one list.

- **Header:** "Workloads" label + **New VM** and **New Container** buttons on the right (icons only, tooltips describe the action).
- **Type filter:** All | VMs | Containers (default: All).
- **Search:** client-side instant filtering by workload name, across both types.
- **Sort toggle:** alphabetical (default) or running first, which sorts running workloads above stopped ones, then alphabetically within each group.
- VM list is updated by the `vms` topic of the SSE stream, sent when the list changes, not by periodic GET requests.
- Clicking a row opens the workload's page. The selected row uses the same active styling as the Host entry.

### Sections

Workloads are grouped under user-defined **sections**. A synthetic **Main** section (`id: "main"`) always exists implicitly and holds anything not explicitly assigned. New workloads default to **Main**; users move them via the Organize toggle below. Empty Main is hidden when other sections exist (and when not in organize mode); empty user-defined sections stay visible so they can receive drops.

### Organize mode

A single full-width **Organize** button sits at the bottom of the sidebar. Toggling it puts the sidebar into editing mode (the button reads **Done** while it is on):

- Each workload row's start/stop/reboot/restart actions are replaced with a single **Move to section** icon; clicking it opens a small popover listing every section + Main, with a check mark next to the current one. The popover also has a **+ New section…** entry at the bottom that mints a new section (default name with auto-suffix, auto-rename input opens immediately) and assigns the workload to it — same flow as dropping on the Create Section zone.
- Row click navigation is suppressed (clicking a row does nothing while organizing).
- Workloads can be **drag-and-dropped** onto any section. The whole section block (header + items area) is the drop target — not just the thin header line.
- Section headers expose reorder (up / down), rename and delete. Up/down are disabled at the top/bottom of the user-defined range; Main always stays at the top and is never reorderable. Deleting a section returns its workloads to Main; Main itself cannot be renamed or deleted.
- A **Create Section** zone renders at the bottom of the list. Dropping a workload onto it creates a new section (default name `New Section`, auto-suffixed if taken), assigns the workload, and auto-opens the new section's rename input. It stays visible for further drops; it disappears on **Done**.
- Organize mode automatically exits when the user navigates away from the workloads view (route change), so stale edit state never leaks across views.

### VM list items

- **VM icon** (from icon picker or default by OS type) **colored by state** — green (running), grey (stopped), amber (paused), blue (transitioning). There is no separate status dot.
- **VM name** followed by a small amber **restart dot** when the VM needs a stop + start: its restart-required flag is set (`pendingRestart` non-null, tooltip *saved changes apply on the next start*) or its qemu binary was replaced since it started (`staleBinary`)
- **vCPU and RAM** summary on the line below in muted text (e.g. "4 vCPU / 4 GB")
- **Hover actions:** Start / Stop / Reboot — only relevant ones shown. In organize mode these are replaced by the Move-to-section picker.

### Container list items

- **Icon**: user-selected workload icon or the default box, colored by state (green=running, gray=stopped)
- **Name**: container name, with a small orange **Update** pill when the image update checker has flagged this container (`updateAvailable`), and an amber **Restarting in N s** pill while the restart policy has a restart scheduled (`scheduledRestart`)
- **Subtitle**: shortened OCI image reference
- **Hover actions**: Start (if stopped), Stop (if running, or stopped with a scheduled restart — cancels it), Restart (if running)

---

## View Switching

The center panel content is controlled by the URL. Refreshing the browser restores the same view and tab.

| URL | Content |
|-----|---------|
| `/` | Redirects to `/host/home` |
| `/host/:tab` | Host panel (`tab` ∈ `home`, `overview`, `host-mgmt`, `software`, `backups`, `app-config`), [UI-HOST.md](UI-HOST.md) |
| `/vm/:name/:tab?` | The VM page, [UI-VM.md](UI-VM.md) (`tab` ∈ `overview`, `console`; default `overview`); its Console tab: [CONSOLE.md](CONSOLE.md) |
| `/container/:name/:tab?` | The container page, [UI-CONTAINER.md](UI-CONTAINER.md) (`tab` ∈ `overview`, `logs`, `console`; default `overview`) |
| `/create/vm` | Create VM panel ([UI-VM.md](UI-VM.md), New VM) |
| `/create/container` | Create Container panel ([UI-CONTAINER.md](UI-CONTAINER.md)) |
| `/login` | Login page |
| `*` | Redirects to `/host/home` |

`/host/home` is the app's landing page: `/`, a bare `/host`, and any unknown path all land there, as does a host tab id that doesn't exist. The top-bar brand (glyph + wordmark) is a button back to `/host/home` from anywhere. Escape from a VM/container view and the "back to host" actions still go to `/host/overview` — those mean "leave this workload", not "go home"; the left panel's Host row likewise opens `/host/overview`, the host's own page.

VM/container selection is derived from the URL. A page shows the workload its URL names, so switching quickly from A to B always ends on B (see [ERROR-HANDLING.md](ERROR-HANDLING.md) § Stale responses).

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

Shown when the boot probe (`GET /api/host`) fails — the app is installed to a home screen and launched away from the VPN, or the service is restarting.

Centered card matching the Login page, with:
- The Wisp glyph, then a round tinted badge holding a status icon
- **Offline** (request never reached the server, including a timeout): title "Can't reach Wisp", body "Your device can't reach the server. If you're away from home, connect to your VPN and try again."
- **Server** (server answered with an HTTP error): title "Wisp isn't responding", body "The server answered, but Wisp is not ready yet. It may be restarting or finishing an update."
- Full-width accent **Retry** button. Deliberately static — it never shows a pending/disabled state: a probe against an unreachable server settles in a couple of milliseconds, so reflecting it would flash the button on every backoff tick.
- Footer hint: "Retrying automatically. Wisp reconnects on its own once the server is reachable."

The screen re-probes on its own (backoff 1 s → 15 s, plus immediately on `online` and on tab re-focus), so it clears itself once the VPN is back — the button only skips the wait.

**Boot spinner.** While the first probe is in flight the route renders nothing for 500 ms (so a fast load never flashes), then a centered spinner. The page is never left blank indefinitely.

**Offline fallback page.** If the service worker has no cached shell at all (worker installed while offline, or storage evicted), it serves a small self-contained HTML page with the same "Can't reach Wisp" copy and a Retry link. Inline styles only — the CSP forbids inline scripts.

---

## Render Error Screen

Shown when any component throws during render — the alternative is React unmounting the whole tree to a blank page, which an iOS home-screen launch can't even reload from. One boundary for the whole app *(settled 2026-10-16)*: it is a last resort, not a substitute for handling bad data where it arrives.

Same centered card as the Server Unreachable screen: title "Something went wrong", body "Wisp hit an unexpected error while drawing this page. Reloading usually fixes it.", the error message in small muted monospace, and a full-width accent **Reload** button that reloads the page.

---

## Component Patterns

The shared patterns (tables, modals, buttons, form inputs, row state): [FRONTEND-RULES.md](../FRONTEND-RULES.md), Design and UI patterns.

### Cards

A page's content sits in cards: a title in sentence case (with an optional icon and
help icon), the card's actions as icon buttons at the right of its header, and its
content. A card holds values as text, a list, or a table; it never holds a form with a
Save. An error of the card's own shows in it, below the header, and can be dismissed.

### Radio Pills

Content-sized single-choice chips are the app-wide control for binary/small-set form choices (OS Type, firmware, CPU model, NIC model, restart policy, disk add mode) (settled 2026-08-29); groups wrap instead of stretching. The segmented style survives only in the sidebar's type filter, which is view chrome rather than a form field.

### Modals

The card is centred; below `sm` every modal is a sheet from the bottom, full width
(settled 2026-11-21). A destructive action asks in a modal dialog: title, message,
optional checkbox, Cancel/Confirm buttons. Backdrop, layer, focus and Escape:
`docs/FRONTEND-RULES.md`, Modals and dialogs.

---

## Icon System

- **UI icons:** lucide-react.
- **VM icons:** Custom selectable set; default follows OS type. Choice is **persisted** in libvirt domain metadata (`iconId` via the VM config API).
- **Container icons:** Same picker; **`iconId`** is stored in the container’s persisted config.
- **Home tiles:** Same picker. A tile inherits the `iconId` of the workload it points at (or its own, for a manual link) and falls back to `globe`; the picker writes a per-tile override in the `homepage` config.

---

## Loading States

Every view that reads has a loading, an empty and an error state (settled 2026-11-20): a loading line or skeleton until its first read answers; its own empty text when the read holds nothing; its read's error, with a Retry when nothing is shown yet, or dismissible above the data already shown, which stays.

---

## Keyboard Shortcuts

- **Escape:** While a VM or container view is open (`/vm/:name/...` or `/container/:name/...`), navigates back to `/host/overview`. Does **not** close tabs within the Host panel.
- **Escape in modals:** an open modal, popover or drawer takes Escape first: it closes the top layer, and the route-level handler stands down while any layer is open (`docs/FRONTEND-RULES.md`, Modals and dialogs).
