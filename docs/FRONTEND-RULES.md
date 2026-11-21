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
  - Applied: a stream (a topic of the events stream, or a scoped stream) is mirrored in
    one kind of store: each opens, closes and is asked again the same way, and holds
    its data, its connection (connecting, open, dropped, refused) and an error. An error
    frame shows beside the last good data, a drop keeps both, a refusal shows in the
    data's place. Every stream goes through one client, a job's progress too. The
    VM and container stores are one store with a part of their own each. The wire's
    names (topics, change kinds, job kinds) are written once, in the shared module,
    never as a bare string; a function that takes one refuses a name not on the wire.
  - Applied: a record — what one read route answers — is read through the one record
    cache, and each kind of record is described once: how it is read, the cues it is
    read again on, the error that means it is gone (its subject's own not-found: any
    other is an error), and whether a command waits for its re-read (all do but a
    mount's disk usage, a best-effort figure). A record is read while something shows
    it, once for everyone showing it, again on its cues and when the events stream
    (re)connects, and the read is aborted when nothing shows it; one named by an id is
    then dropped, one without keeps its last data until sign-out. A view of a record is
    loading, ready, in error or gone; a Retry joins the read on its way. A view never
    shows an older answer after a newer one (`specs/ERROR-HANDLING.md`, Stale
    responses), and every read settles: one a newer read replaced takes that read's
    outcome. Three reads are not records, each read where it is used: the login page's
    SSO status, a console's host probe, and the self-update's version poll.
  - Applied (settled 2026-11-21): a form that edits a saved record follows that record
    and owns its whole save.
    - It is made from the record, the record's values as the form shows them, and what
      Save sends for the values (the same values where they are the same).
      Normalisation — a trim, a MAC's case, a list in the order the server acts on —
      lives in that last step and nowhere else. Both steps are pure and total: the first
      reads the record (a modal editor's, also the key it opened on), the second the
      values and the record (its data, and the id it is read by), nothing else, and
      neither throws. Text that does not parse is sent as typed (the form is dirty), and
      the field's problem shows beside it and blocks Save with its reason. A problem is
      one of a value the user changed: one the record already holds never blocks a save.
    - A field the record's state locks (a running VM's CPU) shows the saved value, is not
      sent and makes no change; a value typed in it before the lock began is dropped,
      and does not come back when the lock ends. Each form states which fields are
      locked now, once: a field is locked where the server would refuse its change, or
      where the UI spec locks it, one test per rule (`utils/workloadLocks.js`).
    - `dirty` means "Save would send something": what the form's values would send,
      against what its saved values would. A row's identity is not compared, and
      UI-only state (a row expanded, a password revealed) is not form state.
    - It follows its record by value: a change in what the record's values would send
      resets the form, a write elsewhere in the record leaves it. A reset takes the
      record afresh and starts a new generation of the form: its rows get new
      identities, and whatever a view holds on a row or on the form as it was — an open
      row editor, an open confirm, a reveal flag, a passed test, anything pending — is
      held by that generation and dropped with it. A failed save is no reset. Nothing
      opened on one row can apply to another.
    - Every form saves one way, a section's or an editor's: the command, ending at its
      ack, then the form's own new read of the record; the form is saving until that read
      has landed, and every Save control shows it. A save that renames its workload ends
      at its ack, and the page follows to the new name, whose page reads its record. No
      form's Save waits on a stream frame. A failed command or a failed read leaves the
      form as typed.
    - A modal editor's record is its parent's (the workload's config, the settings),
      the entity picked when the editor opens by a key unique in that record (where the
      wire addresses it by position, the position and the entity it opened on); the
      editor mounts when it opens, and says so when its entity is removed elsewhere (its
      own delete closes it). What it checks against — the other entities, for a
      duplicate — is the record as the form took it. An edit's Save needs a change, a
      create's only valid values.
    - Creating a VM or a container, the panel's draft is the only state: it holds each
      section's values in that section's own shape, the sections read it and write it
      by functional update, and one pure conversion turns it into the create request,
      at submit. A derived default is never shown as if typed: in a text field it is the
      placeholder, and what is sent when the field is empty; in a select it is the
      selected option, and what is sent.
    - An input to a command — a password change, a token's name, a rename field, a
      create dialog, sign-in, a row being added to a staged form — is its control's own
      state, not a form.
  - Applied (settled 2026-11-15): a command's control stays busy until the stream
    brings its new state (its topic's next frame, or the `changes` reference and the
    re-read it triggers), so a view closes onto fresh data; a command error ends it at
    once. It does not govern a form's Save, which ends at its own re-read (above). A
    request the guest may ignore (VM Stop, which is an ACPI shutdown, and Reboot) ends
    at the ack: the list shows the VM stopping when it does (settled
    2026-11-16). A wait ends after 30 s even if no frame came, with no error: the
    command was accepted (settled 2026-11-16, CODING-RULES §6).
  - Applied (settled 2026-11-21): commands and jobs.
    - A command that runs as a job names the records it changes, and stays busy until
      the job ended and their re-read, sent after it ended, has landed; it depends on no
      stream frame. A job that ended cancelled is the command's failure.
    - A workload's header actions are held by its store, one error per workload,
      cleared when any of its actions begins; the icon change shares that error, not
      the busy state. Every other command is named by a key: a key runs once at a time,
      different keys run in parallel, each holds its own error, and what a key stands
      for (what its error names) is held with it, never parsed back from it; different
      commands are different keys. Every control of a row is disabled while a command on
      that row runs, and where the server takes one at a time the other rows' controls
      are too.
    - Job state is read three ways and no other: to act on a job's end, to show its
      progress, and to ask which jobs run (a terminal event already received counts as
      the end). A view that opens on a job already running takes it up, to its end.
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
  - Applied: an error shows in the one error display (`ErrorBanner`); a section's and a
    modal's errors are that display too. A full-screen state (the app's error boundary,
    the server unreachable), a dialog's alert and a console's connection state are their
    own displays; a field's validation hint and a status shown as data (a backup's
    failed last attempt) are not errors.
  - Applied: a command's error stays until the user dismisses it or runs that command
    again; a re-read of other data, or opening another editor, leaves it. Several
    commands' errors show as several.
  - Applied: a failed read is the view's error state: it stays until a read succeeds or
    the user dismisses it, and it never hides data that was already shown. With no data
    shown, the error state is the view itself, with a Retry; a dismiss exists only where
    data is shown under it. A stream's error frame shows the same way; a dropped
    connection is a status line while the client reconnects, not an error.

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

