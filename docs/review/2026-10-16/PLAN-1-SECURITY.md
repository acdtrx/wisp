# Fix Plan 1 — Security

**Audit:** [`AUDIT.md`](AUDIT.md) (finding IDs cross-ref it). **Created:** 2026-10-16.
**Goal:** close every finding that lets someone act without Wisp auth, escape a path, or read
secrets. Release-blocking for the next version.

Plans 2–4 cover the rest and exclude anything here.

## Shared conventions (all four plans)

- **Execution:** each bundle is one Opus subagent in a worktree under `.claude/worktrees/`
  (one branch per plan phase, commit per bundle). The main session writes the brief, reviews
  against the acceptance criteria, merges `--ff-only` at the end of the phase.
- **Anchor:** before Plan 1 begins, `git tag -a anchor/audit-2026-10-16 main`.
- **Read first:** `CLAUDE.md`, `docs/CODING-RULES.md`, the area spec, the AUDIT entry.
  `docs/UI-PATTERNS.md` for UI bundles.
- **Re-confirm "code"-verified findings** before fixing (CLAUDE.md § Debugging) — if a finding
  doesn't reproduce as described, stop and report rather than fix something else.
- **Same-edit docs:** each bundle updates its spec(s); `CHANGELOG.md` gets one terse line per
  bundle under a new dated section (Bug Fixes / New Features).
- **No migrations:** where existing on-disk/libvirt state is wrong, state the one-time manual
  cleanup in the bundle's notes and the CHANGELOG line instead of encoding it.
- **Verification environments:** darwin dev stack verifies auth, routes, frontend, settings;
  manager paths (libvirt, containerd, helpers, avahi) verify on the Linux server — requires the
  user's go-ahead for ssh, batched at the end of each phase.
- **Decision needed: yes** → stop and ask; do not pick.

---

## S1 — Auth gate on the matched route, not the raw URL

**Findings:** A1 (Critical). **Decision needed:** no.

**Files:** `backend/src/lib/auth.js` (`createAuthHook`, `handleBearerAuth`), `docs/spec/AUTH.md`.

**Fix:**
- Decide "needs auth" from `request.routeOptions.url` (the registered pattern) when a route
  matched; fall back to `request.url` only for unmatched requests (404 path).
- Apply the same to the bearer branch's `/ws` and `/api/auth` checks.
- Consider normalising once: a small `routePath(request)` helper used by every prefix check
  in the hook so the two can't drift again.

**Acceptance:**
- Unauthenticated `GET /%61pi/vms`, `/%61pi/settings`, `/%61pi/auth/tokens`,
  `/%61%70%69/vms` → 401; `POST /%61pi/containers/x/stop` → 401/403 without side effects.
- WS upgrade to `/%77s/container-console/<x>` without session → rejected; with a bearer token → rejected.
- Normal login, SPA assets, `/mcp` bearer, public routes (login, auth status, OIDC) unchanged.
- Probe a few more encodings (`%2F`, double-encoding `%2561`, trailing `%00`) — all 401/404.

**Verify:** darwin dev stack with curl (no session cookie, then with). Drive the UI login + a VM/container page.
**Docs:** `AUTH.md:68` rewrite the percent-encoding statement to describe the actual guarantee.

---

## S2 — VNC listens on localhost

**Findings:** V1 (High). **Decision needed:** no.

**Files:** `vmManager/linux/vmManagerCreate.js:224`, `vmManager/linux/vmManagerConfig.js:245`.

**Fix:** `'@_listen': '127.0.0.1'` in both. Check whether any other path writes `<graphics>`
(grep `@_listen`, `graphics`), including templates and restore-as-new.

**Acceptance:** newly created VM and a VM after a graphics-type edit show
`<graphics … listen='127.0.0.1'>` in `virsh dumpxml`; `ss -ltn` shows 59xx bound to 127.0.0.1;
Wisp's in-app console still works.

**Manual cleanup (CHANGELOG + notes):** existing VMs keep `0.0.0.0` until re-saved — re-apply
the Graphics setting in the UI, or `virsh edit <vm>` and set `listen='127.0.0.1'`; takes
effect on next VM start.

**Verify:** Linux server.

---

## S3 — Name and timestamp validation: no dot-only or dot-leading names

**Findings:** V2 (High), A2 (Medium), AUDIT U1. **Decision needed:** no.

**Files:** `backend/src/lib/validation.js`, `vmManager/linux/vmManagerValidation.js`,
`routes/backups.js` (`TIMESTAMP_REGEX`, `assertSafeTimestamp`), `vmManager/linux/vmManagerBackup.js`
(`deleteBackup`), the container-backup delete equivalent.

**Fix:**
- VM names: require a leading alphanumeric (mirror `CONTAINER_NAME_REGEX`); reject names whose
  trimmed form differs from the input (no silent trim).
- Timestamps: require a leading alphanumeric; `.` and `..` impossible.
- Both delete functions: refuse when the resolved target equals the destination root (or the
  `vms`/`containers` sub-root) — defense in depth independent of the regex.
- Grep other `:name`/`timestamp`/`snapshot` validators for the same `includes('..')` pattern.

**Acceptance:** `.`, `..`, `.foo`, `"web "` rejected with 422 at create/clone/rename/backup
delete; `DELETE /api/backups {vmName:'.', timestamp:'..'}` → 422 and nothing deleted;
existing valid names unaffected.

