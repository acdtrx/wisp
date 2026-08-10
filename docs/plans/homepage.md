# Home page — launcher for the services hosted on Wisp

**Shipped in v2.1.0** (2026-08-11), plus follow-ups: edit-mode dialog fixes,
click-the-icon-to-change, the Wisp glyph in the icon catalog, and the top-bar
brand as a Home button.

Design exploration and decisions: 2026-08-10 session. Visual reference (mockups
in the real shell, "Lanterns" direction chosen): Claude artifact
`https://claude.ai/code/artifact/b5bfd239-65f3-41d2-a621-fb7eb16f0176`.

## Goal

A "Home" landing page — homelab-homepage-style launcher tiles for the services
running on this Wisp, derived from data Wisp already holds. Zero-config first
render; sparse user overlay for the human touches. The wow is the point: the
"Lanterns" design, not a utilitarian grid.

## Placement

- New first tab **Home** in the host panel (`HostPanel` `TABS`), before
  Overview → route `/host/home`.
- `/` and the catch-all redirect to `/host/home` instead of `/host/overview`.
- No host-vitals strip on the page — the top bar's `HostStatsBar` already
  carries it.

## Tile derivation (descending priority, deduped by URL)

1. **App-module hook** — new optional method on the container-app module
   interface: `getPublishedLinks(appConfig)` → `[{ url, target?, label? }]`.
   - `caddy-reverse-proxy`: one link per `hosts[]` entry →
     `https://<subdomain>.<domain>`, target carried for the workload join.
   - `jellyfin`: `publishedUrl`. `zot-registry`: `externalUrl`.
   - `tiny-samba`: none.
   - Iterate **all** containers with `metadata.app` — never a hardcoded
     container name; zero/one/many Caddy instances all work. Same-URL
     collisions: prefer the link whose backing container runs; surface the
     conflict in edit mode.
2. **Declared mDNS services** of type `_http._tcp` / `_https._tcp` →
   `http(s)://<name>.local:<port>`.
3. **Manual tiles** — user-added `{ name, url, iconId }`.

Each derived link joins back to its workload by matching the target/mDNS
hostname (container `mdnsHostname`, VM `guestHostname`/`mdnsName`) — that
powers live state on the tile. Links with no matching workload (e.g. a Caddy
host proxying to another machine) render as stateless external tiles.

**Workloads without a published URL get no tile** (decided) — Home is links
only; the sidebar covers workloads.

## Backend

- Extract the aggregate join that `backend/src/lib/mcp/tools/overviewTools.js`
  builds into a shared lib module; the MCP `get_deployment_overview` tool
  becomes a thin caller. One join, two consumers — no drift.
- New `home` SSE topic pushing `{ tiles, groups }`: the aggregate + derived
  links + overlay, recomputed on container/VM/config change events (no
  polling). Late subscribers get the cached last frame like every topic.
- Homepage config: new `homepage` key in `wisp-config.json`, managed by a
  dedicated `lib/homepage.js` + `routes/homepage.js` cloning the **sections**
  pattern (`withSettingsWriteLock`, commit → change event → SSE), never via
  `PATCH /api/settings`.

## Config schema (`homepage` key)

```jsonc
{
  "groups": [{ "id": "…", "name": "Every day", "tiles": ["<tile-id>", …] }], // order = array order
  "overrides": { "<tile-id>": { "hidden": true, "name": "…", "iconId": "…" } },
  "manualTiles": [{ "id": "…", "name": "…", "url": "…", "iconId": "…" }]
}
```

Derived tile id = its URL. Accepted wart: renaming a Caddy subdomain resets
that tile's overrides. New derived tiles **auto-appear in an "Ungrouped"
section** (decided) until filed or hidden.

## UI — the Lanterns design (see artifact for exact look)

- Header: time-of-day greeting ("Good evening.") + counts line
  ("5 lanterns lit · 4 asleep · kora lives elsewhere on the network")
  + "Edit home" button (decided: greeting + counts).
- Groups as labeled grids (`repeat(auto-fill, minmax(236px, 1fr))`).
- Tile: icon well + name + hostname; status = **lit lantern** (radial teal
  glow behind the icon, slow 4s breathing animation) vs unlit ("asleep" chip,
  muted card); amber dot for `updateAvailable`; external tiles get a distinct
  icon-well tint and no state.
- Right edge = one action lane, both always visible:
  - **Launch notch**: 26px tab sitting in the top border, centered on the
    cogwheel's axis (gear 28px wide ending at the 14px padding → axis 28px
    from the right edge → notch at `right: 15px`); fills accent on hover.
    Whole tile also opens the URL (new tab).
  - **Cogwheel** below it, vertically centered: navigates to the workload's
    Wisp page. Clicking a *stopped* tile's body also goes to the workload
    page (wake-on-click is out of scope for v1).
- Ambient: 3–4 drifting blurred teal wisp motes on the canvas; breathing and
  motes disabled under `prefers-reduced-motion`.
- Icons: existing `iconId` catalog (`vmIcons.jsx`) + per-tile override via the
  existing `IconPickerModal`.
- **Edit mode: inline** (decided) — "Edit home" toggles in-place controls:
  hide, rename, icon, move-to-group, reorder, add group, add manual link.
  Interaction style follows the sidebar's Organize mode.
- Frontend data: a `homeStore` subscribing to the `home` topic via
  `subscribeTopic`, same shape as `sectionsStore`.

## Out of scope (v1)

- Widgets / read-only app tokens (HA summaries etc.) — v2; needs the
  per-tile server-side token design.
- Wake-on-click for stopped services.
- Attention strip; per-tile backup age / disk usage / CPU-RAM.
- Peer-instance tiles (the header's instance switcher covers reaching them).
- Dark mode — the "Dusk" mockup direction is the reference when it happens
  (see backlog idea).

## Docs to update when implementing

`docs/spec/UI.md` (routes, left-panel/host tabs, new Home section, icon
system), `docs/spec/API.md` (`home` topic + homepage routes),
`docs/spec/CONFIGURATION.md` (+ `docs/spec/SETTINGS.md` if touched) for the
`homepage` key, `docs/spec/CUSTOM-APPS.md` (module interface gains
`getPublishedLinks`), `CHANGELOG.md`.

## Verification

- Frontend build passes; `npm run check-imports` after the backend lib
  extraction.
- macOS dev stack: page shell, tabs, redirect, edit mode, config persistence
  (stub managers provide workloads; derivation paths that need real
  appConfig/mDNS verify on the Linux server).
- Linux server: derived tiles match the live Caddy `hosts[]`; state dots track
  start/stop live over SSE; MCP `get_deployment_overview` output unchanged
  after the extraction.