**Inspiration:** Linear, Vercel — clean, professional, light theme with subtle depth. Identity: the **"Will-o'-the-Wisp"** palette — a luminous teal accent on cool neutrals that carry a faint teal cast, so surfaces read as one material rather than gray-with-a-color-on-top.

#### Color Scheme

| Token | Value | Usage |
|-------|-------|-------|
| `surface` | `#f6faf9` | Main background |
| `surface-sidebar` | `#edf4f2` | Left panel background |
| `surface-card` | `#ffffff` | Card backgrounds |
| `surface-border` | `#dce8e5` | All borders and dividers |
| `accent` | `#0fa396` | Primary actions, active states |
| `accent-hover` | `#0b8578` | Hover state for accent elements |
| `accent-soft` | `#dff3f0` | Accent background wash (selected rows, active tabs, hover tints) |
| `accent-text` | `#0a7568` | Accent as small text — links, active tab labels, badge text, XML tag highlight. AA (≥4.5:1) on all surfaces incl. `accent-soft`; the brand `accent` (3.1:1) stays on icons and filled buttons |
| `status-running` | `#21813f` | Running VMs, success states |
| `status-warning` | `#9c6203` | Paused VMs, warnings, restart-required |
| `status-stopped` | `#c93a3a` | Stopped VMs, errors, danger actions |
| `status-transition` | `#0fa396` | Transitioning states (starting, shutting down) |
| `status-running-soft` | `#e2f4e6` | Success background wash |
| `status-warning-soft` | `#faf0d7` | Warning background wash (badges, notices) |
| `status-stopped-soft` | `#fbe5e5` | Error background wash (error banners, danger hovers) |
| `text-primary` | `#0e1f1c` | Primary text |
| `text-secondary` | `#3a524d` | Secondary text, descriptions |
| `text-muted` | `#56716b` | Muted text, labels, placeholders |

Text and solid status tokens hold WCAG AA contrast (≥4.5:1) on `surface`, `surface-sidebar`, and white cards — check contrast before lightening any of them. When accent colors **text glyphs** use `text-accent-text`, not `text-accent`; plain `accent` on text is reserved for icons and icon buttons (graphics only need 3:1).

The `*-soft` tokens are the standard for status/accent **background washes** (error banners, success/warning badges, action hover tints, selected rows) — do not hand-roll raw Tailwind palette classes (`bg-red-50`, `bg-green-50`, …) for tinted surfaces. Tinted borders use the solid token with opacity (`border-status-stopped/30`).

#### Dark theme — "Dusk"

The dark counterpart of the palette above, in `frontend/src/index.css` under
`:root[data-theme='dark']`. Surfaces are **deep spruce** — a very dark,
desaturated green-teal (hue ~171°, the same family as the light neutrals' teal
cast), deliberately not slate and not black. The light theme's depth order is
**kept, not mirrored** — sidebar deepest, canvas above it, cards lightest — so
"raised" still means lighter and every component's existing surface choice stays
meaningful without edits. Every token in the light table has a dark value; the
only tokens the dark theme introduced are `surface-input`, the console pair, and
`--shadow-popover`.

| Token | Light | Dark | Notes |
|-------|-------|------|-------|
| `surface` | `#f6faf9` | `#0e1c1a` | Canvas |
| `surface-sidebar` | `#edf4f2` | `#0a1715` | Deepest surface |
| `surface-card` | `#ffffff` | `#142523` | Lightest surface |
| `surface-border` | `#dce8e5` | `#28453f` | 1.5–1.8:1 against the surfaces, slightly *more* present than the light theme's 1.2–1.3:1 |
| `surface-input` | `#ffffff` | `#0b1a18` | Text-input fill. New token — `input-field` was hardcoded `bg-white`, which cannot flip |
| `accent` | `#0fa396` | `#0fa396` | **Unchanged.** It already reads luminous against spruce, and lifting it would drop white-on-accent-fill below the 3:1 it currently holds |
| `accent-hover` | `#0b8578` | `#14b5a7` | Lifts instead of darkening — on a dark surface a darker fill recedes rather than responding |
| `accent-soft` | `#dff3f0` | `#0f342f` | |
| `accent-text` | `#0a7568` | `#4fd1c0` | |
| `status-running` | `#21813f` | `#45c97a` | |
| `status-warning` | `#9c6203` | `#e0a63a` | |
| `status-stopped` | `#c93a3a` | `#f2706b` | |
| `status-transition` | `#0fa396` | `#0fa396` | Tracks `accent` |
| `status-running-soft` | `#e2f4e6` | `#183b2b` | |
| `status-warning-soft` | `#faf0d7` | `#343520` | |
| `status-stopped-soft` | `#fbe5e5` | `#372b29` | |
| `text-primary` | `#0e1f1c` | `#e8f2ef` | Warm white with the same faint teal cast |
| `text-secondary` | `#3a524d` | `#b3c6c2` | |
| `text-muted` | `#56716b` | `#7e9994` | The floor |
| `console` | `#1e293b` | `#0b1a18` | The terminal/framebuffer well. Dark in **both** themes — see [CONSOLE.md](specs/CONSOLE.md) § Viewport |
| `console-text` | `#e2e8f0` | `#e8f2ef` | |
| `--shadow-card` | `0 1px 3px rgba(0,0,0,.08)` | `0 1px 3px rgba(0,0,0,.6)` | A drop shadow is invisible on dark; depth comes from the border edge plus a much darker shadow |
| `--shadow-popover` | `0 10px 15px -3px rgb(0 0 0/.1), 0 4px 6px -4px rgb(0 0 0/.1)` | `0 12px 28px -6px rgb(0 0 0/.7), 0 4px 10px -4px rgb(0 0 0/.55)` | Floating chrome — dropdowns, popovers, modals. Light value is exactly Tailwind's `shadow-lg`, which those elements used before it became a token |

