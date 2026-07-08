# Backlog

Issues, improvements, and tech debt identified but deferred. Pick up when prioritized.

## How to use this file

Each entry has:
- a short title (used as a header)
- **Found:** date and context
- **Symptom:** what users see (or don't see, for silent bugs)
- **Root cause:** what we know
- **Fix sketch:** the rough plan, not a binding design
- **Why deferred:** the reason it isn't shipping today

When an entry grows beyond a few paragraphs — multiple options to weigh, design tradeoffs,
phased plan — graduate it to `docs/plans/<topic>.md` and replace this entry with a one-line
pointer. Keep this file scannable.

---

## Improvements

### Caddy app's default image can't use the Cloudflare token field it presents

**Found:** 2026-07-09, after confirming the user's working Caddy runs a custom image.

**Symptom:** A user creates a Caddy app (default image `caddy:latest`), fills in the Cloudflare API token field Wisp puts right in front of them, and saves. The generated Caddyfile carries `dns cloudflare {env.CLOUDFLARE_API_TOKEN}`, which the stock Caddy binary can't adapt (unknown module), so the container exits on start with nothing pointing at the image as the cause. The token field is a trap for anyone on the default image.

**Root cause:** `appRegistry.js` sets `defaultImage: 'caddy:latest'`. The official Caddy image does not include `caddy-dns/cloudflare` — Caddy's DNS providers are Go plugins that must be compiled in via `xcaddy`. Wisp's Caddy module always offered the token field regardless of image, on the unstated assumption of a Cloudflare-enabled build. (The user's own registry-fronting Caddy is a custom `xcaddy` image, which is why their config adapted fine.)

**Fix sketch:** Cheapest — help text on the token field noting it needs a Caddy build with the Cloudflare DNS module, and a line in CUSTOM-APPS.md. Better — change `defaultImage` to a Cloudflare-enabled build (e.g. a `ghcr.io/acdtrx/*` image like tiny-samba already ships, built with `xcaddy build --with github.com/caddy-dns/cloudflare`), so the token field works out of the box; keep `allowCustomImage`. Best — only emit the `dns cloudflare` block when the image is known to support it, but Wisp can't introspect a plugin set, so this collapses to "document + sane default."

**Why deferred:** Needs a decision on whether to own/publish a Caddy image vs just documenting the requirement; not blocking anyone today (only affects a fresh Caddy app on the default image that also wants DNS-01).

### Host Mgmt add/edit is inline-row only — no mobile create/edit path

**Found:** 2026-07-06, during the mobile Host Mgmt pass.

**Symptom:** On phones, Host Mgmt (SMB shares, removable drives, VLAN bridges) is read-only + mount/unmount only. Adding, editing, or deleting a mount/bridge, and adopting a detected drive, are all hidden below `sm` because they expand a table row into a multi-field inline editor that doesn't work at narrow widths.

**Root cause:** Create/edit use inline table-row editors (`editingId`/`showCreate` state swapping cells for inputs), a desktop-only interaction.

**Fix sketch:** Replace inline-row editing with a **modal editor** (reuse `Modal.jsx`; `UsbAttachModal` is the closest existing pattern) for add/edit/adopt across the three sections. A modal form works identically on desktop and mobile and would let add/edit/delete return to phones. Do it as one focused pass, not per-section.

**Why deferred:** The read-only+mount mobile view covers the common phone use case; the editor redesign is its own scoped piece.

### `DataTable` numeric `minWidthRem` never generates CSS

**Found:** 2026-07-06, during the mobile table polish.

**Symptom:** None visible — tables size by natural content width, which happens to look right.

**Root cause:** `DataTable` builds `min-w-[${n}rem]` at runtime; Tailwind's scanner never sees the literal class, so no CSS is emitted for the numeric path. Only string-literal values passed by callers (e.g. `"sm:min-w-[56rem]"`) work.

**Fix sketch:** Convert the numeric path to an inline `style={{ minWidth: … }}` (or drop the prop where content width suffices). Note this would *introduce* min-widths that never actually applied — check each table for new scrollbars before shipping.

**Why deferred:** Zero user-visible impact today; changing it silently alters accepted layouts.

### A failed app reload leaves a persisted config the container can't boot

**Found:** 2026-07-08, debugging Caddy's `APP_RELOAD_FAILED` after the Cloudflare token was re-added.

**Symptom:** None, until the next restart. `applyAppConfig` persists the new appConfig, env, mounts and mount file contents (steps 2–3) *before* asking the app to reload (step 5). When the reload fails, the error surfaces and the running container keeps serving its previous config — but the rejected config is already on disk. The container now boots into a config its own app refused. A host reboot, an autostart, or any unrelated restart turns a handled 422 into a container that won't come up. Caddy makes this sharp: it also fronts Wisp, so the failure mode is "reboot the host, lose the UI".

**Root cause:** Persist-then-validate. There is no dry-run gate and no rollback on `APP_RELOAD_FAILED` — the catch rethrows without restoring the previous appConfig, and deliberately does not set `pendingRestart` (which would invite the user to restart straight into the broken config).

**Fix sketch:** Either (a) roll back to `oldAppConfig` + previous mount contents when the reload rejects the new state, or (b) add an optional `getValidateCommand()` to the module contract and run it *before* persisting (`caddy validate --config …`, `nginx -t`, `testparm` for samba). (b) is better — it also catches the case where the container is stopped and nothing validates at all — but it needs the config file on disk first, so it wants a temp path the app can read.

**Why deferred:** Needs a design pass on the module contract, and the reload-failure path is rare now that env changes no longer attempt a doomed reload. Not a regression; this has been true since app containers shipped.

### Two version readers can disagree: `routes/host.js` `getWispVersion()` vs `wispUpdate.js` `getCurrentVersion()`

**Found:** 2026-07-06, during LAN-discovery review (discovery TXT now uses `getCurrentVersion`).

**Symptom:** None today. If root `package.json` and `backend/package.json` versions ever diverge (partial release-script change, manual bump), the Host panel (`wispVersion` from `getWispVersion`, reads `backend/package.json`) and the LAN-advertised discovery version (`getCurrentVersion`, reads install-root `package.json` with backend fallback) report different numbers.

**Root cause:** Two independent package.json readers predate discovery; discovery exported the wispUpdate one instead of adding a third.

**Fix sketch:** Make `routes/host.js` call the now-exported `getCurrentVersion()` and delete `getWispVersion()`.

**Why deferred:** No user-visible effect while release.sh bumps both files in lockstep; pure consolidation.

### `wisp-os-update upgrade` uses `apt-get upgrade -y` — packages requiring new deps stay kept-back

**Found:** 2026-05-04, during osUpdate apt-path review.

**Symptom:** After clicking Upgrade in the UI, some upgradable packages remain in the next "View packages" list. They are kept back because `apt-get upgrade` (without `dist-upgrade`/`full-upgrade`) refuses to install or remove packages to satisfy new dependencies. On stable Debian/Ubuntu this is rare; on rolling/HWE/kernel-meta updates it's common (e.g. `linux-generic` jumps to a new kernel package name).

**Root cause:** `backend/scripts/wisp-os-update` (debian branch, `upgrade` action) runs `apt-get upgrade -y`. Conservative by design but mismatches what users expect from a "Upgrade" button — they assume "apply everything" semantics.

**Fix sketch:**
1. Switch the debian `upgrade` branch to `apt-get dist-upgrade -y` (alias `full-upgrade`). Same lock-detection wrapper pattern already in place.
2. Confirm the simulated count from `apt-get -s upgrade` (used by the `check`/`list` actions) still matches what `dist-upgrade` will install — it likely won't for kernel-meta cases, so also switch the simulation to `apt-get -s dist-upgrade` for symmetry. Otherwise the count shown in the UI is "upgrade count" but the button performs "dist-upgrade".
3. Pacman path: `pacman -Syu` already does the equivalent of dist-upgrade; no change needed.
4. Doc: note the change in `docs/spec/HOST-MONITORING.md` (the OS Updates section).

**Spot test after fix:**
1. On a Debian/Ubuntu host with a kernel-meta update pending (`linux-generic` → new ABI), click Check — count should include the kept-back packages.
2. Click Upgrade — the kernel meta-package and its new kernel package should both install.
3. After upgrade, Check again — list should be empty (or only contain genuinely-blocked items like phased updates).

**Why deferred:** Behavior change with safety implications (dist-upgrade can remove packages). Wants explicit decision before flipping the default — possibly a setting or a confirmation in the UI ("show what will be removed"). Discovered while fixing concurrency/caching, scope-separated.

### SSO auto-redirect defeats logout (immediate re-login)

**Found:** 2026-07-08, while testing OIDC/SSO login against Pocket ID.

**Symptom:** With SSO enabled, clicking **Log out** bounces the user straight back into the app — they can't stay logged out. Logout clears Wisp's session and lands on `/login`, which auto-redirects to the provider; the provider still holds a live SSO session, so it silently issues a fresh code and Wisp logs the user right back in.

**Root cause:** `Login.jsx` auto-redirects to `/api/auth/oidc/login` whenever SSO is enabled and the URL has no `?sso=` marker. Logout produces exactly that state (no marker), so the happy-path auto-redirect fires. Wisp only performs a **local** logout; it does not end the provider's session, and the IdP re-authenticates without interaction.

**Fix sketch (options, not binding):**
1. Cheapest: on logout, land on `/login?sso=logout` (or set a short-lived "just logged out" flag) so the login page shows the form + SSO button instead of auto-redirecting, with a "You've been signed out" notice. Leaves the IdP session intact (next SSO login is still one tap). Stops the re-login loop without touching the provider.
2. RP-initiated logout: after local logout, redirect to the provider's `end_session_endpoint` (from discovery) with `id_token_hint` + `post_logout_redirect_uri` so the IdP session ends too. Requires stashing the ID token (currently discarded after validation) and registering a post-logout redirect URI in Pocket ID. Also signs the user out of the IdP globally, which may be unwanted if they use it for other apps.
3. Combination: option 1 by default, option 2 as an opt-in setting.

Option 1 is likely sufficient for the single-user case; option 2 is a follow-up if a true global sign-out is wanted.

**Why deferred:** Normal login works; logout-with-SSO is an edge case the user chose to defer. Option 2 touches token storage + provider config and wants a deliberate decision.
