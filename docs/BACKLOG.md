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
