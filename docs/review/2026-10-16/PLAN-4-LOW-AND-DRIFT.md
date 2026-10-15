# Fix Plan 4 — Low items, ops finding, doc and rule drift

**Audit:** [`AUDIT.md`](AUDIT.md). **Created:** 2026-10-16. Conventions: see
[`PLAN-1-SECURITY.md`](PLAN-1-SECURITY.md) § Shared conventions. Bundles are grouped by area so
each is one subagent; within a bundle, confirm each item before fixing and drop any that don't
reproduce (record why).

---

## L1 — mDNS forwarder and `wisp.local` (ops finding O1)

**Findings:** O1, C14. **Decision needed:** no, but **prove first**.

1. **Prove the mechanism** (needs the user's ok to ssh, read-only): `journalctl -u avahi-daemon -u wisp --utc`
   around 2026-10-13 14:08, 2026-10-14 09:47 and 17:29; look for "Withdrawing address record",
   "Registering new address", host name conflicts, `[mdnsForwarder]` warnings; `avahi-resolve -n wisp.local`
   timing. Record the finding here before designing anything.
2. **Likely fix (only if step 1 supports it):** the forwarder answers the host's own
   `<hostname>.local` from the host's current addresses (fast path, like `lookupLocalEntry`),
   and never returns link-local (`fe80::/10`, `169.254/16`) addresses to containers.
3. C14: relay TCP queries over TCP; `connect()` the upstream UDP socket.

**Acceptance:** a resolution loop for `wisp.local` from inside a container shows zero failures
across an event that previously caused a burst (whatever step 1 identifies); canapana's log
stops showing the error.
**Verify:** Linux server. **Docs:** `DISCOVERY.md` / `CONTAINERS.md` DNS section; fix stale
`DEPLOYMENT.md:115` here too.

---

## L2 — HTTP / auth low

**Findings:** A5, A6, A7, A8, C17.
- A5: settings mount schema `hasPassword` (share the schema with `routes/mounts.js`).
- A6: per-IP rate limit on `/oidc/login` (reuse `loginRateLimit`) or evict oldest pending.
- A7: build `redirect_uri` from the configured advertised URL, not `Host`.
- A8: `setErrorHandler` mapping Fastify validation errors to `{error, detail}` (ERROR-HANDLING.md).
- C17: restore the 422 for flat `env` from external callers; give `applyAppConfig` its own path.
**Verify:** darwin. **Docs:** `ERROR-HANDLING.md`, `AUTH.md`, `API.md`.

## L3 — Frontend low

**Findings:** F4–F10 (+ AUTH `sso=disabled` notice).
- F4 logout → `/login?sso=signedout` + notice; add `disabled` notice.
- F5 Modal closes only when mousedown and click both target the backdrop.
- F6 empty value for a stored secret = keep.
- F7 navigate on create completion only if still on the create panel.
- F8 `userDisconnectedRef` respected by auto-resume.
- F9 SMB test sends `id` + overrides when the password field is empty.
- F10 reschedule prune while finished rows remain.
**Verify:** darwin dev stack / harness. **Docs:** `UI.md`, `CONSOLE.md`, `UI-PATTERNS.md` (Modal behavior).

## L4 — VM manager low

**Findings:** V12, V16, V18 (decision), libvirtConstants naming.
- V12 `parseTagValue: false` on the shared parser — check every consumer that relied on
  numeric coercion (memory, vcpu, ports) and convert explicitly.
- V16 key `prevVMStats` consistently.
- V18 **(ask):** back up swtpm state via a helper (privileged path, install-helpers + sudoers)
  or document the gap in `BACKUPS.md`. Recommended: document now, backlog the helper with
  trigger "a restored Windows VM needed BitLocker recovery".
- Rename `VIR_DOMAIN_STATE_SHUTDOWN = 0` to NOSTATE and fix the 0/4/5 offline-state mismatch.
- Unconfirmed items from AUDIT (live-snapshot overlays, snapshot metadata after restore, `.mem`
  collisions): confirm on Linux; fix or backlog each.
**Verify:** Linux server.

## L5 — Containers low

**Findings:** C5, C6, C7, C8, C11 (decision), C13, C15, C16, C18, `isKnownApp`.
- C5 `publishContainer` requires `localDns` and running.
- C6 per-container promise chain in the reconciler.
- C7 re-read + merge start-owned fields before each config write (or per-container config lock —
  may also cover the unconfirmed lifecycle-lock item).
- C8 resolve + re-check storage mount sources immediately before task create; spec gets the
  resolved path; escape check before `mkdir`.
- C11 **(ask):** ship the standard default seccomp profile now, or backlog with trigger
  "running untrusted images". Recommended: ship it — but it can break images that need
  unusual syscalls, so verify the current fleet (caddy, zot, tiny-samba, the user's containers).
- C13 Docker's registry rule; delete images by the exact listed name.
- C15 tail-read logs.
- C16 publish services after task start, deregister on failure.
- C18 export `runScheduledBackups`; break `managedBridges.js` → app-glue import.
- `isKnownApp` → `Object.hasOwn`.
- `createAppContainer` returns nothing → container job store `formatResult` throws → spurious "Background job failed" after `done` (found on tini 2026-10-16). Also VM/container create managers emit their own `done` before the job completes (R3 note).
**Verify:** Linux server.

## L6 — Install / updater / host monitoring low

**Findings:** P5, P6, P9, P10, P13, P14, P15, and unconfirmed `container-dns.sh` EEXIST race.
- P5 `backupStatus.js` path → `../../../config/…` (stale `backend/config/backup-status.json`
  on installs: one `rm`, state it in CHANGELOG).
- P6 drop the br0 guard in `container-dns.sh` (stub lives on `wisp-dns0`) or re-run after `bridge.sh`.
- P9 rollback re-runs the old tree's `common-steps.sh` + re-templates `wisp.service`, or
  document tree-only rollback in UPDATES.md (ask if the former turns out large).
- P10 `chown` to `stat -c %U:%G "$INSTALL_DIR"`.
- P13 count only physical uplinks (or default-route interface); update HOST-MONITORING.md.
- P14 `bavail`.
- P15 `smartctl -n standby`; UI shows "sleeping".
- `container-dns.sh`: `ip addr replace`, tolerate existing link.
**Verify:** Linux server; P6 on a fresh install VM if available. **Docs:** `UPDATES.md`,
`DEPLOYMENT.md`, `HOST-MONITORING.md`, `BACKUPS.md`.

## L7 — Docs, rule drift, dead code

- Every doc-drift item in AUDIT Part 5 not already fixed by an earlier bundle.
- **Shell-exec allowlist (ask):** add `unzip`, `mkfifo`, `ip netns` (fallback), `bash`
  (`smart.js`) to CLAUDE.md, or remove the usages. Recommended: add `unzip`/`mkfifo`/`ip netns`
  (all predate the allowlist, small and justified), and remove the `bash -c` wrapper in
  `smart.js` if it isn't needed.
- Remove dead code: bundled-script fallbacks to `lib/scripts/`, unreferenced `wisp-apt`,
  `scripts/migrate-app-containers.sh`.
- Extend `check-imports.mjs` to flag `resolve(__dirname, '<relative>')` targets that don't exist
  (would have caught P5 and the dead fallbacks) — only if it stays small; otherwise backlog.
- `UPDATES.md` privilege model: describe the real boundary.
**Verify:** `check-imports`, frontend build, docs read-through.

---

## Phase 4 exit / release

All bundles merged and verified; AUDIT.md gets a remediation-status block (as in 2026-07-05)
listing every ID as fixed / backlogged (with trigger) / dropped (with reason). Then the user
cuts the release via `scripts/release.sh`.