The dark `*-soft` washes are the status hue mixed **~18% into the canvas surface,
never toward white** — a tinted shadow of the surface, so they read as
translucent rather than as pale chips.

**The two shadows live outside `@theme`** *(settled 2026-08-25)*. Tailwind v4
resolves a `--shadow-*` theme key into the generated utility at build time, so
`.shadow-card` would carry the light value literally and redefining the variable
under `[data-theme='dark']` would silently do nothing. They are declared on plain
`:root` and read back through `@utility shadow-card` / `@utility shadow-popover`,
which is what makes the dark override land. Colour tokens are unaffected — those
utilities do emit `var(--color-…)`.

**`color-scheme`** is set on `:root` (`light`) and flipped to `dark` under the
attribute, so native widget chrome — `<select>` popups, scrollbars, the time
picker, autofill — follows the app's theme rather than the OS's. Light states its
value explicitly (it matches the UA default, so nothing changes there) to keep an
OS-dark machine from painting dark widgets into the light theme.

**White-on-fill labels.** `text-white` stays on `accent`-filled buttons in both
themes: `accent` does not shift, so the ratio is the same 3.13:1 it has always
been. The one exception is the **danger** confirm button: `status-stopped` lifts
to a bright coral in dark, where white falls to 2.9:1 — it takes `dark:text-surface`
instead (canvas-dark ink on the coral, 6.1:1). The `Toggle` knob stays `bg-white`
in both themes; it sits on a solid track and holds 3.13:1 on the accent (on) and
10.4:1 on `surface-border` (off).

**Computed contrast (WCAG 2.1 relative luminance), dark theme.** Same discipline
as the light side: every text and status token clears AA (≥4.5:1) on all three
surfaces *and* on the input well. `text-muted` is the floor at 5.21:1 on a card
(light's floor is 4.74:1 on the sidebar). Check before lightening a surface or
darkening a text token.

| Token | on `sidebar` | on `surface` | on `surface-card` | on `surface-input` |
|-------|-------------|--------------|-------------------|--------------------|
| `text-primary` | 16.03 | 15.32 | 13.94 | 15.64 |
| `text-secondary` | 10.27 | 9.81 | 8.93 | 10.02 |
| `text-muted` | 5.99 | 5.73 | **5.21** | 5.85 |
| `accent-text` | 9.78 | 9.35 | 8.50 | 9.54 |
| `status-running` | 8.63 | 8.24 | 7.50 | 8.41 |
| `status-warning` | 8.45 | 8.07 | 7.34 | 8.24 |
| `status-stopped` | 6.37 | 6.09 | 5.54 | 6.22 |
| `status-transition` | 5.84 | 5.58 | 5.08 | 5.70 |

Text on its own soft wash: `accent-text` 7.22, `status-running` 5.82,
`status-warning` 5.78, `status-stopped` 4.74. Brand `accent` as a graphic clears
the 3:1 floor on every surface (5.08–5.84).

The dark theme adds three derived backgrounds that are not tokens — Home's
asleep tile, Home's canvas wash, and the lit lantern well. Text on them clears
AA too:

| Derived background | Value | `text-primary` | `text-secondary` | `text-muted` | `accent-text` |
|---|---|---|---|---|---|
| Asleep tile (`--wisp-tile-asleep`) | `#11211f` | 14.64 | 9.38 | **5.47** | 8.93 |
| Canvas wash **at its brightest** | `#0e302d` | 12.39 | 7.94 | **4.63** | 7.56 |
| Lit lantern well, centre | `#125a53` | — | — | — | 4.29 *(icon — graphic, 3:1 floor)* |

The wash figure is a worst case that no text actually sits on: the gradient's
centre is at `18% -10%`, i.e. *above* the canvas, and at the counts line's real
position the wash has fallen to ~1% (≈5.7:1). Recorded so a future strengthening
of the wash is checked against the number, not the impression.

#### Glow — the Dusk light system *(settled 2026-08-25)*

Dark is where the Will-o'-the-Wisp identity does real work: **a running workload
glows**. Three utilities carry it, all in `index.css`, all `color-mix` of the
tokens, all no-ops in light:

- **Home's lanterns** — the full canvas treatment; see § Home → Home in the dark theme.
- **`wisp-lit-glyph`** — the running workload's icon in the sidebar list rows
  (`VMListItem`, `ContainerListItem`) and in the VM/container **detail header**.
  A `drop-shadow(0 0 4px status-running/55%)`, so the halo follows the glyph's
  strokes rather than its bounding box. **Static, not breathing**: this is
  chrome, not the Home canvas, and a list of animated rows is a distraction.
  Applied only while the workload runs, so a glow always means the same thing.
- **`wisp-brand-glow`** — the `WispGlyph` at the two moments it stands for the
  app itself: the top-bar wordmark and the login card. Accent instead of the
  running green, `drop-shadow(0 0 6px accent/45%)`. Deliberately *not* inside
  `WispGlyph`, which is also an icon-picker choice — a permanent glow there
  would say "running" about a stopped workload.

`login-dusk` is the one atmospheric extra: the login page is the only full-page
canvas outside Home, and in dusk a flat near-black field with one card on it is
exactly the generic dark mode this theme exists to avoid. It borrows Home's wash
— the same light, from the same direction — so the two canvases read as one
place. Dark only; the light login keeps its plain `bg-surface`.

Rejected: a glow on the light theme's running rows (the green already carries
the state, and a halo around a 14px icon reads as a rendering artefact), and
`box-shadow` for the glyph halos (it outlines the icon's box, and on the header
icon it would light up the whole hover-tinted button).

