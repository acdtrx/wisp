# UI patterns: section lists and tables

Conventions for repeating rows in Host, VM, Container, and Library panels. Use this together with [docs/spec/UI.md](spec/UI.md) (visual system) and "Wisp — Coding Rules" §8 (in kora — see the root `CLAUDE.md`).

---

## Purpose

Apply these rules when building or refactoring:

- Multi-row editors (mounts, env vars, network storage, NIC lists, and similar).
- Dense read-only or action tables (hardware inventory, snapshots, backups, image library).
- Any UI where the user adds, edits, saves, or deletes **items in a collection** shown as a list or table.

---

## Core rules (target standard)

### 1. Row-based persistence

Each **save**, **delete**, and other mutating action should apply to **one row** (one API call / one server mutation scoped to that entity). Avoid PATCHing or replacing an **entire parent array** from the client for convenience when the product model is naturally per-item.

- Prefer purpose-named backend operations and matching client calls (e.g. add/update/remove one mount), consistent with project architecture rules.
- If the API is intentionally a single “replace whole list” contract, document that exception in the API spec; still prefer row-scoped APIs when the UI presents independent rows.

### 2. Add controls in the section header (right)

Place **add** actions in `SectionCard` **`headerAction`**, aligned to the **far right** of the section header (after restart badge and Save when dirty). Header clicks must not toggle collapse: the right-hand control cluster uses `stopPropagation` when the card is collapsible.

- **Add buttons:** accent background; **icon-only** or **`Plus` + a second icon** that names the kind of thing being added (e.g. `Plus`+`File`, `Plus`+`Folder`, `Plus`+`Server` for network mount, `Plus`+`Network` for bridge or NIC, `Plus`+`Camera` for snapshot, `Plus`+`Braces` for env).
- Do **not** use a full-width dashed “add row” at the bottom of the table for the primary add path when a header add is appropriate.
- **Empty state** copy should point users to the header control rather than duplicating a second add button.

### 3. Row actions: icon-only

Table and list **row actions** (edit, delete, mount, check, revert, etc.) are **icon-only** buttons with `title` and `aria-label`. Use shared table chrome styling (e.g. bordered `p-1.5` hit targets) for consistency.

- **Order:** Place **other actions first** (save/cancel while editing, upload, test connection, mount/unmount, revert/restore, open file editor, etc.), then the **Edit** control (**`Pencil`** — or the row’s primary “enter edit” affordance), then **Delete** (**`Trash2`**) **last**. Edit and delete stay adjacent when both are shown.

- **Save / Confirm uses the primary variant.** When a row is in edit/draft mode, the commit button (Save, Add, Attach, Confirm) uses **`rowActionIconBtnPrimary`** from `DataTableChrome.jsx` — accent background, white icon. The non-primary buttons (Cancel, Edit, Delete, etc.) use **`rowActionIconBtn`** (bordered, neutral). This keeps the commit affordance visible at a glance and matches the header `+` add buttons.

- **Mount state:** Do not show a separate “Mounted / Not mounted” text column when a single mount/unmount control exists; encode state with the **background** of that control (e.g. green tint when mounted). When a row has a persistent state worth showing at a glance (mounted / present / disconnected), render it as a small **status dot before the label** (green `bg-status-running`, gray `bg-text-muted/40`, red `bg-status-stopped`; `title` + `aria-label` carry the words) instead of a Status column — this works at every breakpoint and frees a column on desktop. See `StatusDot` in [HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx).

- **Phones — tap-to-expand actions:** when a row carries several actions, hide the Actions column below `sm` (`hidden sm:table-cell` on its `<th>`/`<td>`) and render the **same buttons** in a strip that expands **under the row's stacked text when the row is tapped** (one row expanded at a time; `<tr>` gets `cursor-pointer sm:cursor-auto` + an onClick toggle; the strip and the desktop Actions cell wrap their buttons in `stopPropagation` containers). This keeps narrow tables free of horizontal scroll while every action stays reachable. Reference: the SMB and Removable drives tables in [HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx).

