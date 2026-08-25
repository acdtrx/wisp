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

No raw Tailwind palette classes (`bg-gray-200`, `text-red-500`, …) exist
anywhere in `src/` — the token discipline held, so the sweep really was only the
white/black list Step 2 cleared.

Deliberately not changed: `public/manifest.webmanifest`'s `theme_color` /
`background_color`. A manifest is static and cannot follow the theme, and the
values only drive the PWA **install splash** — the live status bar is the
`<meta name="theme-color">` the controller maintains. Darkening them would
change the splash for light users too.

### Step 2 — Sweep ✅ (2026-08-25)

Every remaining light-spot outside the Home glow is gone. What changed, by kind:

- **`bg-white` → tokens**, chosen by what the element means. Input-like controls
  (`ManualLinkModal`'s icon picker trigger, `ContainerDevicesSection`'s GPU
  select, `ImageLibrary`'s rename field, `JellyfinAppSection`'s four fields) took
  `bg-surface-input`; panels and lifts back out of a wash (the GPU row —
  matching its sibling picker row — `OsUpdateSection`'s "Restart now" inside the
  warning notice, `CreateVMPanel`'s `bg-white/50` detail `<pre>`) took
  `bg-surface-card`. Light is identical: both tokens are `#ffffff` there.
- **`text-white`** — the Step 1 audit's three "on card/surface" flags
  (`DataTableChrome`, `SectionCard`, `FormModalChrome`) were false positives:
  all three sit on `bg-accent`, so they stay, as does every other accent fill.
  The real one the audit missed is `ConfirmDialog`'s **danger** button on
  `bg-status-stopped` — that token lifts to a bright coral in dark, where white
  drops to 2.9:1. It takes `dark:text-surface` (6.1:1).
- **Scrims** — `Modal` and `LeftPanel`'s drawer backdrop gain `dark:bg-black/60`.
  40% over an already-dark canvas barely separates the dialog from the page.
- **Shadows** — this uncovered a Step 1 bug: Tailwind v4 **inlines** a
  `--shadow-*` `@theme` key into the generated utility, so `.shadow-card` carried
  the light value literally and Step 1's dark `--shadow-card` override was dead
  code. Both shadows moved out of `@theme` onto plain `:root` and are read back
  through `@utility shadow-card` / `@utility shadow-popover`; the dark values now
  actually land. `--shadow-popover` is new — its light value is byte-identical to
  Tailwind's `shadow-lg` (verified: computed `box-shadow` matches), and the six
  floating elements (`Modal` + five dropdowns) moved onto it.
- **Consoles** — `--color-console` / `--color-console-text`, dark in both themes,
  read by `consoleTheme()` so the `bg-console` viewport class and the xterm
  palette share one source. The container terminal repaints live on a theme flip
  via `terminal.options.theme` (@xterm/xterm 6). noVNC's letterbox is recoloured
  by a dark-only `!important` rule on `[data-wisp-vnc-viewport] > div` — its
  screen element is inline-styled and classless. Details in `spec/CONSOLE.md`.
- **Also found in the audit**: `WispUpdateSection`'s release notes render through
  `@tailwindcss/typography`, whose baked greys (near-black bold, pale bullets and
  rules) are not tokens — it gains `dark:prose-invert`. And `color-scheme` is now
  declared (`light` on `:root`, `dark` under the attribute) so native `<select>`
  popups, scrollbars, the time picker and autofill follow the app's theme; that
  also covers the "styled scrollbars" item with nothing hand-rolled.

Deliberately left as they are:

- **`Toggle`'s knob stays `bg-white`** in both themes. It sits on a solid track
  and holds 3.13:1 on the accent (on) and 10.4:1 on `surface-border` (off) —
  a switch handle is supposed to be the bright part. Verified on the App Config
  toggles at both widths.
- **Native checkbox tint** stays the browser default (blue) in both themes.
  Setting `accent-color` to the brand teal would change light too, and a
  theme-only override would leave the two themes disagreeing.
- **`BackgroundJobsIndicator`'s progress bar** keeps its brand-cyan gradient and
  its 6%-black inset shadow. Both read correctly on spruce; neither is a light
  spot. Same for `WispGlyph`'s cyan gradient stop.

**Verified** — build passes. Dev stack at 1440px and 375px in **dark**: login,
Home, Overview, Host Mgmt, Software (incl. Image Library), Backups, App Config,
Create VM, Create Container, plus a `Modal`, a `ConfirmDialog` and a dropdown;
every screenshot reviewed, no remaining light surface, no unreadable text, and
the dropdown now visibly floats. Drawer scrim checked at 640px (at 375px the
drawer is full-width and no scrim shows). Same walk in **light** confirmed
unchanged, and the equivalences were checked numerically in the page rather than
by eye: `shadow-popover` resolves to Tailwind's `shadow-lg` values exactly,
`shadow-card` to `rgba(0,0,0,.08) 0 1px 3px`, `bg-surface-input` /
`bg-surface-card` to `rgb(255,255,255)`, `bg-console` to `rgb(30,41,59)`.

**Consoles could not run** — macOS stubs have no libvirt/containerd, so no real
VM or container exists to attach to. Verified instead through a temporary Vite
harness (since removed) mounting a real `Terminal` with `consoleTheme()`: light
resolved `#1e293b`/`#e2e8f0` — today's exact values — dark resolved
`#0b1a18`/`#e8f2ef`, and cycling the theme repainted the **same** terminal
instance without a remount. The noVNC rule was proven by probing a stand-in
`[data-wisp-vnc-viewport] > div` carrying noVNC's inline `rgb(40,40,40)`: light
keeps it, dark computes `rgb(11,26,24)`. What still needs the Linux server: the
consoles attached to a live session (font rendering, real ANSI output, the
framebuffer letterbox at a non-fitting resolution).

### Step 3 — Dusk glow pass ✅ (2026-08-25)

The Lanterns look is now theme-aware rather than light-only. Mechanism: every
Lanterns value moved from literals inside the `home-*` utilities onto `--wisp-*`
variables on `:root`, overridden under `:root[data-theme='dark']`. That is what
lets the **`wisp-breathe` keyframes** be theme-aware at all — keyframes are
global, so the alternative was a second animation name plus a `dark:` class swap
in `HomeTile`. The light values are the byte-identical expressions that were
there before.

What the dark side does, and why (the full table is in
[`docs/spec/UI.md`](../spec/UI.md) § Home → Home in the dark theme): the wash
becomes the **accent itself** at 15→9→4% over the spruce rather than
`accent-soft`, which on dark is *darker* than the canvas and would dim the
corner instead of lighting it — four stops, because a two-stop ramp that wide
bands visibly on a near-black surface. Asleep tiles sink toward the canvas
instead of lifting toward white. The lit well is the accent mixed *into the
card* (42% centre → 13% edge) with a stronger ring and a wider glow, and the
breathe swings 18px@34% ↔ 30px@55%. Motes brighten to 85% / 78%.

Beyond Home, two named utilities carry the same language: **`wisp-lit-glyph`**
(a static `drop-shadow` halo on the running workload's icon in the sidebar rows
and the VM/container detail header — `drop-shadow`, not `box-shadow`, so it
follows the strokes and not the hover-tinted button box) and **`wisp-brand-glow`**
(the `WispGlyph` in the top bar and on the login card). Both dark-only.

Two atmospheric extras, both dark-only, both derived: the brand-glyph glow above,
and **`login-dusk`** — the login page borrows Home's wash, because it is the only
other full-page canvas and a flat near-black field with one card on it is exactly
the generic dark mode this theme exists to avoid.

**Verified.** Build passes. macOS stubs report zero workloads, so lit/asleep
lanterns, running sidebar rows and the detail headers were driven in a temporary
Vite harness (since removed) seeding `homeStore` / `vmStore` / `containerStore`
and mounting the **real** `HomePanel`, `VMListItem`, `ContainerListItem`,
`OverviewPanel` and `ContainerOverviewPanel`. Reviewed at 1440px and 375px across
three rounds: the canvas ambient layer was screenshot with the tile content
hidden to check the wash for banding (none) and to judge the motes on their own —
round 1 had them invisible, so they went from 70%→85% / 62%→78%; the lit well's
fill went 32%→42% after an A/B, because at 32% the ring did all the work and the
glass read unlit. Sidebar halos were checked at 1x and at 3x zoom: running rows
glow, stopped and paused rows do not. The real dev app confirmed the top-bar
glyph, the login wash, and Home's canvas at both widths with three throwaway
manual tiles (since deleted).

**Light is unchanged, proven numerically** rather than by eye: elements carrying
the new utilities were compared against elements carrying the *old literal CSS*
in the same page — `home-canvas`, `home-tile-asleep`, both mote tints and
`home-lantern-lit` (fill *and* box-shadow) all compute byte-identical, and both
glow utilities resolve to `filter: none`. The keyframes were sampled at 0% and
50% in both themes (light 14.3px@.25 ↔ 23.7px@.41 — today's values). Light Home,
sidebar and login re-shot and unchanged.

**Contrast** re-checked for the three new derived backgrounds; the table is in
UI.md § Design Language. Floor is `text-muted` at 5.47:1 on the asleep tile;
the canvas wash's 4.63:1 is a worst case at the gradient centre, which sits
*above* the canvas (the counts line actually sits at ~1% wash, ≈5.7:1).

**Still needs the Linux server**: lanterns lit by *derived* tiles (Caddy hosts,
app URLs, mDNS) rather than harness state, and the halos on a real running
workload's row and detail header.

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

## Status

Implemented 2026-08-25 (steps 1–4). Foundation, sweep, and glow pass each
verified in the dev stack and harnesses with per-page screenshot review in
both themes at desktop and 375 px; light mode proven numerically unchanged;
contrast ratios computed and recorded in UI.md § Design Language. Shipping in
`v2.3.0-beta.2`. Still needs the Linux server: consoles attached to live
sessions, derived (non-manual) Home tiles lit by real workloads, and the
running halos on live workload rows — the user's nighttime phone pass is the
acceptance test.