#### Theme activation and persistence *(settled 2026-08-25)*

- **Three states**: `light`, `dark`, `system` — **`system` is the default**, following the OS `prefers-color-scheme` and tracking it **live** (the media query is subscribed while the tab is open, so a phone flipping to dark at sunset recolors without a reload). An explicit `light` or `dark` overrides the OS.
- **Mechanism**: `data-theme="dark"` on `<html>`. `system` and `light` carry no attribute; only `dark` sets one. Redefining the `@theme` variables under that attribute is the whole implementation — no per-component theming. A `@custom-variant dark` keyed to `[data-theme='dark'] &` exists for the rare utility that needs more than a token swap; Tailwind v4's built-in `dark:` is repointed at the attribute, because its default `prefers-color-scheme` behavior would ignore a manual choice.
- **Persistence is per-device**, `localStorage` key **`wisp_theme`** (matching the existing `wisp_logout` key style), *not* `wisp-config.json`. `system` is only meaningful per device, and the phone wants dark at night while the desktop stays light. The Data rule above (the server is the source of truth) governs workload and config data, not per-viewer presentation. Rejected: server-side persistence — revisit only if multi-device sync is actually missed. Every access is wrapped in `try`/`catch`; a private window falls back to `system` and still themes correctly for the page's lifetime.
- **Owner**: `frontend/src/theme.js` — framework-free, because the same state must be resolved before React exists. `store/themeStore.js` is a thin Zustand mirror for React; it never writes the attribute itself.
- **No flash on load**: a small inline script in `index.html`'s `<head>` resolves the theme and sets the attribute before the parser reaches `<body>` or any stylesheet. It cannot move into the bundle — a deferred module script paints light first and snaps to dark. Because it is inline, the prod CSP (`script-src 'self'`) would block it, so its **sha256 is pinned in `backend/src/app.js` as `THEME_INIT_SCRIPT_HASH`** rather than opening `unsafe-inline`. Editing that script means refreshing that constant (the file carries the regeneration one-liner); a stale hash blocks the script and dark devices flash light on load.
- **`<meta name="theme-color">`** is updated on every effective-theme change: light keeps the brand teal `#0fa396` it has always used, dark takes `surface-card` `#142523` — the top bar the phone's status strip sits above. A luminous teal band over a dark app is precisely the flash worth avoiding; the light value is deliberately left alone.
- **The control** lives in the top bar's right cluster, between background jobs and sign out: icon-only (Action buttons, above) (`Sun` / `Moon` / `Monitor`), cycling light → dark → system on tap, with `title`/`aria-label` announcing the current mode ("Theme: system (following OS)"). It sits in the cluster that is row 1 in both top-bar layouts, so it works unchanged on the phone's two-row bar.

#### Typography

Body/UI text uses the system stack — no runtime font loading from external hosts:

```
font-family: system-ui, -apple-system, sans-serif
```

Custom fonts are allowed only when **bundled** with the app (self-hosted woff2 + license file in `frontend/src/assets/fonts/`). One display face is bundled: **Bricolage Grotesque 600** (`--font-display`, class `font-display`), used **only** for brand moments — the top-bar wordmark, the login title, and empty-state headings. Tables, labels, and body copy stay on the system stack.

#### Favicon

`frontend/public/favicon.png` (32×32, alpha) and `favicon.svg`. `index.html` declares the PNG first, then the SVG (`sizes="any"`), so browsers that composite SVG favicons poorly still get a bitmap with reliable transparency; others can use the SVG for sharp scaling.

#### Spacing and Shape

- **Card border radius:** 8px
- **Card shadow:** `0 1px 3px rgba(0,0,0,0.08)` — subtle, not dramatic
- **Transitions:** 150ms on all interactive state changes

#### Section headings

Small all-caps muted label style: `11px, font-semibold, uppercase, tracking-wider, text-muted`. Not large headers.

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
  are not exported.
- Colocate related files: a view's components, styles and tests sit in one directory.

## UI patterns: section lists, tables and modals `[PROJECT]`

Conventions for repeating rows in Host, VM, Container, and Library panels, and for every
modal. The screens themselves are [`specs/UI.md`](specs/UI.md).

### Purpose

Apply these rules when building or refactoring:

- Multi-row editors (mounts, env vars, network storage, NIC lists, and similar).
- Dense read-only or action tables (hardware inventory, backups, image library).
- Any UI where the user adds, edits, saves, or deletes **items in a collection** shown as a list or table.

### Core rules (target standard)

#### 1. Row-based persistence

Apply each **save**, **delete**, and other mutating action to **one row** (one API call / one server mutation scoped to that entity). Avoid PATCHing or replacing an **entire parent array** from the client for convenience when the product model is naturally per-item.

- Prefer purpose-named backend operations and matching client calls (e.g. add/update/remove one mount), consistent with CODING-RULES §2 and §7.
- If the API is intentionally a single “replace whole list” contract, document that exception in the API spec; still prefer row-scoped APIs when the UI presents independent rows.

