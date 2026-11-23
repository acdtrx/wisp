# Frontend Rules

How UI code is written, and the project's design (Design, `[PROJECT]`); the last section
holds the UI library's rules.

## Data

- The client is an observer: it sends input and commands and renders server state. Never
  hold authoritative state on it (e.g. browser localStorage) or run there an operation
  the server could not complete with no client attached. How server state reaches it:
  `ARCHITECTURE.md`.
  - Applied: per-viewer presentation is not server state: keep the theme per device
    (Wisp's design, Theme activation and persistence).
  - Applied: server state reaches a view one way per kind (`ARCHITECTURE.md`). A stream
    is mirrored in a store made by the one stream-store helper, through the one stream
    client. A record (what one read route answers) is read with `useRecord`, from the
    one table of record kinds. No component reads server state by hand, except three
    reads that are not records: the login page's SSO status, a console's host probe and
    the self-update's version poll.
  - Applied: the wire's names (topics, change kinds, job kinds) are written once, in
    `shared/`, never as a bare string.
  - Applied (settled 2026-11-21): a page has three shapes and no others.
    - **View**: a page shows the server's state, live, as text.
    - **Edit**: a group of settings has one Edit. It opens a form holding the values as
      they were when it opened; Save sends the group in one request, only what changed,
      and closes the form; a failure keeps it open with the server's error. The last
      save wins: the same thing edited in two tabs at once is not handled. Save is
      enabled when the form differs from what it opened with and has no problem; a
      problem shows beside its field. Every such form goes through the one editor hook.
    - **Act**: a switch or a button on a page acts at once, in one request.
    - No page holds a form with a Save of its own. An input to a command (a password
      change, a token's name, a name typed in place, sign-in) is its control's own
      state.
    - A page whose workload was deleted elsewhere says it is gone; one renamed
      elsewhere is followed to its new name (`specs/UI.md`).
    - Creating a VM or a container is a form of its own: its draft is the only state,
      and one function turns it into the create request.
  - Applied (settled 2026-11-21): a command's control is busy until the server answers: its ack, or
    the end of its job. A job that ended cancelled is a failure. Nothing waits for the
    stream: the view changes when the stream brings the new state. Every command goes
    through the one command hook, or for a workload's header actions through its store.
    Every control of a row is disabled while a command on that row runs.
  - Applied (settled 2026-11-21): a field or control that needs its workload offline is
    usable only when the VM is shut off, or the container stopped: one test per kind,
    used by every section.
- Initialise form and component state with meaningful defaults derived from the data
  model, never with an empty object.
  - Applied: start form state from the config's defaults, never `useState({})`.
- Bound client-side collections that grow while the app runs (messages, log lines, feed
  items): cap or window them.
- Give every view that loads data a loading, an empty and an error state.

## Routing

- Give every view its own URL from the first one: `/` is the main view, and a deep link
  (e.g. `/thing/:id`) opens any view directly.

## Errors

- Keep an error shown to the user visible until the user dismisses it.
  - Applied: an error shows in the one error display (`ErrorBanner`). A command's error
    stays until the user dismisses it or starts another action on the same workload.
  - Applied: a failed read never hides data already shown: it shows above the data and
    can be dismissed. With no data shown, the view is the error, with a Retry. A
    stream's error shows the same way; a dropped connection is a status line, not an
    error.

## Design

- Build themes from design tokens: a new theme is a token set, never a CSS rewrite. Make
  all text meet WCAG AA (4.5:1) in every theme.
- Make every interactive element reachable by keyboard, with an accessible name and
  visible focus.
- **Action buttons are icon-only by default**, with `title` / `aria-label`. Give visible
  text labels only to primary form actions (Create/Save/Cancel at form bottoms), or on
  explicit request. `[PROJECT]`
- Wisp's design is below; its screens are [`specs/UI.md`](specs/UI.md). `[PROJECT]`

### Wisp's design `[PROJECT]`

**Inspiration:** Linear, Vercel — clean and professional, with subtle depth. Identity: the **"Will-o'-the-Wisp"** palette — a luminous teal accent on cool neutrals that carry a faint teal cast, so surfaces read as one material rather than gray-with-a-color-on-top. The dark theme, **"Dusk"**, is deep spruce: a very dark, desaturated green-teal, not slate and not black.

#### Colour tokens

The values live in `frontend/src/index.css`: the light set in `@theme`, the dark set under `:root[data-theme='dark']`. Every token has a value in both themes.

| Token | Light | Dark | Usage |
|-------|-------|------|-------|
| `surface` | `#f6faf9` | `#0e1c1a` | Main background (canvas) |
| `surface-sidebar` | `#edf4f2` | `#0a1715` | Left panel; the deepest surface |
| `surface-card` | `#ffffff` | `#142523` | Cards; the lightest surface |
| `surface-border` | `#dce8e5` | `#28453f` | All borders and dividers |
| `surface-input` | `#ffffff` | `#0b1a18` | Text-input fill |
| `accent` | `#0fa396` | `#0fa396` | Primary actions, active states; icons and filled buttons only |
| `accent-hover` | `#0b8578` | `#14b5a7` | Hover for accent elements: darkens in light, lifts in dark |
| `accent-soft` | `#dff3f0` | `#0f342f` | Accent background wash (selected rows, active tabs, hover tints) |
| `accent-text` | `#0a7568` | `#4fd1c0` | Accent as small text: links, active tab labels, badge text |
| `status-running` | `#21813f` | `#45c97a` | Running, success |
| `status-warning` | `#9c6203` | `#e0a63a` | Paused, warnings, restart-required |
| `status-stopped` | `#c93a3a` | `#f2706b` | Stopped, errors, danger actions |
| `status-transition` | `#0fa396` | `#0fa396` | Transitioning states; tracks `accent` |
| `status-running-soft` | `#e2f4e6` | `#183b2b` | Success background wash |
| `status-warning-soft` | `#faf0d7` | `#343520` | Warning background wash |
| `status-stopped-soft` | `#fbe5e5` | `#372b29` | Error background wash |
| `text-primary` | `#0e1f1c` | `#e8f2ef` | Primary text |
| `text-secondary` | `#3a524d` | `#b3c6c2` | Secondary text, descriptions |
| `text-muted` | `#56716b` | `#7e9994` | Muted text, labels, placeholders; the contrast floor |
| `console` | `#1e293b` | `#0b1a18` | The terminal and framebuffer well: dark in both themes ([CONSOLE.md](specs/CONSOLE.md), Viewport) |
| `console-text` | `#e2e8f0` | `#e8f2ef` | Text in the well |

- **Contrast:** every text and solid status token holds WCAG AA (≥4.5:1) on `surface`, `surface-sidebar`, `surface-card` and `surface-input`, in both themes, and on its own soft wash. Brand `accent` holds the 3:1 a graphic needs. Compute the ratio before lightening a surface or changing a text token.
- **Accent on text** is `text-accent-text`, never `text-accent`: plain `accent` is for icons and filled buttons.
- **Washes:** the `*-soft` tokens are the only background washes (error banners, badges, hover tints, selected rows). No raw Tailwind palette class (`bg-red-50`), no accent or status colour with an opacity as a wash. A tinted border is the solid token with opacity (`border-status-stopped/30`). The dark washes are the status hue mixed about 18% into the canvas, never toward white.
- **Depth order is the same in both themes:** sidebar deepest, canvas above it, cards lightest, so "raised" always means lighter.
- **Shadows:** `--shadow-card` and `--shadow-popover` (dropdowns, popovers, modals) are declared on plain `:root` and read through `@utility`, not as `@theme` keys *(settled 2026-08-25)*: a `--shadow-*` theme key is resolved at build time, so its dark override would do nothing.
- **`color-scheme`** is set on `:root` and flipped under the dark attribute, so native widgets (`<select>` popups, scrollbars, pickers) follow the app's theme, not the OS's.
- **White on a fill:** `text-white` stays on `accent`-filled buttons in both themes. The danger confirm button takes `dark:text-surface` in dark, where white on the lifted red falls under 3:1.

#### Glow — the Dusk light system *(settled 2026-08-25)*

In the dark theme **a running workload glows**. Three utilities in `index.css` carry it, all built from the tokens, all no-ops in light:

- **Home's lanterns** — the full canvas treatment ([UI-HOST.md](specs/UI-HOST.md), Home).
- **`wisp-lit-glyph`** — the running workload's icon in the sidebar rows and in the VM and container page header. Static, not animated, and only while the workload runs, so a glow always means the same thing.
- **`wisp-brand-glow`** — the Wisp glyph where it stands for the app itself: the top-bar wordmark and the login card. Never inside the glyph component, which is also an icon-picker choice.

`login-dusk` gives the login page Home's wash in the dark theme. The light theme has no glow.

#### Theme activation and persistence *(settled 2026-08-25)*

- **Three states**: `light`, `dark`, `system`. **`system` is the default**: it follows the OS `prefers-color-scheme` live, with no reload. An explicit `light` or `dark` overrides the OS.
- **Mechanism**: `data-theme="dark"` on `<html>`; `system` and `light` carry no attribute. The dark theme is the token set redefined under that attribute, with no per-component theming. Tailwind's `dark:` variant is pointed at the attribute, for the rare utility that needs more than a token swap.
- **Persistence is per device**: `localStorage` key `wisp_theme`, not `wisp-config.json`. The theme is per-viewer presentation, not server state. A browser that refuses storage falls back to `system`.
- **Owner**: `frontend/src/theme.js`, framework-free because the theme is resolved before React exists; the store mirrors it for React and never writes the attribute.
- **No flash on load**: an inline script in `index.html`'s `<head>` sets the attribute before the first paint. Its sha256 is pinned in `backend/src/app.js` (`THEME_INIT_SCRIPT_HASH`) for the CSP: editing the script means refreshing that constant, or the script is blocked.
- **`<meta name="theme-color">`** follows the effective theme: the brand teal in light, `surface-card` in dark.
- **The control** is in the top bar's right cluster, between background jobs and sign out: icon-only, cycling light → dark → system, its `title` and `aria-label` naming the current mode.

#### Typography

Body and UI text use the system stack (`system-ui, -apple-system, sans-serif`): no font is loaded from another host. A custom font is allowed only bundled (self-hosted woff2 with its licence in `frontend/src/assets/fonts/`). One display face is bundled, **Bricolage Grotesque 600** (`font-display`), used only for brand moments: the top-bar wordmark, the login title, Home's greeting, and the heading of a full-page state (empty, error, server unreachable). Tables, labels and body copy stay on the system stack.

#### Spacing and shape

- **Card border radius:** 8px. **Card shadow:** subtle (`--shadow-card`).
- **Transitions:** 150ms on all interactive state changes.
- **Section headings:** a small all-caps muted label (`11px`, semibold, uppercase, wide tracking, `text-muted`), not a large header.
- **Favicon:** `index.html` declares the PNG first, then the SVG, so a browser that draws SVG favicons poorly still gets a bitmap.

## Phones and touch

- Give text fields a phone types into at least a 16px font; never disable pinch zoom.
- On a touch device, let only a tap on a field open the keyboard: never focus a field
  unprompted there. Route every programmatic focus through one module that makes that
  call.
- Put hover effects only under `@media (hover: hover)`, and grow tap targets at phone
  widths.

## Layers

- On Esc, close only the top layer, wherever focus is. Make the page under a modal inert,
  keep Tab inside the modal, and on close return focus to what opened it. Never dismiss a
  modal on a click beside it.
- Clamp a popover anchored to a control to the viewport.

## Bundles

- Never load assets from a CDN: bundle JavaScript, CSS and fonts, or use system defaults.
  - Applied: keep body and UI text on the system stack; self-host a custom face as woff2
    with its license alongside (Wisp's design, Typography).
- Code-split large features with dynamic imports to keep bundle chunks small.
  - Applied: load the Console tab with `React.lazy`.

## Files

- **Rebuild a redesign; never redress it.** Build the redesigned page, panel or component
  as new and let the old markup go: restyled old structure nests wrappers in wrappers and
  keeps the old shape's bugs.
- Put one UI component in each file; small local sub-components may share it only if they
  are not exported. A shared chrome module (the table's, the form modal's) exports its
  few small parts together.
- Colocate related files: a view's components, styles and tests sit in one directory.

## UI patterns: cards, lists, tables and modals `[PROJECT]`

Conventions for a page's cards, for repeating rows, and for every modal. The screens themselves are [`specs/UI.md`](specs/UI.md).

### Cards

- A page's content sits in cards, all through the one shared card: a title in sentence case (with an optional icon, and an optional help icon for a description the user can ignore), the card's actions as icon buttons at the right of its header, and its content.
- A card holds values as text, a list or a table; never a form with a Save (Data).
- A card's own error shows in it, below the header, and can be dismissed.
- Several cards stack with the same gutters on every page.

### Rows

- **One row, one request.** A save, a delete or another change applies to one row, through a purpose-named operation (add, update or remove one mount), never by replacing the parent array from the client. A route that replaces a whole list by design says so in its API spec.
- **Add is in the card's header, at the right**: an accent button, icon-only, or `Plus` with a second icon that names the kind of thing added. No "add row" at the bottom of a table; an empty state points at the header control.
- **Row actions are icon-only** buttons with `title` and `aria-label`. Order: other actions first (mount, test, upload, restore…), then Edit (`Pencil`), then Delete (`Trash2`) last. A commit action (Save, Add, Attach, Confirm) takes the primary style, the others the neutral one.
- **State is a dot before the label**, not a Status column: green for mounted or present, grey for not, red for missing; its `title` and `aria-label` carry the words. A mount or unmount control shows the state in its own background.
- **Rows are read-only.** A row is created and edited in a modal form (below), opened by the header's Add and the row's Edit.
- **On phones**, a row with several actions hides its Actions column below `sm` and shows the same buttons in a strip under the row when the row is tapped, one row at a time.

### Tables

- Every table is built from the shared table chrome (`DataTableChrome.jsx`): no raw `<table>`.
- Every cell has the same horizontal inset on both sides; never a right padding alone as a column gutter. Dense rows are for form-heavy tables.
- Column headers are `<th scope="col">`.
- Row actions are revealed on hover at `lg` and up, and always visible below; they stay visible while their row is busy.
- A table's minimum width, when it needs one, is a literal class string: a computed class name generates no CSS.

### Row state and errors

- **Per-row loading:** the row or control that sent the request shows it; other rows stay usable.
- **Workload busy:** while a running job holds the workload's lock, its mutating controls are disabled, with the reason as their `title`. A workload is busy while a running job on the `jobs` topic has it as its `subject`, never by comparing a job's title (settled 2026-11-20); the reason names that job's title.
- **Errors:** a failure of one row shows on that row or action; a failed read, or a failure not tied to one row, shows as the card's error.

### Modals and dialogs

Every full-screen overlay goes through the shared `Modal`; never an ad-hoc `fixed inset-0`. It owns:

- The backdrop and the card: centred, and below `sm` a sheet from the bottom (settled 2026-11-21), in a portal on `document.body`; the card is a `role="dialog"` `aria-modal` named by its title.
- Its layer on the shared stack (settled 2026-11-12): Escape closes only the top layer, Tab stays inside the card, the app root under it is inert, and focus returns to the opener on close. Page-level Escape handlers stand down while a layer is open; a control that uses Escape itself (an inline rename) claims it. The phone drawer and every popover are layers too; a popover goes through the one popover module (portal, viewport clamp, an outside press closes it).
- An optional header (title, subtitle, X) and an optional footer.
- **A click on the backdrop closes nothing** (settled 2026-11-12): Escape, the X and Cancel do. A modal cannot be closed while its save or upload runs.

#### Modal form editor

The shape for creating or editing **one entity** (a mount, a bridge, a token, a NIC, a disk).

- **One purpose-named modal per entity kind**, never a generic editor switched by kind. It owns its form, its validation and its request, and takes what it edits when it opens. Create or edit is whether the parent names an entity.
- **One shell** for all of them: the title says what is edited, the subtitle which one.
- **Fields** are stacked, label above control, hint below; short related fields pair in two columns from `sm`. Identity that cannot be edited (a UUID, a filesystem) shows as text, not as a disabled input. The first field takes focus on open through the focus module, never on a touch device. Enter submits.
- **Footer:** Cancel and the primary Save, Create or Adopt at the right; Save is disabled until the values are valid and, for an edit, changed, and shows the save in flight. A secondary action (an SMB connection test) sits at the left.
- **Errors:** the save's error shows at the bottom of the body, dismissible; the modal stays open on a failure and closes on success.
- **A write-only secret** left empty keeps what is on file, and a hint under the field says so.
- **Nested dialogs** (settled 2026-08-25, reworked 2026-11-12): a confirm opened from an editor is the top layer and takes Escape alone. It is rendered beside the modal, not inside its scrolling body.

#### Confirmation and alert dialogs

- `ConfirmDialog` is the confirm for a destructive or weighty action (a danger button by default, a primary one for a non-destructive accept); `AlertDialog` is the one-button message. Never `window.confirm()` or `window.alert()`.
- **A confirm then its command** (settled 2026-11-21): the confirm closes when it is accepted, and the command runs as the control's own: its row or button shows it in flight, its error shows where that view's command errors show. A confirm that checks what was typed (restore in place) stays open only while that check fails.
- **An action that deletes stored data asks first** (settled 2026-11-21): the confirm opens at the action itself (a remove, or a form's Save whose edit deletes data) and names exactly what goes. An action that deletes nothing stored does not ask.

## React

- Keep effect dependencies **stable**: primitive values or references that keep their
  identity while their value does (the record cache keeps an equal answer's object),
  not objects rebuilt every render.
  - Applied (settled 2026-11-21): `react-hooks/exhaustive-deps` is an error. An effect
    that cannot state its dependencies honestly is wrong and is rewritten.
- Memoise callbacks passed to effects or child components.
  - Applied: use `useCallback` for handlers passed to effects or children.