- **Tinted washes use the soft tokens.** Status/accent background tints (error banners, success/warning badges, action hover tints, selected rows) use the theme tokens `bg-status-stopped-soft`, `bg-status-running-soft`, `bg-status-warning-soft`, `bg-accent-soft` — never raw Tailwind palette classes (`bg-red-50`, `bg-green-50`, …). Tinted borders use the solid token with opacity (`border-status-stopped/30`).

---

## Table chrome (shared layout)

Use **[frontend/src/components/shared/DataTableChrome.jsx](../frontend/src/components/shared/DataTableChrome.jsx)** (`DataTableScroll`, `DataTable`, `dataTableHeadRowClass`, `dataTableBodyRowClass`, **`DataTableTh`**, **`DataTableTd`**, padding tokens) so tables stay aligned with the tokens below:

| Area | Typical classes |
|------|-----------------|
| Horizontal scroll wrapper | `overflow-x-auto -mx-4` (via `DataTableScroll`) — the negative margin cancels the cells' `px-4` edge inset so first/last columns align flush with the parent card's padding |
| Table | `w-full text-sm text-text-secondary border-collapse` (via `DataTable`). Tables size by natural content width; when one needs a scroll floor, pass `minWidthClass` as a **literal** Tailwind class string (e.g. `"sm:min-w-[30rem]"`) so the scanner emits the CSS — computed class names never generate CSS. |
| Header row | `text-left text-[11px] font-medium text-text-muted uppercase tracking-wider border-b border-surface-border` (`dataTableHeadRowClass`) |
| **Cell horizontal inset** | **`px-4`** on every `<th>` and `<td>` (via **`DataTableTh`** / **`DataTableTd`** or exported `dataTableCellPadX`). Do **not** use **`pr-*` only** for column gutters — that removes left inset on the first column and often leaves the actions column flush to the scroll edge. |
| **Cell vertical rhythm** | **Comfortable:** `py-2` (header) / `py-2.5` (body) — default on `DataTableTh` / `DataTableTd` when `dense` is false. **Dense:** `py-1.5` for form-heavy tables (NICs, disks, mounts, env) — `dense` on `DataTableTh` / `DataTableTd`. Horizontal **`px-4`** stays the same. |
| Empty / `colSpan` rows | Same horizontal inset: e.g. **`px-4 py-4`** (`dataTableEmptyCellClass`) so empty states are not flush to the edge. |
| Body rows | `border-b border-surface-border/60 last:border-0` (`dataTableBodyRowClass`) |
| **Interactive body rows** | `dataTableInteractiveRowClass` on `<tr>` — `group` + bottom border + **`hover:bg-surface`** for tables where actions are hidden until hover |
| **Row actions cell** | Wrap icon buttons in **`DataTableRowActions`** — hover-reveal is desktop-only (**`lg:opacity-0 lg:group-hover:opacity-100`**; always visible below `lg` for touch); use **`forceVisible`** when the row is editing, saving, or deleting so actions stay visible without hover |

Accessibility:

- Use `<th scope="col">` for column headers.
- Provide `title` / `aria-label` on icon-only buttons in row actions.

---

## Section shell (Host panels and table pages)

Major blocks on **Host** tabs (Overview, Host Mgmt, Image Library) use **`SectionCard`** so tables and forms match the same **white card on page background** look as Host Overview sections.

| Aspect | Convention |
|--------|----------------|
| **Card** | `SectionCard` — `rounded-card border border-surface-border bg-surface-card` |
| **`titleIcon`** | Lucide icon **14px**, **`strokeWidth={2}`**, muted (SectionCard places it before the uppercase title). Same pattern as [HostOverview.jsx](../frontend/src/components/host/HostOverview.jsx) (CPU, Memory, Hardware, etc.). |
| **`helpText`** | Optional one-line description shown via a small `HelpCircle` icon next to the title (native `title=` + `aria-label`, rendered by [HelpIcon.jsx](../frontend/src/components/shared/HelpIcon.jsx)). Use this instead of an in-body `<p className="text-text-muted">` blurb when the text is descriptive context the user can ignore — keeps vertical space for actual content. |
| **Header right** | Filters, **Save**, **`headerAction`** (add/upload/download icons) stay in the section header row — not inside the HTML `<thead>`. |
| **Body** | Default content padding `px-5 py-4` below the header divider (`border-t`). |
| **Page gutters** | Outer wrapper **`px-6 py-5`** (and **`space-y-5`** between multiple sections); outer container scrolls when content is tall — same as Host Overview / Host Mgmt. |

