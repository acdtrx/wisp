# Update channels: beta opt-in for pre-releases

## Goal

A host can opt into a **beta channel** from its own UI and receive pre-releases
via the normal self-update flow. Stable hosts are untouched. The operator's
cycle: land work on main → `release.sh 2.2.0-beta.1` → push tag to `github` →
beta hosts pick it up (hourly check or manual Check) → iterate betas →
`release.sh 2.2.0` → every host converges on stable.

## Scope

- `updateChannel: "stable" | "beta"` in `wisp-config.json` (default `"stable"`),
  editable via `PATCH /api/settings`, toggled from the Wisp Update card
  (Host → Software) — not from the Settings page.
- Channel-aware update checker: stable keeps `releases/latest` (GitHub excludes
  prereleases server-side); beta lists releases and picks the highest semver.
- Real semver precedence in the version comparison (prerelease < release,
  `beta.1 < beta.2`), replacing the current major.minor.patch-only compare.
- `scripts/release.sh`: prerelease versions skip the CHANGELOG retitle.
- Docs: `docs/spec/UPDATES.md`, `docs/spec/CONFIGURATION.md`, `docs/spec/API.md`
  (whichever documents the touched shapes), `CHANGELOG.md`.

## Out of scope

- Downgrades. Flipping beta → stable while running a prerelease newer than the
  latest stable offers nothing; the host waits for stable to catch up.
- Workflow changes. `.github/workflows/release.yml` already marks `v*-*` tags
  as prereleases; prerelease notes fall back to the built-in one-liner since the
  CHANGELOG section stays unreleased until the stable cut.
- `wisp-updater` changes. It swaps whatever tree is staged — no updater edit,
  so no one-release-lag concern.
- A prerelease badge in the sidebar/host header. The Software card is the one
  surface that knows about channels.

## Constraints and decisions (settled 2026-08-25)

- **No semver library** (CODING-RULES §3): extend the existing `compareSemver`
  in `wispUpdate.js` with prerelease precedence per the semver spec — numeric
  identifiers compare numerically, alphanumeric lexically, numeric < alphanumeric,
  prerelease < release, prefix-equal shorter list < longer.
- **Channel is read at check time** from settings (`wispUpdate.js` is app glue;
  importing `settings.js` is fine). No push/subscription from settings to the
  checker: the UI PATCHes the channel and then POSTs `/api/updates/check`
  (mechanism/trigger decoupling — the manual trigger already exists).
- **Beta listing**: `GET /repos/<repo>/releases?per_page=15`, filter out drafts,
  pick the release with the highest semver tag among the rest (prereleases
  included). Everything downstream (notes, publishedAt, asset discovery,
  `available` computation) is shared with the stable path.
- **`/api/updates/status` shape unchanged.** The card reads the configured
  channel from the settings store; status doesn't need to echo it.
- **UI control**: a compact "Channel: Stable/Beta" select inside the Wisp Update
  card. No confirm dialog — flipping the channel installs nothing by itself.
- **`release.sh` prerelease behavior**: skip the retitle so the topmost dated
  CHANGELOG section stays unreleased and the eventual stable release folds the
  whole batch. Version bumps + commit + tag behave exactly as today.

## Steps

Branch `feature/update-channels` in a worktree under `.claude/worktrees/`;
each step commits before the next starts.

1. **Backend** — semver precedence in `compareSemver`; channel-aware
   `checkForUpdate`; `updateChannel` through `settings.js`
   (DEFAULTS / read-normalize / `buildUpdatedSettings` / `persistSettings` /
   `getSettings`) and the `routes/settings.js` schemas (body enum + response).
   Spec updates: UPDATES.md (channel section), CONFIGURATION.md (schema row),
   API.md if it documents the settings shape.
   - Accept: dev backend boots; `PATCH /api/settings {updateChannel:"beta"}`
     persists and survives normalize; `POST /api/updates/check` works on both
     channels against the real repo; comparator verified against a case table
     (see Verification).
2. **Frontend** — channel select in `WispUpdateSection` (settings store +
   `PATCH /api/settings`, then an immediate check); spec update if UI.md
   documents the Software card.
   - Accept: `npm run build` passes; toggle drives PATCH + check in the dev
     stack and the choice survives reload.
3. **Release script** — prerelease versions skip the CHANGELOG retitle in
   `scripts/release.sh`; UPDATES.md release-flow wording.
   - Accept: dry-run exercise on a scratch git repo (or careful local run +
     reset) shows: beta leaves CHANGELOG untouched, stable retitle still works,
     stable-after-beta no longer throws.
4. **CHANGELOG + final verification** — changelog entry, full build, drive the
   toggle end-to-end locally.

## Verification

- Frontend build passes.
- Comparator case table (run via `node -e` against the exported function):
  `2.2.0-beta.1 < 2.2.0`, `2.2.0-beta.1 < 2.2.0-beta.2`, `2.2.0-beta.2 <
  2.2.0-rc.1` (lexical), `2.2.0 < 2.2.1-beta.1`, `2.1.1 = 2.1.1`.
- macOS dev stack: flip the channel in the Software card → PATCH persists to
  `config/wisp-config.json`, an immediate check fires, card shows the channel.
  With no prereleases published, beta must behave identically to stable
  (latest = v2.1.1, `available=false`) — that is the no-regression check.
- **Deferred to the next release cycle** (needs the Linux hosts + a real tag):
  cut `vX.Y.Z-beta.1`, confirm a beta host offers + installs it, a stable host
  ignores it, and the later stable release converges both.