**Verify:** darwin (validators + route 422s via curl); Linux for one real backup delete.
**Docs:** `VM-MANAGEMENT.md` name rules; fix the `routes/backups.js:36-39` comment.

---

## S4 — Secret exposure

**Findings:** A3, V13, C9. **Decision needed: yes (A3)** — see below.

**A3 fix options (ask):**
1. Refuse `GET …/mounts/:mountName/content` for **app-managed** file mounts for token callers
   only (UI keeps working, it edits via appConfig anyway).
2. Refuse it for app-managed mounts for **all** callers (simplest, no special cases) —
   **recommended**, provided the UI never reads those mounts' content (confirm by grep).
3. Require admin scope for the whole route.

**V13 fix:** `cloud-init.json` written `0o600`; `mkdtemp(…)` under a private dir with `0o700`;
restored `cloud-init.iso` `chmod 0o600` (match L2).

**C9 fix:** run restored `container.json` through `validateAndNormalizeMounts` and
`validateAndNormalizeDevices`; re-apply the `renderD*` pattern for `gpu` devices at start;
`deleteMountBackingStore` refuses names that fail mount-name validation.

**Acceptance:** read token gets 403/404 on secret mounts (per option); MCP `get_container`
masking unchanged; restoring a tampered archive (`devices:[{type:'gpu',device:'/dev/mem'}]`,
mount `../..`) is rejected with a clear error; file modes verified with `stat`.

**Verify:** darwin for A3 route behavior; Linux for V13 modes and C9 restore.
**Docs:** `MCP.md` / `API.md` for A3; `BACKUPS.md` restore validation note.

---

## S5 — Privileged helper argument hardening

**Findings:** P7 (M3 regression-to-partial), P8. **Decision needed:** no.

**Files:** `backend/scripts/wisp-cni`, `backend/scripts/wisp-mount`, callers in
`containerManager/linux/containerManagerNetwork.js`, `storage/linux/smbMount.js`.

**Fix:**
- `wisp-cni`: hardcode `CNI_PATH=/opt/cni/bin` in the helper; ignore/require-equal arg 6
  (keep the arg count stable or update the caller in the same commit). Constrain the conf
  file path to Wisp's runtime dir.
- `wisp-mount`: apply `assert_mount_path_under_wisp` (realpath-based) to `unmount`,
  `unmount-lazy`, `rmdir`; re-check realpath immediately before `mount` and refuse symlinked
  components.

**Acceptance:** `sudo -n wisp-cni ADD bridge x /x <conf> /tmp/evil` refuses; `wisp-mount unmount /home`
refuses; normal container start/stop and SMB mount/unmount work.

**Verify:** Linux server (helpers re-installed via `install-helpers.sh`; confirm the updater
path re-installs them — UPDATES.md contract).
**Docs:** `DEPLOYMENT.md` helper checklist entries; note in AUDIT that M3 is now complete.

---

## Phase 1 exit

- All five bundles merged; frontend build + `check-imports` pass.
- darwin probes for S1/S3/S4 recorded in this file; Linux checks for S2/S3/S4/S5 recorded.
- Optional: the user may choose to cut a patch release here (releases are user-initiated).

---

## Results (2026-10-16)

Branch `fix/audit-phase1` (S1–S5 cherry-picked, no conflicts). `check-imports` OK, frontend build OK.
Deployed to the test server (tini) through the real self-update path (`wisp-updater`: snapshot →
swap → install-deps → common-setup (helpers re-installed) → install-unit → start) — clean.

| Bundle | darwin (agent) | Linux (tini) |
|---|---|---|
| S1 auth gate | encoded `/api` + `/ws` variants 401/404; session, bearer, `/mcp`, WS controls unchanged; prod SPA shell served | `/%61pi/vms`, `/%61pi/settings`, `/%61pi/auth/tokens`, `/%61%70%69/vms`, POST `/%61pi/containers/caddo/start` → 401; WS `/ws/…`, `/%77s/…` without session → 401; `/` → 200 |
| S2 VNC localhost | create + edit XML probes emit `listen='127.0.0.1'` | pre-fix `dubi` (`0.0.0.0`): SPICE→VNC edit rewrote both `listen` and `<listen address>` to 127.0.0.1; started → `127.0.0.1:5900` only; console WS → 101 |
| S3 validation | validators, route 422s, delete guards on a scratch tree | real `gubi` backup; DELETE `{gubi,'..'}`, `{'.','..'}`, `{gubi,'.'}` → 422, backup roots unchanged; real delete removed exactly one backup |
| S4 secrets | unit guards, tampered-archive restore, file modes | A3: caddy app container `Caddyfile` → 422 for read token, session GET, session PUT; generic `caddo` `Caddyfile` → 200. V13: restore-as-new of `gubi` (0644 source) → `cloud-init.{iso,json}` 600. C9: tampered `/dev/mem` device and `../..` mount → 422, no leftovers; clean restore + start OK |
| S5 helpers | refusals + function harness | installed copies match repo; `wisp-cni` foreign bin dir / foreign-owned conf refused, own conf reaches plugin; `wisp-mount unmount /home`, `unmount-lazy /`, rmdir traversal to `/tmp/…` → 64; symlink under `/mnt/wisp` → "not mounted"/64; container start/stop via new `wisp-cni` OK |

Test artifacts on tini (gubi backup, `gubi-r`, `capptest`, read token, tampered backups, `caddo-r`) removed.