#### 2. Add controls in the section header (right)

Place **add** actions in `SectionCard` **`headerAction`**, aligned to the **far right** of the section header (after restart badge and Save when dirty). Never let header clicks toggle collapse: give the right-hand control cluster `stopPropagation` when the card is collapsible.

- **Add buttons:** accent background; **icon-only** or **`Plus` + a second icon** that names the kind of thing being added (e.g. `Plus`+`File`, `Plus`+`Folder`, `Plus`+`Server` for network mount, `Plus`+`Network` for bridge or NIC, `Plus`+`Braces` for env).
- Do **not** use a full-width dashed “add row” at the bottom of the table for the primary add path when a header add is appropriate.
- Point **empty state** copy at the header control rather than duplicating a second add button.

#### 3. Row actions: icon-only

Make table and list **row actions** (edit, delete, mount, check, revert, etc.) **icon-only** buttons with `title` and `aria-label`. Use shared table chrome styling (e.g. bordered `p-1.5` hit targets) for consistency.

- **Order:** Place **other actions first** (save/cancel while editing, upload, test connection, mount/unmount, revert/restore, open file editor, etc.), then the **Edit** control (**`Pencil`** — or the row’s primary “enter edit” affordance), then **Delete** (**`Trash2`**) **last**. Keep Edit and Delete adjacent when both are shown.

- **Save / Confirm uses the primary variant.** When a row is in edit/draft mode, give the commit button (Save, Add, Attach, Confirm) **`rowActionIconBtnPrimary`** from `DataTableChrome.jsx` (accent background, white icon), and the non-primary buttons (Cancel, Edit, Delete, etc.) **`rowActionIconBtn`** (bordered, neutral). This keeps the commit affordance visible at a glance and matches the header `+` add buttons.

- **Mount state:** Do not show a separate “Mounted / Not mounted” text column when a single mount/unmount control exists; encode state with the **background** of that control (e.g. green tint when mounted). When a row has a persistent state worth showing at a glance (mounted / present / disconnected), render it as a small **status dot before the label** (green `bg-status-running`, gray `bg-text-muted/40`, red `bg-status-stopped`; `title` + `aria-label` carry the words) instead of a Status column — this works at every breakpoint and frees a column on desktop. See `StatusDot` in [HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx).

- **Phones — tap-to-expand actions:** when a row carries several actions, hide the Actions column below `sm` (`hidden sm:table-cell` on its `<th>`/`<td>`) and render the **same buttons** in a strip that expands **under the row's stacked text when the row is tapped** (one row expanded at a time; `<tr>` gets `cursor-pointer sm:cursor-auto` + an onClick toggle; the strip and the desktop Actions cell wrap their buttons in `stopPropagation` containers). This keeps narrow tables free of horizontal scroll while every action stays reachable. Reference: the SMB and Removable drives tables in [HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx).


### Table chrome (shared layout)

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

### Section shell (Host panels and table pages)

Build major blocks on **Host** tabs (Overview, Host Mgmt, Image Library) with **`SectionCard`** so tables and forms match the same **white card on page background** look as Host Overview sections.

| Aspect | Convention |
|--------|----------------|
| **Card** | `SectionCard` — `rounded-card border border-surface-border bg-surface-card` |
| **`titleIcon`** | Lucide icon **14px**, **`strokeWidth={2}`**, muted (SectionCard places it before the uppercase title). Same pattern as [HostOverview.jsx](../frontend/src/components/host/HostOverview.jsx) (CPU, Memory, Hardware, etc.). |
| **`helpText`** | Optional one-line description shown via a small `HelpCircle` icon next to the title (native `title=` + `aria-label`, rendered by [HelpIcon.jsx](../frontend/src/components/shared/HelpIcon.jsx)). Use this instead of an in-body `<p className="text-text-muted">` blurb when the text is descriptive context the user can ignore — keeps vertical space for actual content. |
| **Header right** | Filters, **Save**, **`headerAction`** (add/upload/download icons) stay in the section header row — not inside the HTML `<thead>`. |
| **Body** | Default content padding `px-5 py-4` below the header divider (`border-t`). |
| **Page gutters** | Outer wrapper **`px-6 py-5`** (and **`space-y-5`** between multiple sections); outer container scrolls when content is tall — same as Host Overview / Host Mgmt. |

Give a single-section view (e.g. **Image Library**) one **`SectionCard`** with the table inside the body; stack several **`SectionCard`**s in a multi-section view.

### Row state and errors