Single-section views (e.g. **Image Library**) use one **`SectionCard`** with the table inside the body. Multi-section views stack several **`SectionCard`**s.

---

## Row state and errors

- **Per-row loading:** Disable or show a spinner on the row (or action) that triggered the request; avoid blocking unrelated rows unless the backend requires it.
- **Errors:** Prefer row-scoped or action-scoped messages when a single row fails; use section-level error (e.g. `SectionCard` `error`) for load failures or cross-row validation that is not tied to one line.

---

## Variants

| Variant | Behaviour | Examples |
|---------|-----------|----------|
| **Editable rows** | Inline fields after **Edit** where applicable; per-row save; row-scoped API when the backend supports it. For 3+ fields or mobile-required flows prefer the **Modal form editor** variant below. | Container mounts (add/update/remove/upload per row via mount endpoints) |
| **Action table** | Read-only cells; row actions **on row hover** (shared interactive row + `DataTableRowActions`) | Snapshots, backups |
| **Library / assets** | Per-entity API; **upload/download in page header** (icon-only); optional confirm for destructive ops; rename/delete **on row hover** | Image Library |
| **Read-only inventory** | No mutations; optional grouping rows | Host Overview → Hardware table |
| **VM — Network interfaces** | Own **SectionCard** before **Advanced**; **table** of NICs. **Documented exception:** each row **Save** still **PATCH**es the full **`nics`** array (same contract as before). Stopped/create: rows can be all-inputs; running: **view** + **Edit** → inputs + row **Save**/**Cancel**. **Add NIC**: header **`Plus`+`Network`**. | [VmNetworkInterfacesSection.jsx](../frontend/src/components/sections/VmNetworkInterfacesSection.jsx) |
| **VM — USB devices** | **SectionCard** with **table** of **attached** devices only (read-only cells; **Detach** on row hover). **Attach**: header **`Plus`+`Usb`** opens **[UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx)** with a **second table** inside a white bordered card (same idea as Image Library body); host devices not yet attached; per-row icon **Attach** (hover-reveal). Successful attach **closes** the modal. | [USBSection.jsx](../frontend/src/components/sections/USBSection.jsx), [UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx) |
| **Container environment** | **Documented exception:** row **Save** **PATCH**es the whole **`env`** object (replace map). No **section Save** in the header; **Edit** / **Save** / **Cancel** per row; **Add** in header **`Plus`+`Braces`**. Secret rows add a **`Dices`** action — confirm dialog with one-time copyable generated value; Apply fills the row, row Save commits. | [ContainerEnvSection.jsx](../frontend/src/components/sections/ContainerEnvSection.jsx) |
| **Pill row + inline disclosure strip** | When per-item config attaches to a small, well-known set of items (e.g. ports), render the items as **clickable pills** with state encoded by an in-pill icon (no color), and open the editor as an **inline disclosure strip** directly below the pill row inside the same `SectionCard`. **One strip open at a time** — switching pills discards unsaved edits silently (no confirm). A trailing **dashed `+` pill** opens the strip in *add* mode for items not in the source list. Mutations use row-scoped APIs (one per item); no section Save. Use this in preference to a popover when the editor needs to grow vertically (TXT/key-value lists, etc.) or when the data anchors naturally to a visible item rather than a separate table. | [ContainerNetworkSection.jsx](../frontend/src/components/sections/ContainerNetworkSection.jsx) (per-port mDNS service advertisements) |
| **Modal form editor** | Row create/edit via a **modal form** instead of inline cell-swapping — the default for editors with 3+ fields or any editor that must work on phones. Table rows stay read-only; row **Edit** (pencil) and header **Add** open the modal. See **§ Modal form editor** below. | [SmbShareEditorModal.jsx](../frontend/src/components/host/SmbShareEditorModal.jsx), [RemovableDriveEditorModal.jsx](../frontend/src/components/host/RemovableDriveEditorModal.jsx), [BridgeCreateModal.jsx](../frontend/src/components/host/BridgeCreateModal.jsx) |

---

## Reference implementations

- **[ImageLibrary.jsx](../frontend/src/components/library/ImageLibrary.jsx)** — **`SectionCard`** shell (Host Library tab); **`titleIcon`** + header icon actions (upload, URL/preset downloads); per-file row operations; shared table chrome.
- **[UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx)** — Modal shell (image-library style): scroll area on **`bg-surface`**, table inside **`rounded-card` + `bg-surface-card` + border** like **`SectionCard`**; dense **`DataTable`** with **`dataTableInteractiveRowClass`**; per-row icon **Attach** (**`DataTableRowActions`**, hover-reveal).
- **[HostNetworkBridges.jsx](../frontend/src/components/host/HostNetworkBridges.jsx)** — Header `Plus`+`Network` opens `BridgeCreateModal`; read-only rows; icon-only delete (visible on phones).
- **[ContainerMountsSection.jsx](../frontend/src/components/sections/ContainerMountsSection.jsx)** — Row-scoped mount API; header `Plus`+`File` / `Plus`+`Folder`.
- **[ContainerNetworkSection.jsx](../frontend/src/components/sections/ContainerNetworkSection.jsx)** — Pill row of exposed ports with **inline disclosure strip** for per-port mDNS service editing (`Radio` icon inside pill when configured, no color encoding; trailing dashed `+` pill for non-EXPOSE ports; one strip open at a time, silent discard on switch).
- **[HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx)** — Row-scoped mount API (`/api/host/mounts`) for SMB + adopted removable drives; `DataTable` chrome with **read-only rows** — create/edit/adopt go through `SmbShareEditorModal` / `RemovableDriveEditorModal`; mount state as a **status dot before the label** (no Status column); on phones the Actions column is hidden and actions **expand under the row text on tap**; combined mount/unmount with mounted-state background; SMB **Check** uses green/red on the shield button (errors on hover); separate "Detected drives" table rendered only when non-empty, visible at all breakpoints.
- **[SnapshotsSection.jsx](../frontend/src/components/sections/SnapshotsSection.jsx)** — Header `Plus`+`Camera` when qcow2; icon-only row actions (hover-reveal).
- **[BackupsPanel.jsx](../frontend/src/components/backups/BackupsPanel.jsx)** — Collapsible per-workload cards (custom rich headers on the SectionCard visual tokens); per-backup icon actions on row hover; typed-name `ConfirmDialog` for restore-in-place.
- **[HostOverview.jsx](../frontend/src/components/host/HostOverview.jsx)** (hardware inventory) — Read-only; **`SectionCard`** + **`titleIcon`** per section; shared table chrome.
- **[HostMgmt.jsx](../frontend/src/components/host/HostMgmt.jsx)** — Stacked **`SectionCard`**s (**OS Update**, **Network Bridges**, **Network Storage**, **Backup**) with **`titleIcon`** on each; same page gutters as Overview.

---

## Modals and dialogs

All full-screen overlays go through the shared **[Modal.jsx](../frontend/src/components/shared/Modal.jsx)** primitive. It owns:

- The fixed-position backdrop (standardized on **`bg-black/40`**) and centered card (**`bg-surface-card`** + border + shadow).
- Escape-to-close (via `useEscapeKey`) and the **`data-wisp-modal-root`** marker that tells `AppLayout` to suppress its own Escape handling.
- An optional **title / subtitle / X-button** header bar and an optional **footer** bar (right-aligned, bordered).
- Width via **`size`** (`sm` | `md` | `lg` | `xl` | `2xl` | `3xl` | `4xl`) and height via **`height`** (`auto` | `tall` for `h-[80vh]` | `cap` for `max-h-[85vh]`).
- Body padding via **`bodyPadding`** (`default` `px-4 py-4` | `compact` `px-4 py-3` | `none` for full-bleed content).
- Guard flags **`closeOnBackdrop`** and **`closeOnEscape`** for in-flight save/upload states.

Do **not** open ad-hoc `fixed inset-0` overlays. New modal-style UI must wrap `<Modal>` so backdrop, escape, marker, and styling stay consistent.

### Modal form editor

The standard shape for creating or editing **one entity** (a mount, a bridge, a token, …). Prefer it over inline cell-swapping row editors whenever the editor has **3+ fields** or the flow must work on **phones** — inline row editors are desktop-only by construction and forced the old Host Mgmt sections to hide add/edit below `sm`. Existing inline editors are candidates for refactoring to this pattern.

Structure (see **[FormModalChrome.jsx](../frontend/src/components/shared/FormModalChrome.jsx)** for the shared tokens):

- **One purpose-named modal component per entity kind** (`SmbShareEditorModal`, not a generic kind-switched editor), owning its field state, validation, and API calls. Create vs edit is the presence of the entity prop (`share`, `drive`); the parent passes `onSaved` (refresh) and `onClose`.
- **Shell:** `<Modal size="sm"|"md" height="cap">` with `title` (e.g. "Edit SMB share") and a context `subtitle` (the share path, the device name). `closeOnBackdrop={!saving}` / `closeOnEscape={!saving}` guard in-flight saves.
- **Fields:** stacked **`FormField`** (label above control, optional hint below) in a `space-y-3` `<form id=…>`; short related fields pair into `sm:grid-cols-2`. Controls use the **`input-field`** utility; checkboxes use **`FormCheckbox`** (box left, label + hint right). Read-only identity (UUID, filesystem, derived names) renders as a muted summary box or preview line, not as disabled inputs. First field gets `autoFocus`; Enter submits via the form.
- **Footer** (via the Modal `footer` prop): right-aligned **Cancel** (`formModalNeutralBtn`) + primary **Save/Create/Adopt** (`formModalPrimaryBtn`, disabled until valid **and** dirty, `Loader2` while saving). Secondary actions (e.g. SMB **Test connection**) sit footer-left in an `mr-auto` group with their result as inline text (green OK / truncated red error with full text in `title`).
- **Errors:** sticky red line (**`FormModalError`**) at the bottom of the body; the modal stays open on failure. On success the modal calls `await onSaved()` then `onClose()`.
- **Rows stay read-only.** The table keeps display cells only; row actions shrink to purpose actions (mount, check) + **Edit** + **Delete**, which fit on phones. Write-only secrets keep the "empty means keep what's on file" convention with a hint under the field.

### Confirmation, alert, and informational dialogs

- **[ConfirmDialog.jsx](../frontend/src/components/shared/ConfirmDialog.jsx)** — Two-button confirm for destructive or impactful actions. Defaults to a red-tinted `Confirm` button (`variant="danger"`); pass `variant="primary"` for non-destructive accept (e.g. install update). Replaces `window.confirm()`.
- **[AlertDialog.jsx](../frontend/src/components/shared/AlertDialog.jsx)** — Single-button informational/error dialog. Pass `tone="error"` to highlight the title in stopped color. Replaces `window.alert()`.

Never call native `window.alert()` or `window.confirm()` — async-error reporting and confirmation prompts must use these dialogs so they pick up the same shell, focus, and styling as the rest of the app.

---

## Related documentation

- [docs/spec/UI.md](spec/UI.md) — Layout, tokens, and view inventory.
- "Wisp — Coding Rules" §8 (kora) — general frontend patterns.
- [docs/spec/API.md](spec/API.md) — Mount row endpoints (`/api/host/mounts`).
