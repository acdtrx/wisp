# Wisp Fix Plan 3 — Low / Info / state-sync Low

**Audit source:** `docs/review/2026-04-28/AUDIT.md`
**Created:** 2026-04-28
**Audience:** A coding agent starting fresh, with this file + AUDIT.md as primary context.

This plan covers the audit's Low-severity security items (L1–L8), Info notes (I1–I4), and state-sync Low items (S16–S22). None of these are urgent. Several are "won't fix" or "document and accept" — flagged where applicable. Anything in plans 1 or 2 is **not** repeated here.

---

## Reading order

1. `docs/CODING-RULES.md`, `docs/WISP-RULES.md`
2. Area spec under `docs/spec/`
3. `docs/review/2026-04-28/AUDIT.md`
4. `docs/review/2026-04-28/PLAN-1-TOP10.md` and `PLAN-2-IMPORTANT.md` (for context on what's already in flight)
5. This file

## Conventions

Same as plans 1 and 2. Most items here are small enough to fold into a single "minor cleanup" PR rather than land individually.

---

# Section A — Security: Low

## B3.1 — Align VM body-name length: schema (64) vs `validateVMName` (128)

**Findings:** L1.

**Decision needed:** **YES — minor.** Pick 64 or 128 as the canonical limit.

**Files involved:**
- `backend/src/lib/validation.js:5` (`VM_NAME_MAX_LEN = 128`)
- `backend/src/routes/vms.js:124,481` (schema `maxLength: 64`)

**Fix:** Update both files to use the same constant. Recommend 64 (libvirt domains rarely benefit from longer names; 64 is plenty).

**Test plan:** A 65-character valid name → consistently rejected at the validator and the schema, never one but not the other.

**Blast radius:** None expected. If any tooling uses long names, the user must shorten.

**Doc updates:** `docs/spec/VM-MANAGEMENT.md` (single canonical limit).

**Changelog:** yes — Bug Fixes: "align VM name length limits between schema and validator".

---

## B3.2 — `mountResponseSchema`: drop `password` field entirely

**Findings:** L2.

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/mounts.js:13-28` (`mountResponseSchema`)
- `backend/src/lib/settings.js:92-110` (`mountForApi` masking)

**Fix:** Remove the `password` property from the response schema so Fastify strips it on serialization. The masking in `mountForApi` becomes belt-and-braces.

**Test plan:** `GET /api/mounts` → response has no `password` field at all (not even masked).

**Blast radius:** Frontend may display a "***" placeholder today; remove that branch as well.

**Doc updates:** `docs/spec/STORAGE.md`.

**Changelog:** yes — Bug Fixes: "mounts API never includes password field in response".

---

## B3.3 — Drop `process.umask(0o077)` for SMB temp dirs (use `mkdtemp` mode)

**Findings:** L3.

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/linux/host/smbMount.js:75-78,109-111`
- `backend/src/lib/linux/host/diskMount.js:75-78`

**Fix:** Already mostly using `mkdtemp({ mode: 0o700 })` and `writeFile(..., { mode: 0o600 })` — drop the `process.umask` calls; they're process-global and racy with concurrent handlers.

**Test plan:** Concurrent SMB mount + a second handler creating a file → confirm the second file gets default mode (0644 typically), not 0600. Confirm SMB temp dir/files still 0700/0600.

**Blast radius:** Process-wide change to umask handling; carefully review every file-create site that runs concurrently with SMB mount.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "stop touching process-global umask in SMB mount".

---

## B3.4 — `findUniqueFilename`: use `wx` flag (O_CREAT|O_EXCL)

**Findings:** L5.

**Decision needed:** no.

**Files involved:** `backend/src/lib/downloadUtils.js:15-34`.

**Fix:** Have `streamResponseToFile` (or whoever owns the `createWriteStream`) open with `{ flags: 'wx' }`. If `EEXIST`, retry `findUniqueFilename` once; if it fails again, surface a 409.

**Test plan:** Symlink-swap probe (race condition); confirm the write fails or refuses to follow the link.

**Blast radius:** Library download path.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "library download uses O_EXCL to defeat symlink races".

---

## B3.5 — `request.ip`: document the `trustProxy` requirement

**Findings:** L6.

**Decision needed:** no — documentation only.

**Files involved:**
- `docs/spec/AUTH.md`
- `backend/src/routes/auth.js:45` (note in code comment)
- `backend/src/index.js:49`

**Fix:** Document that `request.ip` is the socket peer (Fastify `trustProxy: false` default). If a future deployment puts a reverse proxy in front, *do not* enable `trustProxy: true` without an upstream-IP allowlist.

**Test plan:** N/A — documentation.

**Blast radius:** None.

**Doc updates:** `docs/spec/AUTH.md`, `docs/spec/DEPLOYMENT.md`.

**Changelog:** no.

---

## B3.6 — Document and assert mode 0600 on `config/runtime.env`

**Findings:** L7.

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/loadRuntimeEnv.js`
- `scripts/install.sh`, `scripts/linux/setup/*.sh`
- `docs/spec/CONFIGURATION.md`

**Fix:**

1. In install/setup, `chmod 600 config/runtime.env` after writing it.
2. In `loadRuntimeEnv`, on read, `fs.statSync(p)` and warn (or refuse) if mode is more permissive than 0600.

**Test plan:** Write a runtime.env with mode 0644; boot backend → see warning. Fix to 0600 → no warning.

**Blast radius:** Config load.

**Doc updates:** `docs/spec/CONFIGURATION.md`.

**Changelog:** yes — Bug Fixes: "warn on permissive runtime.env permissions".

---

## B3.7 — WebSocket close reasons: drop user-derived `err.message`

**Findings:** L8.

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/console.js:24,40`
- `backend/src/routes/containerConsole.js:56,71`

**Fix:** Replace dynamic close reasons with a small set of generic strings (`'auth required'`, `'not found'`, `'internal error'`). Keep the detailed error in the server log via Pino.

**Test plan:** Force each error path; confirm the WS close reason is one of the documented constants.

**Blast radius:** Frontend may currently display the raw reason — if so, switch to a code lookup.

**Doc updates:** `docs/spec/CONSOLE.md`.

**Changelog:** yes — Bug Fixes: "WebSocket close reasons no longer include internal error text".

---

# Section B — Info

## B3.8 — Frontend security headers (CSP, etc.)

**Findings:** I1.

**Decision needed:** **YES** — depends on prod deployment topology (frontend served by `frontend/server.js`? a reverse proxy? CDN?).

**Files involved:**
- `frontend/server.js`
- (or proxy config, if applicable)

**Fix sketch:** In production, set:
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (or `Content-Security-Policy: frame-ancestors 'none'`)
- `Referrer-Policy: same-origin`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains` (if HTTPS-fronted)

The exact CSP needs review against actual asset usage (xterm, novnc inline styles, etc.). A relaxed-then-tightened workflow is safer: ship Report-Only first, then enforce.

**Test plan:** Open every page; confirm no `Refused to load` console warnings (or Report-Only reports).

**Blast radius:** A too-strict CSP breaks the UI. Use Report-Only first.

**Doc updates:** `docs/spec/DEPLOYMENT.md`.

**Changelog:** yes — New Features (or Bug Fixes): "frontend security headers (CSP, etc.)".

---

## B3.9 — SSE responses bypass `onSend` hooks (no action needed)

**Findings:** I2.

**Decision needed:** no.

**Fix:** None — informational. If B3.8 (security headers) is implemented at the frontend layer, this isn't relevant. If headers are added at Fastify, `reply.hijack()` skips them, so SSE responses won't carry security headers; that's acceptable since SSE bodies are not HTML.

**Changelog:** no.

---

## B3.10 — Dev CORS allows `Authorization` header (no action needed)

**Findings:** I3.

**Decision needed:** no.

**Fix:** None — informational. The current dev CORS config (`origin: 'http://localhost:5173'`) is correct. No `credentials: true`, so cookies don't ride along — fine for the current header-token model.

**Changelog:** no.

---

## B3.11 — CSRF posture (no action needed beyond plan-2 changes)

**Findings:** I4.

**Decision needed:** no — but if B2.16 (cookie migration in plan 2) lands, revisit and add a CSRF-token mechanism then.

**Fix:** None standalone. Revisit if B2.16 lands.

**Changelog:** no.

---

# Section C — State synchronization: Low

## B3.12 — Container delete: deregister mDNS *after* task SIGKILL

**Findings:** S16.

**Decision needed:** no.

**Files involved:** `backend/src/lib/linux/containerManager/containerManagerCreate.js:587-589`.

**Fix:** Move `deregisterServicesForContainer` and `deregisterAddress` to after `Tasks.delete`. Trade-off: brief window where the .local name resolves to a container being torn down — better than the current "name gone, container still serving".

**Test plan:** Delete a running container; observe mDNS entries disappear roughly as the container exits.

**Blast radius:** Cosmetic.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "deregister container mDNS entries after container task is killed".

---

## B3.13 — Out-of-band VM rename: document, don't auto-handle

**Findings:** S17.

**Decision needed:** no — accepted.

**Fix:** None. Document in `docs/spec/VM-MANAGEMENT.md` that out-of-band renames (`virsh domrename` or direct XML edits) require a backend restart to fully reconcile mDNS state.

**Changelog:** no.

---

## B3.14 — `oci-image-meta.json`: atomic write + writer mutex

**Findings:** S18.

**Decision needed:** no.

**Files involved:** `backend/src/lib/linux/containerManager/containerManagerImages.js:24-62,141-148`.

**Fix:** Use `writeJsonAtomic` from B1.10. Add a single-writer mutex around the read-modify-write sequence so concurrent updates serialize.

```js
let writeLock = Promise.resolve();
async function withImageMetaLock(fn) {
  const next = writeLock.then(fn).catch((err) => { throw err; });
  writeLock = next.catch(() => undefined);
  return next;
}
```

**Test plan:** Concurrent calls to `checkAllImagesForUpdates` and `listContainerImages`; confirm the JSON file is never empty/garbage post-fault-injection.

**Blast radius:** Image metadata path.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "atomic + serialized writes for oci-image-meta.json".

---

## B3.15 — `listBackgroundJobs`: tolerate per-store throws

**Findings:** S19.

**Decision needed:** no.

**Files involved:** `backend/src/lib/listBackgroundJobs.js:9-16`.

**Fix:**

```js
function safe(fn) { try { return fn(); } catch { return []; } }
return [
  ...safe(() => createJobStore.listJobs()),
  ...safe(() => containerJobStore.listJobs()),
  // ...
];
```

**Test plan:** Force one store to throw on `listJobs`; confirm the aggregate endpoint still returns the others.

**Blast radius:** None — defense in depth.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "background-jobs aggregator tolerates a single store failing".

---

## B3.16 — Container `localDns` toggle: re-register on first IP discovery

**Findings:** S20.

**Decision needed:** no.

**Files involved:** `backend/src/lib/linux/containerManager/containerManagerConfig.js:301-307`. Also touches the periodic reconciler from B2.22.

**Fix:** Either (a) hook into `persistContainerIpFromNetnsIfMissing` so that when an IP is first discovered for a container with `localDns: true`, an mDNS register is fired; or (b) lean on B2.22's periodic reconciler — once that lands, this happens within ≤60 s automatically.

Option (b) is the cheaper choice if B2.22 lands; treat this as a comment on B2.22 rather than a separate bundle.

**Test plan:** Toggle `localDns: true` while CNI lease is pending; wait for reconcile; confirm mDNS A record published.

**Blast radius:** None.

**Doc updates:** none.

**Changelog:** no (covered by B2.22's changelog).

---

## B3.17 — `vmListCache.staleBinary` after qemu upgrade: accepted

**Findings:** S21.

**Decision needed:** no — accepted.

**Fix:** None. The current `fs.watch` covers the common case; uncommon edge cases require restarting the VM anyway.

**Changelog:** no.

---

## B3.18 — Backup manifest `vmBasePath` portability: accepted, document

**Findings:** S22.

**Decision needed:** no — accepted.

**Fix:** None. Document in `docs/spec/BACKUPS.md` that restoring across `vmsPath` config changes uses heuristics; if those fail, the user must rename the manifest's `vmBasePath` manually before restore.

**Changelog:** no.

---

# Cross-bundle ordering (Plan 3)

Most of these can land in a single "low-severity cleanup" PR. A reasonable bundling:

- **PR G — minor security:** B3.1, B3.2, B3.3, B3.4, B3.6, B3.7.
- **PR H — frontend security headers:** B3.8 (alone; CSP work is its own thing).
- **PR I — minor state-sync:** B3.12, B3.14, B3.15.
- **Documentation-only updates** (B3.5, B3.13, B3.18): can be a single docs PR alongside any of the above.

Items marked "accepted" (B3.17, parts of B3.10, B3.11) need no PR.