- **Per-row loading:** Disable or show a spinner on the row (or action) that triggered the request; avoid blocking unrelated rows unless the backend requires it.
- **Workload busy** (a running job — a backup, a start, a delete, any kind — holds the workload's backend lock, so every mutation would 409): disable the mutating controls rather than letting them fail, with the reason as their `title`; tables reuse their lock note for the same text, and section **Save** buttons take it too. A workload is busy while a running job on the `jobs` topic has it as its `subject`, never by comparing a job's title (settled 2026-11-20); the reason names that job's title.
- **Errors:** Prefer row-scoped or action-scoped messages when a single row fails; use section-level error (e.g. `SectionCard` `error`) for load failures or cross-row validation that is not tied to one line.

### Variants

| Variant | Behaviour | Examples |
|---------|-----------|----------|
| **Editable rows** | Inline fields after **Edit** where applicable; per-row save; row-scoped API when the backend supports it. For 3+ fields or mobile-required flows prefer the **Modal form editor** variant below. | Create-flow draft rows only ([VmNetworkInterfacesSection.jsx](../frontend/src/components/sections/VmNetworkInterfacesSection.jsx) and [DisksSection.jsx](../frontend/src/components/sections/DisksSection.jsx) under `isCreating`) — the detail-page editors have moved to the **Modal form editor** variant |
| **Action table** | Read-only cells; row actions **on row hover** (shared interactive row + `DataTableRowActions`) | Backups |
| **Library / assets** | Per-entity API; **upload/download in page header** (icon-only); optional confirm for destructive ops; rename/delete **on row hover** | Image Library |
| **Read-only inventory** | No mutations; optional grouping rows | Host Overview → Hardware table |
| **VM — Network interfaces** | Own **SectionCard** before **Advanced**; **table** of NICs. **Documented exception:** every add / edit / remove **PATCH**es the full **`nics`** array (same contract as before). Detail page: rows are **read-only** — **Add NIC** in the header (**`Plus`+`Network`**) and row **`Pencil`** open the **modal form editor**, row **`Trash2`** removes without a confirm (hidden at the last NIC). While the VM runs all three are **disabled** with a lock note under the table. The **create flow** (`isCreating`) keeps all-inputs draft rows. | [VmNetworkInterfacesSection.jsx](../frontend/src/components/sections/VmNetworkInterfacesSection.jsx), [NicEditorModal.jsx](../frontend/src/components/sections/NicEditorModal.jsx) |
| **VM — USB devices** | **SectionCard** with **table** of **attached** devices only (read-only cells; **Detach** on row hover). **Attach**: header **`Plus`+`Usb`** opens **[UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx)** with a **second table** inside a white bordered card (same idea as Image Library body); host devices not yet attached; per-row icon **Attach** (hover-reveal). Successful attach **closes** the modal. | [USBSection.jsx](../frontend/src/components/sections/USBSection.jsx), [UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx) |
| **Secret file mount** (settled 2026-10-16) | The secret env var model applied to a file mount's content: a **Secret** checkbox in **[ContainerMountEditorModal.jsx](../frontend/src/components/sections/ContainerMountEditorModal.jsx)** (file mounts, create + edit; the edit hint warns that unchecking empties the stored file, as unchecking a secret env var clears its value). Rows show `secret · set` / `secret · not set` after the mount name and the size; the row never fetches content — **Edit file** is replaced by **`KeyRound`** (*Replace secret content*), which opens **[SecretMountContentModal.jsx](../frontend/src/components/sections/SecretMountContentModal.jsx)**: an empty textarea (Save writes it with PUT content) plus a footer-left **Clear** behind a nested `ConfirmDialog`. **Upload** stays a row action. `MountFileEditorModal` is never opened for a secret row. | [ContainerMountsSection.jsx](../frontend/src/components/sections/ContainerMountsSection.jsx) |
| **Container environment** | **Documented exception:** each save **PATCH**es `envPatch` against the whole **`env`** object (delta entries plus `null` for removals). No **section Save** in the header; rows are **read-only** — **Add** in header **`Plus`+`Braces`** and row **`Pencil`** open the **modal form editor**, row **`Trash2`** deletes without a confirm. The **`Dices`** generate-secret action lives inside the modal beside the value field (one-time copyable value; Apply fills the field, modal Save commits) and the secret flag is a checkbox there — no row-level lock action. | [ContainerEnvSection.jsx](../frontend/src/components/sections/ContainerEnvSection.jsx), [EnvVarEditorModal.jsx](../frontend/src/components/sections/EnvVarEditorModal.jsx) |
| **Pill row + modal editor** | When per-item config attaches to a small, well-known set of items (e.g. ports), render the items as **clickable pills** with state encoded by an in-pill icon (no color); clicking a pill opens that item's editor in a **`Modal`** (the open item's pill carries an accent ring). A trailing **dashed `+` pill** opens the modal in *add* mode for items not in the source list. Mutations use row-scoped APIs (one per item); no section Save. The modal can't be dismissed while a save is in flight. Use this when the data anchors naturally to a visible item rather than a separate table. | [ContainerNetworkSection.jsx](../frontend/src/components/sections/ContainerNetworkSection.jsx) (per-port mDNS service advertisements) |
| **Modal form editor** | Row create/edit via a **modal form** instead of inline cell-swapping — the default for editors with 3+ fields or any editor that must work on phones. Table rows stay read-only; row **Edit** (pencil) and header **Add** open the modal. See **§ Modal form editor** below. | [SmbShareEditorModal.jsx](../frontend/src/components/host/SmbShareEditorModal.jsx), [RemovableDriveEditorModal.jsx](../frontend/src/components/host/RemovableDriveEditorModal.jsx), [BridgeCreateModal.jsx](../frontend/src/components/host/BridgeCreateModal.jsx), [EnvVarEditorModal.jsx](../frontend/src/components/sections/EnvVarEditorModal.jsx), [NicEditorModal.jsx](../frontend/src/components/sections/NicEditorModal.jsx), [ContainerMountEditorModal.jsx](../frontend/src/components/sections/ContainerMountEditorModal.jsx), [DiskEditorModal.jsx](../frontend/src/components/sections/DiskEditorModal.jsx) |

### Reference implementations

