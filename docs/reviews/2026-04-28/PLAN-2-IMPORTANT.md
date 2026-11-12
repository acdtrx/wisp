# Wisp Fix Plan 2 — Important (Critical/High/Medium not in Plan 1, plus drift, plus state-sync ≥ Medium)

**Audit source:** `docs/review/2026-04-28/AUDIT.md`
**Created:** 2026-04-28
**Audience:** A coding agent starting fresh, with this file + AUDIT.md + PLAN-1-TOP10.md as primary context.

This plan covers everything in AUDIT.md that is **not** in `PLAN-1-TOP10.md` and that is at or above the Medium / state-sync-Medium severity tier. Plan 3 covers Low + Info + state-sync Low.

**Items already handled in PLAN-1-TOP10.md (do not duplicate work):** C1, C2, C3, C4, C5, H1, H2, H4, H5, M9, S1, S2, S3, S6, S7. Bundle B1.10 also covers S13 (settings read-race). Bundle B1.1 also takes care of half of H10 (run-log path traversal); the filename header escape is **not** in plan 1 and is included here as part of bundle B2.10.

---

## Reading order for a fresh agent

1. `docs/CODING-RULES.md` and `docs/WISP-RULES.md`
2. `docs/UI-PATTERNS.md` (if touching UI)
3. Area-specific spec under `docs/spec/`
4. `docs/review/2026-04-28/AUDIT.md`
5. `docs/review/2026-04-28/PLAN-1-TOP10.md` (so you know what's already in flight)
6. This file, for the bundle in scope

## Conventions and rules

Same as PLAN-1-TOP10.md. Re-read its "Project rules to internalize" section before coding.

---

# Section A — Security (High and Medium not in Plan 1)

## B2.1 — Backup `destinationPaths`: constrain to configured backup roots

**Findings:** H3 (High).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/vms.js:288-340` (`POST /vms/:name/backup`)
- `backend/src/lib/linux/vmManager/vmManagerBackup.js:176-186` (current path validation; only checks `startsWith('/')`)
- `backend/src/lib/settings.js` (where `listConfiguredBackupRoots` is — verify exact name; if missing, expose a helper)

**Fix:** Reject any `destinationPaths` entry whose `realpath` is not under one of `listConfiguredBackupRoots(settings)`. Mirror the canonicalization pattern already used by `restoreBackup`. The simplest change is to remove `destinationPaths` from the public API entirely and require `destinationIds` (frontend already has the registry); confirm with the user before removing the field.

**Test plan:**
- `POST /vms/:name/backup` with `destinationPaths: ['/etc']` → 422.
- Same with a path inside a configured backup root → succeeds end-to-end.

**Blast radius:** Frontend may still pass `destinationPaths` for ad-hoc backups; verify it actually uses the field (`grep -rn destinationPaths frontend/src/`) before removing.

**Doc updates:** `docs/spec/BACKUPS.md`.

**Changelog:** yes — Bug Fixes: "constrain backup destinations to configured roots".

---

## B2.2 — `attachDisk` / `attachISO` / create-time CDROM/disk paths: bound to library + per-VM dir

**Findings:** H6 (High), M6 (Medium). Same root cause; one bundle.

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/vms.js:545-578,663-690` (attach routes)
- `backend/src/lib/linux/vmManager/vmManagerIso.js:9-30` (`attachISO`)
- `backend/src/lib/linux/vmManager/vmManagerDisk.js:43-77` (`attachDisk`)
- `backend/src/lib/linux/vmManager/vmManagerCreate.js:301-317` (create-time `cdrom1Path`, `cdrom2Path`, `disk.sourcePath`)
- `backend/src/lib/paths.js` (`getImagePath`, `getVMBasePath`)

**Fix:**

Add a shared helper `assertPathInsideAllowedRoots(absPath, vmName)` in vmManager (or `paths.js`) that:

```js
function assertPathInsideAllowedRoots(absPath, vmName) {
  const resolved = path.resolve(absPath);
  const allowedRoots = [
    path.resolve(getImagePath()),
    path.resolve(getVMBasePath(vmName)),
  ];
  const ok = allowedRoots.some(root =>
    resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw createAppError('PATH_NOT_ALLOWED',
      `path must be under image library or VM directory: ${absPath}`);
  }
}
```

Call it at every site that accepts a user-supplied absolute path: both `attachDisk`/`attachISO` and inside `createVM` for `cdrom1Path`, `cdrom2Path`, and any `disk.sourcePath` with `disk.type === 'existing'`.

**Test plan:**
- `POST /vms/foo/cdrom/sdc -d '{"path":"/etc/shadow"}'` → 422.
- `POST /vms/foo/disks -d '{"path":"/etc/passwd"}'` → 422.
- `POST /vms` with `disk.sourcePath: "/etc/shadow"` → 422.
- Library path (`<imagePath>/ubuntu.iso`) → succeeds.
- Per-VM path (`<vmsPath>/foo/extra.qcow2`) → succeeds.

**Blast radius:** Low. Verify nothing legitimate uses an absolute path outside these roots — if a deployment had an external disk pool, bundle that into the registry.

**Doc updates:** `docs/spec/VM-MANAGEMENT.md` (path policy on attach + create).

**Changelog:** yes — Bug Fixes: "constrain attached disk/CDROM paths to image library or per-VM directory".

---

## B2.3 — SMB credentials: stop putting password on argv; reject `,` in user/pass

**Findings:** H7 (High), M10 (Medium). Same surface.

**Decision needed:** no.

**Files involved:**
- `backend/scripts/wisp-mount:36-37,43-48,57-58` (option-string build, `source` of JS-generated bash file)
- `backend/src/lib/linux/host/smbMount.js:25-29,75-91` (JS escaping, mount invocation)

**Fix:**

1. Switch to `mount -o credentials=<file>`. Write a credentials file (mode 0600) under a per-mount tmp dir with `username=`, `password=`, `domain=` lines (one per line). Pass only the path to `wisp-mount`. The password never hits argv or `/proc/<pid>/cmdline`.
2. Reject `,`, `\n`, `\r` in `username` and `password` JS-side (still useful for the credentials-file format).
3. Replace `wisp-mount`'s `source "$1"` with a key=value parser. Read the JS-generated file line by line and parse with `IFS='=' read -r k v`. No shell evaluation of user-derived content.

```bash
# wisp-mount — replace `source "$1"` with this loop
while IFS= read -r line; do
  case "${line}" in
    \#*|'') continue ;;
    *=*) eval_safe_kv "$line" ;;
  esac
done < "$1"
# eval_safe_kv:
eval_safe_kv() {
  local kv="$1"
  local k="${kv%%=*}"
  local v="${kv#*=}"
  case "$k" in
    share|mountPath|username|password|domain|filesystem|uid|gid) printf -v "$k" '%s' "$v" ;;
    *) echo "wisp-mount: unknown key $k" >&2; exit 64 ;;
  esac
}
```

**Test plan:**
- SMB mount with `password='secret,setuids,exec'` → succeeds (no longer treated as extra options).
- `ps auxf` during mount → password not visible.
- SMB mount with `password=$'pwn\nshare=//attacker'` → JS rejects (newline).
- File parser rejects an unknown key.

**Blast radius:** Helper change is the riskier half — verify by mounting a real SMB share end-to-end after the change.

**Doc updates:** `docs/spec/STORAGE.md`.

**Changelog:** yes — Bug Fixes: "SMB password no longer placed on argv (uses credentials file)"; "wisp-mount: stop sourcing JS-generated bash".

---

## B2.4 — WebSocket console: validate `Origin` header

**Findings:** H8 (High).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/console.js:8-89` (`/ws/console/:vm/vnc`)
- `backend/src/routes/containerConsole.js:39-132` (`/ws/console/container/...`)

**Fix:**

Inspect `Origin` on the upgrade request. Reject unless it matches the configured frontend origin (or is same-origin in production). In dev, allow `http://localhost:5173`. Fastify exposes the upgrade request as `request` (or via `connection.socket`); the `origin` header lives on the incoming `IncomingMessage`.

```js
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'development'
  ? new Set(['http://localhost:5173'])
  : null; // production: same-origin only — compare to request.headers.host

fastify.get('/console/:vm/vnc', { websocket: true }, (connection, req) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS) {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      connection.socket.close(1008, 'origin not allowed');
      return;
    }
  } else {
    // production: enforce same-origin
    if (!origin || new URL(origin).host !== req.headers.host) {
      connection.socket.close(1008, 'origin not allowed');
      return;
    }
  }
  // ...existing JWT verify...
});
```

**Test plan:**
- WS from `http://localhost:5173` in dev → succeeds.
- WS from `http://attacker.example.com` (faked Origin) → 1008 close.
- WS without `Origin` header → 1008 close.
- Production same-origin connect from the served frontend → succeeds.

**Blast radius:** WS-only. Frontends/proxies that don't forward `Origin` will break — verify your prod frontend (Fastify static + http-proxy) does forward it.

**Doc updates:** `docs/spec/CONSOLE.md` (Origin policy).

**Changelog:** yes — Bug Fixes: "console WebSocket validates Origin header".

---

## B2.5 — Image library multipart upload: handle `truncated`, cleanup partial files

**Findings:** H9 (High).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/library.js:109-149` (upload handler)
- `backend/src/index.js:55` (`fileSize` 50 GiB — keep, but note in docs)

**Fix:**

```js
try {
  await pipeline(data.file, createWriteStream(destPath));
  if (data.file.truncated) {
    await unlink(destPath).catch(() => { /* best effort */ });
    return reply.code(422).send({ error: 'File too large', detail: `Limit is ${LIMIT_BYTES} bytes` });
  }
} catch (err) {
  await unlink(destPath).catch(() => { /* best effort */ });
  throw err; // let handleRouteError / sendError translate
}
```

**Test plan:**
- Upload a file > 50 GiB → expect 422 and the partial file cleaned up.
- Kill the client mid-upload → confirm partial file removed (or at least not orphaned indefinitely).
- Happy path upload still works.

**Blast radius:** Library upload only.

**Doc updates:** `docs/spec/IMAGE-LIBRARY.md`.

**Changelog:** yes — Bug Fixes: "image library upload: cleanup truncated/partial files".

---

## B2.6 — Login rate-limit Map: periodic sweep + size cap

**Findings:** H11 (High).

**Decision needed:** no.

**Files involved:** `backend/src/routes/auth.js:5-22`.

**Fix:**

```js
const LOGIN_ATTEMPTS_MAX_ENTRIES = 10_000;
const SWEEP_INTERVAL_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, SWEEP_INTERVAL_MS).unref();

