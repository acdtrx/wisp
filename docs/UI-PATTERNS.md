# UI patterns: section lists and tables

Conventions for repeating rows in Host, VM, Container, and Library panels. Use this together with [docs/spec/UI.md](spec/UI.md) (visual system) and [docs/CODING-RULES.md](CODING-RULES.md) §8.

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

- **Mount state:** Do not show a separate “Mounted / Not mounted” text column when a single mount/unmount control exists; encode state with the **background** of that control (e.g. green tint when mounted).

---

## Table chrome (shared layout)

Use **[frontend/src/components/shared/DataTableChrome.jsx](../frontend/src/components/shared/DataTableChrome.jsx)** (`DataTableScroll`, `DataTable`, `dataTableHeadRowClass`, `dataTableBodyRowClass`, **`DataTableTh`**, **`DataTableTd`**, padding tokens) so tables stay aligned with the tokens below:

| Area | Typical classes |
|------|-----------------|
| Horizontal scroll wrapper | `overflow-x-auto -mx-1 px-1` (via `DataTableScroll`) |
| Table | `w-full min-w-[…rem] text-sm text-text-secondary border-collapse` (via `DataTable`) |
| Header row | `text-left text-[11px] font-medium text-text-muted uppercase tracking-wider border-b border-surface-border` (`dataTableHeadRowClass`) |
| **Cell horizontal inset** | **`px-4`** on every `<th>` and `<td>` (via **`DataTableTh`** / **`DataTableTd`** or exported `dataTableCellPadX`). Do **not** use **`pr-*` only** for column gutters — that removes left inset on the first column and often leaves the actions column flush to the scroll edge. |
| **Cell vertical rhythm** | **Comfortable:** `py-2` (header) / `py-2.5` (body) — default on `DataTableTh` / `DataTableTd` when `dense` is false. **Dense:** `py-1.5` for form-heavy tables (NICs, disks, mounts, env) — `dense` on `DataTableTh` / `DataTableTd`. Horizontal **`px-4`** stays the same. |
| Empty / `colSpan` rows | Same horizontal inset: e.g. **`px-4 py-4`** (`dataTableEmptyCellClass`) so empty states are not flush to the edge. |
| Body rows | `border-b border-surface-border/60 last:border-0` (`dataTableBodyRowClass`) |
| **Interactive body rows** | `dataTableInteractiveRowClass` on `<tr>` — `group` + bottom border + **`hover:bg-surface`** for tables where actions are hidden until hover |
| **Row actions cell** | Wrap icon buttons in **`DataTableRowActions`** — **`opacity-0 group-hover:opacity-100`**; use **`forceVisible`** when the row is editing, saving, or deleting so actions stay visible without hover |

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
| **Editable rows** | Inline fields after **Edit** where applicable; per-row save; row-scoped API when the backend supports it | Host network storage (pencil → save/cancel); Container mounts (add/update/remove/upload per row via mount endpoints) |
| **Action table** | Read-only cells; row actions **on row hover** (shared interactive row + `DataTableRowActions`) | Snapshots, backups |
| **Library / assets** | Per-entity API; **upload/download in page header** (icon-only); optional confirm for destructive ops; rename/delete **on row hover** | Image Library |
| **Read-only inventory** | No mutations; optional grouping rows | Host Overview → Hardware table |
| **VM — Network interfaces** | Own **SectionCard** before **Advanced**; **table** of NICs. **Documented exception:** each row **Save** still **PATCH**es the full **`nics`** array (same contract as before). Stopped/create: rows can be all-inputs; running: **view** + **Edit** → inputs + row **Save**/**Cancel**. **Add NIC**: header **`Plus`+`Network`**. | [VmNetworkInterfacesSection.jsx](../frontend/src/components/sections/VmNetworkInterfacesSection.jsx) |
| **VM — USB devices** | **SectionCard** with **table** of **attached** devices only (read-only cells; **Detach** on row hover). **Attach**: header **`Plus`+`Usb`** opens **[UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx)** with a **second table** inside a white bordered card (same idea as Image Library body); host devices not yet attached; per-row icon **Attach** (hover-reveal). Successful attach **closes** the modal. | [USBSection.jsx](../frontend/src/components/sections/USBSection.jsx), [UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx) |
| **Container environment** | **Documented exception:** row **Save** **PATCH**es the whole **`env`** object (replace map). No **section Save** in the header; **Edit** / **Save** / **Cancel** per row; **Add** in header **`Plus`+`Braces`**. | [ContainerEnvSection.jsx](../frontend/src/components/sections/ContainerEnvSection.jsx) |
| **Bridge create** | New bridge via **new table row** (fields + confirm/cancel icons), not a separate expandable form block | [HostNetworkBridges.jsx](../frontend/src/components/host/HostNetworkBridges.jsx) |

---

## Reference implementations

- **[ImageLibrary.jsx](../frontend/src/components/library/ImageLibrary.jsx)** — **`SectionCard`** shell (Host Library tab); **`titleIcon`** + header icon actions (upload, URL/preset downloads); per-file row operations; shared table chrome.
- **[UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx)** — Modal shell (image-library style): scroll area on **`bg-surface`**, table inside **`rounded-card` + `bg-surface-card` + border** like **`SectionCard`**; dense **`DataTable`** with **`dataTableInteractiveRowClass`**; per-row icon **Attach** (**`DataTableRowActions`**, hover-reveal).
- **[HostNetworkBridges.jsx](../frontend/src/components/host/HostNetworkBridges.jsx)** — Header `Plus`+`Network`; inline create row in table; icon-only delete.
- **[ContainerMountsSection.jsx](../frontend/src/components/sections/ContainerMountsSection.jsx)** — Row-scoped mount API; header `Plus`+`File` / `Plus`+`Folder`.
- **[HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx)** — Row-scoped mount API (`/api/host/mounts`) for SMB + adopted removable drives; `DataTable` chrome; header `Plus`+`Server`; combined mount/unmount with mounted-state background; SMB **Check** uses green/red on the shield button (errors on hover); separate "Detected drives" table rendered only when non-empty.
- **[SnapshotsSection.jsx](../frontend/src/components/sections/SnapshotsSection.jsx)** — Header `Plus`+`Camera` when qcow2; icon-only row actions (hover-reveal).
- **[BackupsPanel.jsx](../frontend/src/components/backups/BackupsPanel.jsx)** — Restore/delete on row hover.
- **[HostOverview.jsx](../frontend/src/components/host/HostOverview.jsx)** (hardware inventory) — Read-only; **`SectionCard`** + **`titleIcon`** per section; shared table chrome.
- **[HostMgmt.jsx](../frontend/src/components/host/HostMgmt.jsx)** — Stacked **`SectionCard`**s (**OS Update**, **Network Bridges**, **Network Storage**, **Backup**) with **`titleIcon`** on each; same page gutters as Overview.

---

## Related documentation

- [docs/spec/UI.md](spec/UI.md) — Layout, tokens, and view inventory.
- [docs/CODING-RULES.md](CODING-RULES.md) §8 — General frontend patterns.
- [docs/WISP-RULES.md](WISP-RULES.md) — Wisp-specific frontend notes.
- [docs/spec/API.md](spec/API.md) — Mount row endpoints (`/api/host/mounts`).
