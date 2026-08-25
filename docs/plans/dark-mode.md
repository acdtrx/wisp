# Dark mode — the Dusk treatment

## Goal

A full dark theme for Wisp in the "Dusk" direction from the Home page design
exploration: deep spruce-dusk surfaces, the luminous teal accent doing real
work in the dark, and running workloads that visibly glow. Not a neutral gray
skin — dark is where the Will-o'-the-Wisp identity should feel most at home.

Decisions (settled 2026-08-25, user-confirmed):

- **Activation**: follows the OS `prefers-color-scheme` by default; a manual
  Light / Dark / System control overrides it.
- **Depth**: full Dusk treatment from the start — glow and atmosphere
  throughout, not just a palette swap with accents deferred.
- **Control**: compact control in the top bar.
- **Persistence**: per-device in `localStorage` (`System` is inherently a
  per-device mode; the phone can be dark at night while the desktop stays
  light). Not in `wisp-config.json`. This is a UI preference, not server
  state — the CODING-RULES §7 "server is source of truth" rule governs
  workload/config data, not per-viewer presentation.

## Why the codebase is ready for this

- Tailwind v4: every color is a semantic `@theme` CSS variable in
  `frontend/src/index.css` (`--color-surface*`, `--color-accent*`,
  `--color-status-*`, `--color-text-*`). Redefining those variables under a
  dark scope cascades through every utility class with no per-component work.
- UI-PATTERNS discipline: washes already use the `-soft` tokens, not raw
  palette classes; the Lanterns utilities derive everything from the tokens
  via `color-mix`.

The residue that does NOT theme automatically (the actual work):

- ~42 component files using `bg-white` / `text-white` / `bg-black*` classes
  (audited 2026-08-25), plus `input-field`'s `bg-white` in `index.css`.
- `color-mix(... , white)` in the Lanterns/glow utilities — mixing toward
  white is wrong on dark; these need token-relative dark variants.
- xterm console theme object (`ContainerConsole.jsx` and the VM console
  equivalent), noVNC canvas surroundings.
- `<meta name="theme-color">` in `index.html` (phone status bar color).
- Shadows (`--shadow-card`) and any status-color AA contrast re-checks on
  dark surfaces (UI.md documents the light-side contrast reasoning; dark
  needs the same).

## Mechanism

- `data-theme="dark"` attribute on `<html>`; a `@custom-variant dark`
  (Tailwind v4) keyed to `[data-theme="dark"]` for the rare per-utility
  override; the bulk is variable redefinition:
  `[data-theme="dark"] { --color-surface: …; … }` in `index.css`.
- Theme controller (`frontend/src/theme.js` + a small top-bar component):
  reads `localStorage` (`light` | `dark` | `system`, default `system`),
  applies/removes the attribute, subscribes to the `prefers-color-scheme`
  media query while in `system`, updates `<meta name="theme-color">` on
  every effective-theme change.
- **No-flash**: a tiny inline script in `index.html` `<head>` sets
  `data-theme` from `localStorage` before first paint. It must be
  CSP-benign and duplicated logic kept minimal (read key, apply attribute —
  the controller re-derives everything else after hydration).
- The control: three-state (Light / Dark / System) compact top-bar control,
  icon-only per CODING-RULES §8 (`Sun` / `Moon` / `Monitor`), cycling on tap
  with `title`/`aria-label` announcing the current mode.

## The Dusk palette (design intent, exact values iterated in-step)

- Surfaces: deep spruce — very dark desaturated green-teal (not slate, not
  black), sidebar a shade deeper than the canvas, cards a shade lighter.
- Accent: the luminous teal reads brighter in dark; `accent-text` needs a
  lighter variant to hold ≥4.5:1 on dark surfaces.
- Status colors: lifted for AA on dark; `-soft` washes become translucent
  dark tints (status color mixed toward the surface, not toward white).
- Text: warm-white primary with the same faint teal cast the light theme's
  neutrals carry; muted floor re-checked at ≥4.5:1.
- Glow: running workloads glow — Home lanterns (already built, amplified in
  dark), sidebar running-status dots gain a soft accent halo, the VM/container
  header status badge glows when running. Glow is `box-shadow`/`color-mix`
  from tokens only; `motion-reduce` and plain-static variants respected.

## Scope

- Everything routed: login, sidebar + top bar, Home, host tabs (Overview,
  Mgmt, Software, Library, Backups, Settings), VM/container detail (all
  sections + consoles), modals/dialogs, toasts/errors, empty states.
- Specs: `docs/spec/UI.md` (§ Design Language gains the dark palette table +
  activation/persistence contract), `docs/UI-PATTERNS.md` only if a pattern
  rule changes (soft-token rule already phrased theme-neutrally),
  `CHANGELOG.md`.

## Out of scope