- **[ImageLibrary.jsx](../frontend/src/components/library/ImageLibrary.jsx)** — **`SectionCard`** shell (Host Library tab); **`titleIcon`** + header icon actions (upload, URL/preset downloads); per-file row operations; shared table chrome.
- **[UsbAttachModal.jsx](../frontend/src/components/shared/UsbAttachModal.jsx)** — Modal shell (image-library style): scroll area on **`bg-surface`**, table inside **`rounded-card` + `bg-surface-card` + border** like **`SectionCard`**; dense **`DataTable`** with **`dataTableInteractiveRowClass`**; per-row icon **Attach** (**`DataTableRowActions`**, hover-reveal).
- **[HostNetworkBridges.jsx](../frontend/src/components/host/HostNetworkBridges.jsx)** — Header `Plus`+`Network` opens `BridgeCreateModal`; read-only rows; icon-only delete (visible on phones).
- **[ContainerMountsSection.jsx](../frontend/src/components/sections/ContainerMountsSection.jsx)** — Row-scoped mount API; read-only rows at every breakpoint. Three header adds (`Plus`+`File` / `Plus`+`Folder` / `Plus`+`MemoryStick`) and row `Pencil` open **[ContainerMountEditorModal.jsx](../frontend/src/components/sections/ContainerMountEditorModal.jsx)** — one modal with two entry points (create with the tapped `kind`, or edit the row) like `RemovableDriveEditorModal`, its fields switching on the mount kind. Edit-file / Upload / Zip-upload stay row actions, so the set reaches five: below `sm` the Actions column hides and the buttons move into the tap-to-expand strip, with every other column stacked under the container path.
- **[ContainerEnvSection.jsx](../frontend/src/components/sections/ContainerEnvSection.jsx)** — Read-only rows at every breakpoint; header `Plus`+`Braces` and row `Pencil` open **[EnvVarEditorModal.jsx](../frontend/src/components/sections/EnvVarEditorModal.jsx)**; two row actions (Edit, Remove) fit on phones, so the Actions column stays visible (HostNetworkBridges style, no tap-to-expand strip); the generate-secret `ConfirmDialog` is nested inside the editor modal.
- **[VmNetworkInterfacesSection.jsx](../frontend/src/components/sections/VmNetworkInterfacesSection.jsx)** — Read-only rows at every breakpoint on the detail page; header `Plus`+`Network` and row `Pencil` open **[NicEditorModal.jsx](../frontend/src/components/sections/NicEditorModal.jsx)**; two row actions (Edit, Remove) fit on phones, so the Actions column stays visible and the Model / MAC columns collapse under the bridge instead. The `networkLocked` (VM running) state **disables** Add / Edit / Remove rather than hiding them, with the lock note visible at every width. The `isCreating` branch keeps its inline draft rows, so the model picker lives in its own file ([NicModelPills.jsx](../frontend/src/components/sections/NicModelPills.jsx)) shared by both.
- **[DisksSection.jsx](../frontend/src/components/sections/DisksSection.jsx)** — Fixed slot model (`sda`/`sdb` block disks, `sdc`/`sdd` CD-ROMs, `sde` cloud-init seed), so rows are hand-written rather than mapped. Detail page: read-only rows at every breakpoint; header **`Plus`+`HardDrive`** and row `Pencil` open **[DiskEditorModal.jsx](../frontend/src/components/sections/DiskEditorModal.jsx)** — one modal with two entry points (edit the disk's size + bus, or add the second disk as a new volume or an attached library image). Mutations stay the row-scoped disk APIs, in the order the inline editors used (`updateDiskBus` then `resizeDisk`; `attachDiskToVM` then the optional `resizeDisk`). **No nested picker** (settled 2026-08-25): the attach select lists the library's disk images, while ISO attach/change keeps opening `ImageLibraryModal` directly from the row — the picker *is* that flow's form, so nesting it inside an editor modal would stack two dialogs for no gain. Two row actions fit on phones, so the Actions column stays visible and Size / Image / Image type / Bus collapse under the slot label instead. The `isCreating` branch keeps its inline draft rows (create stays desktop-oriented).
- **[ContainerNetworkSection.jsx](../frontend/src/components/sections/ContainerNetworkSection.jsx)** — Pill row of exposed ports; a pill (or the trailing dashed `+` pill for non-EXPOSE ports) opens a **`Modal`** for per-port mDNS service editing (`Radio` icon inside pill when configured, no color encoding).
- **[HostStorage.jsx](../frontend/src/components/host/HostStorage.jsx)** — Row-scoped mount API (`/api/host/mounts`) for SMB + adopted removable drives; `DataTable` chrome with **read-only rows** — create/edit/adopt go through `SmbShareEditorModal` / `RemovableDriveEditorModal`; mount state as a **status dot before the label** (no Status column); on phones the Actions column is hidden and actions **expand under the row text on tap**; combined mount/unmount with mounted-state background; SMB **Check** uses green/red on the shield button (errors on hover); separate "Detected drives" table rendered only when non-empty, visible at all breakpoints.
- **[BackupsPanel.jsx](../frontend/src/components/backups/BackupsPanel.jsx)** — Collapsible per-workload cards (custom rich headers on the SectionCard visual tokens); per-backup icon actions on row hover; typed-name `ConfirmDialog` for container restore-in-place.
- **[HostOverview.jsx](../frontend/src/components/host/HostOverview.jsx)** (hardware inventory) — Read-only; **`SectionCard`** + **`titleIcon`** per section; shared table chrome.
- **[HostMgmt.jsx](../frontend/src/components/host/HostMgmt.jsx)** — Stacked **`SectionCard`**s (**OS Update**, **Network Bridges**, **Network Storage**, **Backup**) with **`titleIcon`** on each; same page gutters as Overview.

### Modals and dialogs

Route every full-screen overlay through the shared **[Modal.jsx](../frontend/src/components/shared/Modal.jsx)** primitive. It owns:

- The fixed-position backdrop (standardized on **`bg-black/40`**) and centered card (**`bg-surface-card`** + border + shadow), rendered in a portal on `document.body`; the card is a `role="dialog"` `aria-modal` named by its title (or `ariaLabel`).
- Its layer on the shared stack (**[lib/layers.js](../frontend/src/lib/layers.js)**, settled 2026-11-12): Escape closes only the top layer, Tab stays inside the card, the app root under it is inert, and focus returns to the opener on close. Page-level Escape handlers stand down while `hasOpenLayer()`; a control that uses Escape itself (an inline rename) claims it with `preventDefault()`. The phone drawer and every popover are layers too; popovers go through **[lib/popover.js](../frontend/src/lib/popover.js)** (portal, viewport clamp, outside press closes).
- An optional **title / subtitle / X-button** header bar and an optional **footer** bar (right-aligned, bordered).
- Width via **`size`** (`sm` | `md` | `lg` | `xl` | `2xl` | `3xl` | `4xl`) and height via **`height`** (`auto` | `tall` for `h-[80vh]` | `cap` for `max-h-[85vh]`).
- Body padding via **`bodyPadding`** (`default` `px-4 py-4` | `compact` `px-4 py-3` | `none` for full-bleed content).
- Guard flag **`closeOnEscape`** for in-flight save/upload states. A click on the backdrop closes nothing (settled 2026-11-12): Escape, the X and Cancel do, so a stray click can't discard a form's edits.

Never open ad-hoc `fixed inset-0` overlays: wrap new modal-style UI in `<Modal>` so backdrop, escape, layer, and styling stay consistent.

#### Modal form editor

The standard shape for creating or editing **one entity** (a mount, a bridge, a token, …). Prefer it over inline cell-swapping row editors whenever the editor has **3+ fields** or the flow must work on **phones** — inline row editors are desktop-only by construction and forced the old Host Mgmt sections to hide add/edit below `sm`. Existing inline editors are candidates for refactoring to this pattern.

Structure (see **[FormModalChrome.jsx](../frontend/src/components/shared/FormModalChrome.jsx)** for the shared tokens):

- **One purpose-named modal component per entity kind** (`SmbShareEditorModal`, not a generic kind-switched editor), owning its form, validation, and API calls; its record is its parent's (Data). Create vs edit is whether the parent names an entity to edit; the parent passes `onClose`, and `onSaved` only when it has its own follow-up to a save (the SMB editor's parent drops its connection-test results).
- **Shell:** `<Modal size="sm"|"md" height="cap">` with `title` (e.g. "Edit SMB share") and a context `subtitle` (the share path, the device name). Escape stays closed while the save runs.
- **Fields:** stacked **`FormField`** (label above control, optional hint below) in a `space-y-3` `<form id=…>`; short related fields pair into `sm:grid-cols-2`. Controls use the **`input-field`** utility; checkboxes use **`FormCheckbox`** (box left, label + hint right). Read-only identity (UUID, filesystem, derived names) renders as a muted summary box or preview line, not as disabled inputs. The first field focuses on open through the focus module (`ref={autoFocusField}`, [lib/focus.js](../frontend/src/lib/focus.js)) — never on a touch device; Enter submits via the form.
- **Footer** (via the Modal `footer` prop): right-aligned **Cancel** (`formModalNeutralBtn`) + primary **Save/Create/Adopt** (`formModalPrimaryBtn`, disabled until the save would send something — valid values, and for an edit a change (Data) — `Loader2` while saving). Secondary actions (e.g. SMB **Test connection**) sit footer-left in an `mr-auto` group; a pass shows there as inline text (green OK), a failure as the action's own error in the body.
- **Errors:** the save's error as an **`ErrorBanner`** at the bottom of the body, dismissible; the modal stays open on failure. The save ends once its record's re-read has landed; on success the modal then closes.
- **Nested dialogs** (settled 2026-08-25, reworked 2026-11-12): a `ConfirmDialog` opened from inside an editor modal is the top layer; the layer stack sends Escape to it alone, with no flag on the parent. Render it as a sibling of `<Modal>`, not inside its scrolling body. Reference: the generate-secret dialog in [EnvVarEditorModal.jsx](../frontend/src/components/sections/EnvVarEditorModal.jsx).
- **Rows stay read-only.** The table keeps display cells only; row actions shrink to purpose actions (mount, check) + **Edit** + **Delete**, which fit on phones. Write-only secrets keep the "empty means keep what's on file" convention with a hint under the field.