function recordFailedLogin(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    if (loginAttempts.size >= LOGIN_ATTEMPTS_MAX_ENTRIES) {
      // refuse to record (don't grow unbounded). Returning early means later
      // recordFailedLogin calls for this IP behave as if the limit hadn't been
      // reached — that's an acceptable trade-off vs unbounded memory.
      return;
    }
    entry = { count: 0, resetAt: now + LOGIN_RATE_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  entry.count += 1;
}
```

**Test plan:**
- Burst 100 failed logins from distinct IPs; check map size; wait for sweep; confirm entries reaped.
- After fix, a normal failed login still rate-limits at 5.

**Blast radius:** Auth path; light.

**Doc updates:** `docs/spec/AUTH.md` (rate limit semantics).

**Changelog:** yes — Bug Fixes: "login rate-limit map now expires entries and caps size".

---

## B2.7 — `publicPaths` matched by route, not raw URL string

**Findings:** H12 (High, latent).

**Decision needed:** no.

**Files involved:** `backend/src/lib/auth.js:121-125`.

**Fix:**

Switch from `urlPath = request.url.split('?')[0]` to `request.routeOptions?.url` (Fastify's matched-route URL, post-routing). The hook is `onRequest` which runs before routing; alternative is to use `preValidation` instead:

```js
// Move the auth check to preValidation so request.routeOptions.url is set
app.addHook('preValidation', async (request, reply) => {
  const routeUrl = request.routeOptions?.url || request.url.split('?')[0];
  if (publicPaths.has(routeUrl)) return;
  // ... existing token check
});
```

Verify hook ordering doesn't accidentally let unauthenticated requests reach handlers — `preValidation` runs after routing but before validation, which is exactly what we want.

**Test plan:**
- `GET /api/auth/login/` (trailing slash) → expect 404 not 401 (no longer treated as public unless route exists).
- `GET /api/auth/login%2F` → expect 401.
- Adding a future public path (`/health`) works correctly with route name match.

**Blast radius:** Auth hook; tested by the existing login flow. Add a test for trailing-slash and percent-encoded equivalents.

**Doc updates:** `docs/spec/AUTH.md`.

**Changelog:** yes — Bug Fixes: "auth: match public paths by route name, not raw URL".

---

## B2.8 — `/api/github/keys/:username`: manual redirects + light rate limit

**Findings:** H13 (High, latent).

**Decision needed:** no.

**Files involved:** `backend/src/routes/cloudinit.js:95-117`.

**Fix:** Set `redirect: 'manual'` in the GitHub fetch; if the response is 3xx, return 502 with `detail: 'Unexpected redirect from upstream'` (GitHub's `.keys` doesn't redirect). Add a per-IP rate limit (10 req/min) using the same Map pattern as `loginAttempts`.

**Test plan:**
- `curl /api/github/keys/torvalds` returns the keys.
- 11th call within 60 s → 429.
- A 30x mocked from upstream → 502.

**Blast radius:** Single route.

**Doc updates:** `docs/spec/CLOUD-INIT.md`.

**Changelog:** yes — Bug Fixes: "GitHub keys proxy: manual redirects and rate limit".

---

## B2.9 — JWT: drop the plaintext-password fallback

**Findings:** M2 (Medium).

**Decision needed:** no — but be aware "feature-building, no migrations" means existing operators with a plaintext file must rerun the bootstrap. Coordinate with the user.

**Files involved:** `backend/src/lib/auth.js:14-39,90-105`.

**Fix:** Remove the `plain` branch from `readPasswordFile`. If the file content does not start with `scrypt:`, refuse to start the backend with a clear error message pointing at `wispctl password`.

```js
function readPasswordFile() {
  if (!existsSync(PASSWORD_FILE)) return null;
  const raw = readFileSync(PASSWORD_FILE, 'utf8').trim();
  if (!raw) return null;
  if (!raw.startsWith('scrypt:')) {
    throw new Error('wisp-password is in unsupported format. Run wispctl password to set a new password.');
  }
  // ...existing scrypt parse...
}
```

**Test plan:**
- Run with a plaintext `wisp-password` → backend refuses to start with the expected error.
- Run with a freshly-generated scrypt password → boots normally.

**Blast radius:** Operator-affecting on existing installs. Communicate via release notes.

**Doc updates:** `docs/spec/AUTH.md`, `scripts/install.sh` (ensure post-install runs the password script).

**Changelog:** yes — Bug Fixes: "auth: refuse to start with plaintext password file (use wispctl password)".

---

## B2.10 — Sanitize raw stderr in error responses; HTTP header injection in run-log filename

**Findings:** M3 (Medium), H10 (High — partially handled by B1.1; the `Content-Disposition` quoting half lives here).

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/routeErrors.js:127-136` (`handleRouteError`, `sendError`)
- `backend/src/lib/cloudInit.js:17-30` (one of many `err.raw = err.stderr || err.message` sites)
- `backend/src/routes/containers.js:400-414` (run-log download `Content-Disposition`)
- Most lib helpers that build `{ raw: stderr }` errors (search: `grep -rn "raw:" backend/src/lib/`)

**Fix:**

Two parts:

1. **Curated detail.** Distinguish "user-meaningful detail" from "raw stderr". In `routeErrors.js`, change the default `detail` to a curated message and log raw server-side:

```js
export function handleRouteError(err, reply, log) {
  const status = mapCodeToStatus(err.code);
  const safeDetail = curateDetail(err); // see below
  if (err.raw && err.raw !== safeDetail) {
    log?.warn({ err, raw: err.raw }, 'Route error (raw)');
  }
  reply.code(status).send({ error: err.message, detail: safeDetail, code: err.code });
}

function curateDetail(err) {
  // Strip absolute paths, UUIDs, line numbers from common toolchain stderr
  const raw = err.raw || err.message;
  return String(raw)
    .replace(/\/[^\s'"]+/g, '<path>')   // crude path scrub
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .slice(0, 500);
}
```

This is a minimum-viable redaction. A nicer approach is to keep `err.detail` distinct from `err.raw` from the throw site forward — most helpers know what's safe.

2. **Run-log `Content-Disposition`.** Apply the RFC-5987 encoded filename pattern from B1.1:

```js
const encoded = encodeURIComponent(`${name}-${runId}.log`);
reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
```

**Test plan:**
- Trigger a known error path that includes an absolute path in stderr (e.g. backup to a non-writable dest); confirm response `detail` does not contain the absolute path; confirm log entry contains the raw error.
- Run-log download with a name containing special chars → header is well-formed.

**Blast radius:** Error responses change shape (`detail` strings). Frontend consumers that string-match on `detail` may break — sweep `frontend/src/` for `error.detail.includes(`.

**Doc updates:** `docs/spec/ERROR-HANDLING.md`.

**Changelog:** yes — Bug Fixes: "redact filesystem details from error responses; RFC-5987 filename in run-log download".

---

## B2.11 — `wisp-netns ipv4 <name> [ifname]` — validate ifname

**Findings:** M4 (Medium).

**Decision needed:** no.

**Files involved:** `backend/scripts/wisp-netns:27-37`.

**Fix:** Apply the same regex used by `route-add` (read the script for the exact pattern; typical: `^[a-zA-Z0-9._-]{1,15}$`). Reject otherwise.

**Test plan:**
- `wisp-netns ipv4 cname --help` → reject.
- `wisp-netns ipv4 cname eth0` → still works.

**Blast radius:** Script-only.

**Doc updates:** `docs/spec/CONTAINERS.md` (helpers).

**Changelog:** yes — Bug Fixes: "wisp-netns: validate ifname for ipv4 subcommand".

---

## B2.12 — Caddy app `target`: validate as host:port (no Caddyfile injection)

**Findings:** M5 (Medium).

**Decision needed:** no.

**Files involved:** `backend/src/lib/linux/containerManager/apps/caddy.js:22-87,130-137`.

**Fix:**

```js
const TARGET_RE = /^([a-z][a-z0-9+.-]*:\/\/)?[a-zA-Z0-9.-]+(:[0-9]{1,5})?(\/[^\s\n\r{}]*)?$/;
function validateTarget(target) {
  if (typeof target !== 'string' || !TARGET_RE.test(target)) {
    throw createAppError('CADDY_TARGET_INVALID',
      'target must be a host[:port] or scheme://host[:port][/path]');
  }
  if (/[\n\r{}]/.test(target)) {
    throw createAppError('CADDY_TARGET_INVALID', 'target contains invalid characters');
  }
}
```

Call `validateTarget(host.target)` in `validateAppConfig`. No `\n`, `\r`, `{`, `}`.

**Test plan:**
- `target: "1.2.3.4 {\nbind 0.0.0.0\n}"` → 422.
- `target: "http://upstream:8080"` → succeeds.

**Blast radius:** Caddy app only.

**Doc updates:** `docs/spec/CUSTOM-APPS.md`.

**Changelog:** yes — Bug Fixes: "Caddy app: validate target field (Caddyfile injection hardening)".

---

## B2.13 — Snapshot name validation in revert/delete routes

**Findings:** M7 (Medium).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/vms.js:860-897`
- `backend/src/lib/linux/vmManager/vmManagerSnapshots.js:77-121`

**Fix:** Validate `id` against the same regex used at create (`^[a-zA-Z0-9 ._-]+$`, length cap). Add a tiny `validateSnapshotName(id)` helper alongside `validateVMName` for consistency.

**Test plan:**
- `DELETE /vms/foo/snapshots/..%2Fbar` → 422.
- Valid name → still works.

**Blast radius:** Snapshot routes only.

**Doc updates:** `docs/spec/SNAPSHOTS.md`.

**Changelog:** yes — Bug Fixes: "validate snapshot names on revert/delete".

---

## B2.14 — Container mount file PUT: enforce content size cap

**Findings:** M8 (Medium).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/containers.js:486-500`
- `backend/src/lib/linux/containerManager/containerManagerMountsContent.js:45`

**Fix:**

In `putMountFileTextContent`, check `Buffer.byteLength(content, 'utf8') > MOUNT_FILE_CONTENT_MAX_BYTES` and throw `createAppError('MOUNT_FILE_TOO_LARGE', …)` mapped to 413. Also tighten the route's body schema with `properties.content.maxLength` to match.

**Test plan:**
- PUT 1 MB string → 413.
- PUT 256 KB string → succeeds.

**Blast radius:** One endpoint.

**Doc updates:** `docs/spec/CONTAINERS.md`.

**Changelog:** yes — Bug Fixes: "container mount PUT enforces content size cap".

---

## B2.15 — `?token=` accepted only on SSE/WS routes

**Findings:** M11 (Medium).

**Decision needed:** no.

**Files involved:** `backend/src/lib/auth.js:130-134`. Callers: `frontend/src/api/sse.js`, `frontend/src/components/console/*`.

**Fix:**

Tag SSE/WS routes (e.g. via Fastify `config` option in route declaration) and only accept `?token=` for those:

```js
// In auth hook:
const allowQueryToken = request.routeOptions?.config?.acceptQueryToken === true;
if (!authHeader?.startsWith('Bearer ') && !(allowQueryToken && request.query?.token)) {
  reply.code(401).send({ ... });
  return;
}
```

In each SSE/WS route declaration, add `config: { acceptQueryToken: true }`. Default for everything else is header-only.

**Test plan:**
- `GET /api/vms?token=<jwt>` → 401 (header required).
- `GET /api/vms/stream?token=<jwt>` → 200.
- `GET /api/vms` with `Authorization: Bearer <jwt>` → 200.

**Blast radius:** Frontend `api/sse.js` already uses `?token=`; rest of the API client uses headers. Sweep to confirm no other code uses `?token=`.

**Doc updates:** `docs/spec/AUTH.md`.

**Changelog:** yes — Bug Fixes: "auth: accept ?token= only on SSE/WS routes".

---

## B2.16 — JWT to HttpOnly cookie (defense in depth vs XSS)

**Findings:** M1 (Medium).

**Decision needed:** **YES** — strategic. Coordinate scope with the user before starting.

**Why this is a decision:** It cascades. Cookies remove the URL-token leakage entirely (B1.4 partly does, but cookies remove the need); they require a CSRF token mechanism (header check); they affect the dev CORS config (`credentials: true`); they affect the SSE/WS auth path (EventSource sends cookies natively, but custom WS subprotocols don't). Doing this right is one big PR, not a small change.

**Files touched if this proceeds:**
- `backend/src/lib/auth.js`, `backend/src/routes/auth.js`
- `frontend/src/api/client.js`, `frontend/src/api/sse.js`
- `frontend/src/components/console/*` (WS auth)
- CSP / security-header strategy
- `docs/spec/AUTH.md`

**Fix sketch:** Standard pattern — set token in `Set-Cookie: HttpOnly; Secure; SameSite=Lax; Path=/`. Add a CSRF-token header (double-submit cookie) for state-changing requests. Frontend reads CSRF token from a non-HttpOnly cookie or a small `/api/auth/csrf` endpoint.

**Blast radius:** Large. Touches every authenticated request path on the frontend. Handle as a single feature PR with a short freeze on other auth changes.

**Doc updates:** `docs/spec/AUTH.md` (rewrite the auth section).

**Changelog:** yes — New Features (or Bug Fixes, depending on framing): "auth tokens moved to HttpOnly cookies".

---

# Section B — State synchronization (High and Medium not in Plan 1)

## B2.17 — Snapshot memory `@file` paths after VM rename

**Findings:** S4 (High state-sync). Closely tied to S1 (in plan 1).

**Decision needed:** no — but only after B1.8 (S1) lands, since this assumes the VM directory has been moved.

**Files involved:** `backend/src/lib/linux/vmManager/vmManagerSnapshots.js:55-63`. New helper to walk + redefine snapshots.

**Fix:**

Add a `rewriteSnapshotMemoryPaths(domainName, oldDir, newDir)` helper used by `renameVM` (B1.8). Walk `ListDomainSnapshots`, for each:

1. `GetXMLDesc(0)` → string.
2. `parseDomainRaw(xml)` (or whatever XML helper handles snapshot XML — verify; if missing, write a parse helper using `fast-xml-parser`).
3. Replace `<memory file="<oldDir>/...">` with `<memory file="<newDir>/...">`.
4. `buildXml(...)` → new string.
5. `domain.iface.SnapshotCreateXML(newXml, VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE)`.

Constants: `VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE = 1`. Confirm in `libvirtConstants.js`.

**Dependencies:** B1.8.

**Test plan:** Snapshot a VM with memory state, rename, revert → revert succeeds.

**Blast radius:** Snapshot lifecycle.

**Doc updates:** `docs/spec/SNAPSHOTS.md`.

**Changelog:** yes — Bug Fixes: "VM rename now updates snapshot memory file paths".

---

## B2.18 — `deleteVM(name, deleteDisks=false)` symmetric semantics

**Findings:** S5 (High state-sync).

**Decision needed:** **YES — minor.** Pick policy: "always remove dir on delete" or "never remove dir when keepDisks=true".

**Files involved:** `backend/src/lib/linux/vmManager/vmManagerCreate.js:530-547`.

**Fix (policy A — recommended):** With `deleteDisks=false`, **don't** remove cloud-init.iso / cloud-init.json from the dir. The user's intent is "keep my data"; cloud-init is part of their data. `rm` only fires when `deleteDisks=true`.

**Test plan:**
- `deleteVM('foo', false)` → directory contents intact.
- `deleteVM('foo', true)` → directory gone.
- After option A, recreate `foo` works (no preexisting `disk0.qcow2` since user explicitly kept it).

**Blast radius:** Single function.

**Doc updates:** `docs/spec/VM-MANAGEMENT.md` (delete semantics).

**Changelog:** yes — Bug Fixes: "deleteVM with keepDisks no longer also removes cloud-init files".

---

## B2.19 — Image library rename/delete: refuse when referenced by a VM

**Findings:** S8 (Medium state-sync).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/library.js:181,493-499`
- Reference pattern: `assertBridgeNotInUse` in `backend/src/lib/linux/host/hostNetworkBridges.js:240-251`

**Fix:** Implement `assertImageNotInUse(absPath)` that walks `listVMs()`, fetches each domain XML, and rejects if any `<disk device="cdrom"><source file="...">` (or, optionally, `<disk type="file"><source>`) matches `absPath`. Call from the rename and delete handlers in `library.js`.

**Test plan:**
- Attach an ISO to `vm1` as cdrom. `DELETE /api/library/<iso>` → 409.
- Detach, retry → succeeds.
- Rename ISO while attached → 409.

**Blast radius:** Library rename/delete; both currently unguarded, so behavior change is "more rejections, never new false positives".

**Doc updates:** `docs/spec/IMAGE-LIBRARY.md`.

**Changelog:** yes — Bug Fixes: "image library: refuse to rename/delete files in use by a VM".

---

## B2.20 — Auto-pull container image on start when missing

**Findings:** S9 (Medium state-sync).

**Decision needed:** no.

**Files involved:** `backend/src/lib/linux/containerManager/containerManagerCreate.js:432-436,525-529` (`startExistingContainer`).

**Fix:**

```js
let imageConfig;
try {
  imageConfig = await getImageConfig(config.image);
} catch (err) {
  if (err.code === 'IMAGE_NOT_FOUND') {
    log.info({ image: config.image }, 'Image missing on start; auto-pulling');
    await pullImage(config.image);
    imageConfig = await getImageConfig(config.image);
  } else {
    throw err;
  }
}
```

Verify the actual error code thrown by `getImageConfig` and adapt.

**Test plan:**
- `ctr -n wisp image rm <ref>`. `POST /api/containers/<name>/start` → triggers a pull, then container starts.
- Network-down case: pull fails with a clear error.

**Blast radius:** Container start path. Add a small log line to make the auto-pull observable.

**Doc updates:** `docs/spec/CONTAINERS.md`.

**Changelog:** yes — Bug Fixes: "container start auto-pulls image if it was removed".

---

## B2.21 — Detach removed USB devices from running VMs

**Findings:** S10 (Medium state-sync).

**Decision needed:** **YES — minor policy.** Two options:
- **A.** Subscribe to USB removal in vmManager and call `detachUSBDevice(domain, vendorId, productId)` for any matching `<hostdev>` automatically.
- **B.** Leave VM XML stale; surface a banner in the USB section "device disappeared from host". Operator detaches manually.

A is more correct; B is less risky (auto-mutating XML based on hot events is the kind of thing that becomes a foot-gun).

**Files involved:**
- `backend/src/lib/linux/host/usbMonitor.js:307` (event source)
- `backend/src/lib/linux/vmManager/vmManagerUsb.js:21-118` (detach logic)

**Fix sketch (option A):** Wire `usbMonitor.onRemoved` (verify the event name) to a vmManager handler that:
1. `listVMs()` filtering to running.
2. For each, parse `<hostdev>` entries; if any matches `vendor:product` of the removed device, call `detachUSBDevice`.

**Test plan:** Attach a USB to a running VM. Unplug. Verify `<hostdev>` is removed from the persistent and live XML.

**Blast radius:** Host-event-driven mutation of VM XML. Tread carefully.

**Doc updates:** `docs/spec/USB.md`.

**Changelog:** yes — Bug Fixes: "auto-detach USB devices from VMs when removed from host" (or "surface USB device removal in UI" if option B).

---

## B2.22 — Container DHCP renewal: refresh `network.ip` and re-register mDNS

**Findings:** S11 (Medium state-sync).

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/linux/containerManager/containerManagerNetwork.js:457-468`
- `backend/src/lib/linux/containerManager/containerManagerLifecycle.js` (find a good periodic-reconcile hook)
- `backend/src/lib/mdnsManager.js`

**Fix:** Add a periodic reconciler (e.g. 60 s, in line with existing housekeeping intervals) that, for every running container with `localDns: true`:

1. Re-read the netns IP via `discoverIpv4InNetns` (or equivalent — the same function used at start).
2. If different from `config.network.ip`, update `container.json` (atomic write), and re-register the mDNS A record with the new IP.

This is an allowed timer per CODING-RULES §6 — it's not papering over a race, it's reconciling external state.

**Test plan:**
- Force a DHCP renewal in the container (or simulate by editing the netns IP). Wait for reconcile. Confirm `container.json` and mDNS both updated.

**Blast radius:** mDNS register/deregister churn. Suppress no-op writes (only update if changed).

**Doc updates:** `docs/spec/CONTAINERS.md`.

**Changelog:** yes — Bug Fixes: "container mDNS records refresh on DHCP renewal".

---

## B2.23 — `removeMount`: refuse when referenced by a container

**Findings:** S12 (Medium state-sync).

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/settings.js` (`removeMount`)
- `backend/src/lib/linux/containerManager/containerManagerMounts.js` (FK)

**Fix:** Mirror `assertBridgeNotInUse`. Walk `listContainers()`, read each `container.json`, scan `mounts[*].sourceId === id`. Reject with 409.

**Test plan:** Create a mount, bind it to a container, attempt removal → 409. Detach, retry → succeeds.

**Blast radius:** Mount registry only.

**Doc updates:** `docs/spec/STORAGE.md`.

**Changelog:** yes — Bug Fixes: "refuse to remove a mount referenced by any container".

---

## B2.24 — Mount auto-mount: periodic retry of failed configured mounts

**Findings:** S14 (Medium state-sync).

**Decision needed:** no.

**Files involved:** `backend/src/lib/mountsAutoMount.js:48-57`.

**Fix:** Add a periodic reconciler (e.g. 5 min) that, for every configured mount with `autoMount: true` whose status is "not mounted", retries `mountOne(mount)`. Surface failures via the existing `mounts/stream` SSE.

**Test plan:** Configure an SMB mount to a temporarily-unreachable server. Boot backend; wait for reconcile after server returns. Confirm mount comes up automatically.

**Blast radius:** New timer; ensure it's `unref`'d.

**Doc updates:** `docs/spec/STORAGE.md`.

**Changelog:** yes — New Features: "periodic retry for failed auto-mounts".

---

## B2.25 — Multi-tab logout + close SSE/WS on password change

**Findings:** S15 (Medium state-sync).

**Decision needed:** no.

**Files involved:**
- `frontend/src/api/client.js` (multi-tab logout via `storage` event)
- `backend/src/routes/auth.js:67-104` (`change-password` handler)
- `backend/src/lib/sse.js` (`closeAllSSE`)
- WebSocket close path in `backend/src/routes/console.js`, `containerConsole.js`

**Fix:**

Frontend:
```js
window.addEventListener('storage', (e) => {
  if (e.key === TOKEN_KEY && !e.newValue) {
    // Token cleared in another tab → log out here too
    window.location.href = '/login';
  }
});
```

Backend (in `change-password` after `setPassword`):
```js
closeAllSSE();
// also close any WS console connections — track them in a Set in the WS routes
closeAllWSConsoles();
```

Add a `closeAllWSConsoles()` to whichever module owns the WS bookkeeping.

**Test plan:**
- Two tabs open. Logout in tab A → tab B navigates to `/login`.
- Change password while an SSE is open → SSE closes; reconnect attempts get 401 with the new secret.

**Blast radius:** Auth lifecycle; verify reconnect logic in the frontend handles the close gracefully.

**Doc updates:** `docs/spec/AUTH.md`.

**Changelog:** yes — Bug Fixes: "multi-tab logout propagates"; "password change closes existing SSE/WS connections".

---

# Section C — Coding-rules drift (D1–D11)

## B2.26 — Replace 29 `console.*` log sites with the Pino logger

**Findings:** D1.

**Decision needed:** no.

**Files involved:** see AUDIT.md §2.1 D1 for the full list (29 sites). Patterns:
- vmManager modules already accept `logger` via `state.logger` after `connect(logger)` — wire it through.
- `mdnsManager.js`, `mdnsForwarder.js` similarly.
- `containerManager*` similar.
- `lib/config.js:50`: emit a structured warning via the logger that's passed to `loadConfig` (introduce a logger param if missing).

**Fix:**

Per module: replace `console.warn('[mdns] ...', err.message)` with `state.logger?.warn({ err }, '[mdns] ...')`. If a module truly has no logger plumbed (pre-`connect`), keep the `console.warn` for that handful of boot-time messages but mark them with a comment.

**Test plan:** Boot backend; confirm all log lines now flow through Pino (single-line in dev, JSON in prod).

**Blast radius:** Cosmetic; check for any code that grep'd for `[mdns]` prefix as a debugging aid.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "route library logging through Pino instead of console.*".

---

## B2.27 — `pino-pretty` in dev (already covered in B1.4)

This is part of B1.4 (plan 1).

---

## B2.28 — `/api/stats` SSE: emit `{ error, detail }` on failure

**Findings:** D3.

**Decision needed:** no.

**Files involved:** `backend/src/routes/stats.js:74-77`.

**Fix:**

```js
} catch (err) {
  reply.raw.write(`data: ${JSON.stringify({ error: err.message, detail: err.raw || err.message, code: err.code })}\n\n`);
}
```

Mirror the `/vms/stream` pattern.

**Test plan:** Stop the host stats backend dependency; confirm the SSE emits an error frame instead of going silent.

**Blast radius:** SSE consumers that ignore unexpected frames are fine; ones that crash on unknown shapes are buggy already.

**Doc updates:** `docs/spec/HOST-MONITORING.md`.

**Changelog:** yes — Bug Fixes: "/api/stats SSE emits error frames".

---

## B2.29 — `/api/containers/stream` SSE: emit `{ error, detail }` on failure

**Findings:** D4.

**Decision needed:** no.

**Files involved:** `backend/src/routes/containers.js:91-96`.

**Fix:** Same pattern as B2.28.

**Test plan:** Stop containerd; confirm `/api/containers/stream` emits error frames.

**Blast radius:** As B2.28.

**Doc updates:** `docs/spec/CONTAINERS.md`.

**Changelog:** yes — Bug Fixes: "/api/containers/stream emits error frames".

---

## B2.30 — Frontend API client: flip `data.error || data.message` precedence

**Findings:** D5.

**Decision needed:** no.

**Files involved:** `frontend/src/api/client.js:38`.

**Fix:** One-line change: `const msg = data.error || data.message || \`Request failed: ${res.status}\`;`.

**Test plan:** Trigger any backend error; confirm frontend shows the `error` field, not the (currently empty) `message`.

**Blast radius:** None; latent today (no route emits `message`).

**Doc updates:** none — already documented in WISP-RULES.

**Changelog:** yes — Bug Fixes: "API client uses `error` field per documented contract".

---

## B2.31 — `auth.js` and `diskSmart.js`: replace plain `Error` with `createAppError`

**Findings:** D6.

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/auth.js:40,113`
- `backend/src/lib/linux/host/diskSmart.js:199-221`

**Fix:** Replace each `throw new Error('msg')` with `throw createAppError('CODE', 'msg')`. Pick stable codes: `NO_PASSWORD_CONFIGURED`, `PASSWORD_EMPTY`, `SMART_INVALID_DISK_NAME`, `SMART_HELPER_UNAVAILABLE`, etc.

**Test plan:** Trigger each; confirm route maps the code to a sensible HTTP status.

**Blast radius:** None.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "use createAppError throughout auth and diskSmart".

---

## B2.32 — `discoverIpv4InNetns`: exponential backoff (or document why flat)

**Findings:** D7.

**Decision needed:** **minor — pick** A (switch to backoff) **or** B (add a comment justifying flat polling for DHCP timing).

**Files involved:** `backend/src/lib/linux/containerManager/containerManagerNetwork.js:432`.

**Fix (option A):** Mirror the `waitForStop` exponential pattern in the same module. Retry with `setImmediate` and a doubling delay capped at e.g. 1 s, total budget similar to current 20 s.

**Test plan:** Time the IP discovery for a normal container start (should be similar). Time a long-running discovery (DHCP slow): should still succeed within budget.

**Blast radius:** Container start latency — verify by hand for at least one container.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "exponential backoff for container netns IP discovery".

---

## B2.33 — `IconPickerModal.jsx`: replace `setTimeout(focus, 50)` with layout effect

**Findings:** D8.

**Decision needed:** no.

**Files involved:** `frontend/src/components/shared/IconPickerModal.jsx:17`.

**Fix:** Replace the `setTimeout` with `useLayoutEffect(() => { inputRef.current?.focus(); }, [])` (or `requestAnimationFrame(() => inputRef.current?.focus())` if you want to defer one frame).

**Test plan:** Open modal repeatedly; confirm the input is focused immediately.

**Blast radius:** Modal-only.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "icon picker modal: focus via layout effect, not timeout".

---

## B2.34 — `XMLModal.jsx`: explain (or eliminate) the silent catch

**Findings:** D9.

**Decision needed:** no.

**Files involved:** `frontend/src/components/vm/XMLModal.jsx:76`.

**Fix:** Pull `err.message` into the displayed string instead of dropping it: `.catch((err) => setXml(\`Failed to load XML: ${err.message || ''}\`))`.

**Test plan:** Force an error on `getXMLDesc`; confirm the modal shows a useful message.

**Blast radius:** Single component.

**Doc updates:** none.

**Changelog:** yes — Bug Fixes: "XML modal: surface load error message".

---

## B2.35 — `docs/spec/API.md`: document `/api/host/disks` and `/api/host/disks/stream`

**Findings:** D10.

**Decision needed:** no.

**Files involved:** `docs/spec/API.md`. Source of truth: `backend/src/routes/host.js:338,353`.

**Fix:** Add `### GET /api/host/disks` and `### GET /api/host/disks/stream` sections matching the existing `/host/usb`/`/host/usb/stream` style. Include the response schema.

**Test plan:** Skim doc rendering; confirm internal links resolve.

**Blast radius:** Docs only.

**Doc updates:** This *is* the doc update.

**Changelog:** no (docs-only changes don't need changelog entries unless they reflect a behavior change — these don't).

---

## B2.36 — Container routes: add `schema.response` to detail endpoints

**Findings:** D11.

**Decision needed:** no.

**Files involved:** `backend/src/routes/containers.js` (~36 endpoints; ~2 currently have `response`).

**Fix:** Prioritize the endpoints the frontend actually calls for typed responses: `GET /api/containers`, `GET /api/containers/:name`, `GET /api/containers/:name/stats`, list of mounts/network. Add `schema.response[200]` shapes mirroring what the handlers actually return. Match the style of `routes/vms.js`.

**Test plan:** Hit each endpoint; confirm the response body matches the schema (Fastify will silently strip non-declared fields, so add them carefully).

**Blast radius:** Misdeclared schemas can silently strip frontend-needed fields. Test the flow end-to-end after each schema lands.

**Doc updates:** `docs/spec/CONTAINERS.md` (response shapes).

**Changelog:** yes — Bug Fixes: "add response schemas to container routes (consistent with vms.js)".

---

## Cross-bundle ordering (Plan 2)

Independent items — order by interest. Suggested grouping into PRs:

- **PR A — security hardening I:** B2.1, B2.2, B2.3, B2.4, B2.5.
- **PR B — security hardening II:** B2.6, B2.7, B2.8, B2.9, B2.10, B2.11, B2.12, B2.13, B2.14, B2.15.
- **PR C — JWT cookie migration:** B2.16 (large; alone).
- **PR D — state-sync I:** B2.17, B2.18, B2.19.
- **PR E — state-sync II:** B2.20, B2.21, B2.22, B2.23, B2.24, B2.25.
- **PR F — drift cleanup:** B2.26, B2.28, B2.29, B2.30, B2.31, B2.32, B2.33, B2.34, B2.35, B2.36.

PR A and the drift cleanup can run in parallel. Hold PR C (cookie migration) until the rest of PR A lands so the auth changes don't conflict.