- Server-side persistence of the theme choice (revisit if multi-device sync
  is ever missed in practice).
- Per-page custom dark art beyond the Dusk glow system (no bespoke
  illustrations).
- Light-theme visual changes — light stays exactly as it is.

## Steps

Branch `feature/dark-mode` in a worktree under `.claude/worktrees/`; each
step commits before the next starts.

1. **Foundation** — dark token set in `index.css` (`[data-theme="dark"]`
   variable block + `@custom-variant dark`), theme controller + no-flash
   script + top-bar control, `theme-color` meta handling. Fix `input-field`'s
   `bg-white` → token. Accept: toggling flips the whole app coherently even
   though residue files still show light spots; no flash on reload; System
   mode tracks the OS live; build passes.
2. **Sweep** — the ~42 files with hardcoded white/black classes → tokens or
   `dark:` variants; xterm/noVNC console theming; shadows; scrollbars if
   styled. Accept: no visually broken surface on any page in dark (driven
   via dev stack + harness screenshots at desktop and phone widths); build
   passes.
3. **Dusk glow pass** — Lanterns utilities' dark variants (`color-mix`
   toward surface, glow strengths tuned for dark), sidebar running-dot halo,
   detail-header status glow, canvas washes. AA contrast verification for
   text/status on the final surfaces. Accept: screenshots reviewed against
   the Dusk intent; contrast table recorded in UI.md.
4. **Docs + changelog + release** — UI.md Design Language dark section,
   CHANGELOG entry; cut `2.3.0-beta.2` for phone testing in real dark
   surroundings.

## Progress

### Step 1 — Foundation ✅ (2026-08-25)

Shipped: the `:root[data-theme='dark']` token block + `@custom-variant dark` in
`index.css`, `--color-surface-input` (replacing `input-field`'s hardcoded
`bg-white`), a dark `--shadow-card`, a dark default for the v3 border-colour
compat rule, the `theme.js` controller + `themeStore.js` mirror + `ThemeToggle`
in the top bar, and the no-flash inline script with its sha256 pinned in the
prod CSP. Palette values, computed contrast ratios, and the
activation/persistence contract are recorded in
[`docs/spec/UI.md`](../spec/UI.md) § Design Language.

Verified in the dev stack: the control cycles light → dark → system with the
attribute, `theme-color` meta, and page colours following; `system` tracks a
live `prefers-color-scheme` flip in both directions with no reload; an explicit
choice overrides the OS; the choice survives a reload. No-flash was proven
against a **production** build (CSP active): the inline script's
`setAttribute('data-theme')` fires at `readyState: loading` with `document.body`
still null and `document.styleSheets.length === 0`, and no CSP violation is
raised — so the pinned hash matches and nothing can have painted.

**Expected-broken until Step 2** (accepted intermediate state per the phase
rules): the 43 files still carrying hardcoded `white`/`black` classes show light
spots in dark. Audited inventory for the sweep:

- `bg-white` fills — `ManualLinkModal`, `ContainerDevicesSection` (×2),
  `OsUpdateSection`, `ImageLibrary`, `JellyfinAppSection` (×4),
  `Toggle` (the knob), `CreateVMPanel` (`bg-white/50` detail `<pre>`).
- `text-white` — 36 files. Mostly glyphs on accent fills (visually fine, and
  white-on-accent holds the same 3.13:1 it holds in light); the ones on
  card/surface backgrounds (`DataTableChrome`, `SectionCard`,
  `FormModalChrome`) are the ones that actually need tokens.
- `bg-black/40` scrims — `Modal`, `LeftPanel`'s drawer backdrop. Fine on dark,
  worth a look for whether they should deepen.
- Step 3 territory, not Step 2: the `home-tile-asleep` / `home-lantern-lit` /
  `wisp-breathe` utilities still `color-mix(…, white)`, and Tailwind's default
  `shadow-lg` on dropdowns is near-invisible on dark.

No raw Tailwind palette classes (`bg-gray-200`, `text-red-500`, …) exist
anywhere in `src/` — the token discipline held, so the sweep really is only the
white/black list above.

Deliberately not changed: `public/manifest.webmanifest`'s `theme_color` /
`background_color`. A manifest is static and cannot follow the theme, and the
values only drive the PWA **install splash** — the live status bar is the
`<meta name="theme-color">` the controller maintains. Darkening them would
change the splash for light users too.

## Verification

- Frontend build per step.
- Screenshot pass per step (chrome-devtools harness): login, Home, host
  Overview, a VM detail, a container detail, one modal, at `sm` and desktop
  widths, in dark and light (light must be pixel-unchanged where feasible).
- Contrast: computed ratios for text/status tokens on the three dark
  surfaces recorded in UI.md § Design Language (mirror of the light-side
  notes).
- Real-device pass: the user drives the beta on a phone at night — the
  feature's actual acceptance test.