#### Confirmation, alert, and informational dialogs

- **[ConfirmDialog.jsx](../frontend/src/components/shared/ConfirmDialog.jsx)** — Two-button confirm for destructive or impactful actions. Defaults to a red-tinted `Confirm` button (`variant="danger"`); pass `variant="primary"` for non-destructive accept (e.g. install update). Replaces `window.confirm()`.
- **A confirm then its command** (settled 2026-11-21, the anchor's majority: eleven of its seventeen confirms that run a command): the confirm closes when it is accepted, and the command runs as the control's own — its row or button shows it in flight, its error shows where that view's command errors show. A confirm that checks what was typed (restore in place) stays open only while that check fails.
- **[AlertDialog.jsx](../frontend/src/components/shared/AlertDialog.jsx)** — Single-button informational/error dialog. Pass `tone="error"` to highlight the title in stopped color. Replaces `window.alert()`.

- **Data-deleting section Save** (settled 2026-10-16): in a form that stages edits behind one section **Save** (e.g. the tiny-samba app config), let removing a row only stage the removal, and open the confirm at **Save**, listing exactly what the save will delete (computed against the loaded state, so an unsaved row or one whose data survives needs no prompt), with a `Delete and save` danger button. Confirming at the trash icon would be premature: the user can still undo by not saving. Reference: [TinySambaAppSection.jsx](../frontend/src/apps/tinySamba/TinySambaAppSection.jsx).

Never call native `window.alert()` or `window.confirm()`: use these dialogs for async-error reporting and confirmation prompts, so they pick up the same shell, focus, and styling as the rest of the app.

## React

- Keep effect dependencies **stable**: primitive values or serialised representations,
  not object references that change identity every render.
- Memoise callbacks passed to effects or child components.
  - Applied: use `useCallback` for handlers passed to effects or children.
