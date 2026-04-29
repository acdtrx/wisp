# Wisp Fix Plan 1 — Top 10 (highest impact per unit work)

**Audit source:** `docs/review/2026-04-28/AUDIT.md` §5 ("Top-of-list fix recommendation")
**Created:** 2026-04-28
**Audience:** A coding agent starting fresh, with this file + AUDIT.md as primary context.

This plan contains the highest-leverage fixes. Plans 2 and 3 cover the remaining items and explicitly **exclude** anything in this file.

---

## Reading order for a fresh agent (read these first, in order)

1. `docs/CODING-RULES.md` and `docs/WISP-RULES.md` — project rules; non-negotiable.
2. `docs/UI-PATTERNS.md` — only if a bundle touches UI.
3. Area-specific spec under `docs/spec/` (e.g. `VM-MANAGEMENT.md`, `CONTAINERS.md`, `AUTH.md`, `IMAGE-LIBRARY.md`, `CLOUD-INIT.md`).
4. `docs/review/2026-04-28/AUDIT.md` — the full audit context (every finding ID below cross-refs that file).
5. This plan file, for the bundle in scope.

## Conventions used in every bundle

- **Findings:** AUDIT.md cross-refs (e.g. `C1`, `H4`, `S3`).
- **Decision needed:** `yes` means this bundle requires a user choice before code lands. **Do not pick unilaterally** — pause and ask.
- **Fix:** what to do, with code sketch where useful.
- **Dependencies:** ordering vs other bundles in this plan.
- **Test plan:** concrete verification steps.
- **Blast radius:** what else could plausibly break.
- **Doc updates:** which `docs/spec/*.md` to update in the same edit.
- **Changelog:** whether to add a `CHANGELOG.md` line on push.

## Project rules to internalize

- Errors thrown as `{ code, message, raw? }`. Routes return `{ error, detail }`. Use `createAppError(code, message, raw?)` from `lib/routeErrors.js`.
- vmManager throws → `handleRouteError` → `{ error, detail }`; same for containerManager.
- No `setTimeout`/`setInterval` to paper over races. Use libvirt `DomainEvent` or exponential backoff via `setImmediate`.
- Live data via SSE, not polling. Use `createSSE` / `createJobSSE`.
- XML via `fast-xml-parser` only. Helpers: `parseDomainRaw`, `parseVMFromXML`, `buildXml`, `buildDiskXml`.
- No new external dependencies if a small function suffices. Justify new deps explicitly.
- No git `push --force`, no commit amends, no `--no-verify`. Never skip hooks.
- For each bundle, update `docs/spec/*.md` and `CHANGELOG.md` in the **same change** (per CLAUDE.md "Docs and Spec Sync" + "Changelog").

---

## B1.1 — Container routes: add `validateContainerName` preHandler

**Findings:** C3 (Critical). Amplifies: H10 (run-log header injection / path traversal).

**Decision needed:** no.

**Files involved:**
- `backend/src/routes/containers.js` (every `:name` route — currently ~24 endpoints)
- `backend/src/lib/validation.js` (already exports `validateContainerName`)
- `backend/src/lib/routeErrors.js` (for `createAppError` / `handleRouteError`)
- Reference pattern: `backend/src/routes/vms.js:46-55` (the existing VM preHandler)

**Fix:**

Add a single Fastify `preHandler` hook on the container plugin (right after `fastify` is instantiated inside `containerRoutes`) that validates `request.params.name` for every route declaring a `:name` param:

```js
fastify.addHook('preHandler', async (request) => {
  const name = request.params?.name;
  if (name === undefined) return; // routes without :name (list, create, stream)
  try {
    validateContainerName(name);
  } catch (err) {
    throw createAppError(err.code || 'INVALID_CONTAINER_NAME', err.message);
  }
});
```

`handleRouteError` will already map `INVALID_CONTAINER_NAME` → 422. Verify the existing mapping in `handleRouteError`; if it doesn't map this code, add it.

While in this file, also fix the `Content-Disposition` interpolation in the run-log download (H10): even with `name` validated, the `runId` interpolation should use a stricter regex (`^[a-zA-Z0-9._-]+$`) and the filename should be RFC-5987-encoded:

```js
const safeName = encodeURIComponent(`${name}-${runId}.log`);
reply.header('Content-Disposition', `attachment; filename*=UTF-8''${safeName}`);
```

**Dependencies:** none.

**Test plan:**
1. `curl -i 'http://localhost:3001/api/containers/..%2F..%2Fetc/runs/foo/log'` (with auth) → expect 422, not a 200 returning `/etc/foo/log`.
2. `curl -i -X DELETE 'http://localhost:3001/api/containers/..%2F..%2Ftmp%2Fpwn'` → expect 422.
3. Round-trip: existing happy-path requests (`GET /api/containers/<real-name>`, log streaming) still work.
4. Fastify route declarations without `:name` (e.g. `GET /api/containers`, `POST /api/containers`, `GET /api/containers/stream`) must not 422.

**Blast radius:** Very low. The preHandler is additive and only rejects malformed names. Any caller that was relying on traversal is by definition exploiting a bug.

**Doc updates:**
- `docs/spec/CONTAINERS.md` — add a brief "Name validation" section if not present, mirroring the VM equivalent.
- `docs/spec/API.md` — if any container route documents accepted name characters, ensure they match `validateContainerName`.

**Changelog:** yes — Bug Fixes: "validate container names on all `/api/containers/:name/*` routes (path-traversal hardening)".

---

## B1.2 — VM create/clone: validate body names + drop `additionalProperties: true`

**Findings:** C1 (Critical), C2 (Critical), M9 (Medium). Amplifies: L1, L4 (snapshot memory file).

**Decision needed:** no — except for the schema length value (see test plan).

**Files involved:**
- `backend/src/routes/vms.js:120-194` (`POST /vms` schema + handler)
- `backend/src/routes/vms.js:478-494` (`POST /vms/:name/clone` schema + handler)
- `backend/src/routes/vms.js:506` (`PATCH /vms/:name` schema)
- `backend/src/lib/linux/vmManager/vmManagerCreate.js:271-345` (`createVM`)
- `backend/src/lib/linux/vmManager/vmManagerCreate.js:399-458` (`cloneVM`)
- `backend/src/lib/validation.js:5` (current limit `VM_NAME_MAX_LEN = 128`)

**Fix:**

1. In the route handlers (or in a new preHandler that runs after the existing `validateVMName(request.params?.name)` one), call `validateVMName(request.body.name)` for `POST /vms` and `validateVMName(request.body.newName)` for `POST /vms/:name/clone`. Map any thrown `INVALID_VM_NAME` to 422.
2. **Defense in depth:** also call `validateVMName(spec.name)` at the top of `createVM` and `validateVMName(newName)` at the top of `cloneVM` so library callers (e.g. future job kinds) are protected too.
3. Set `additionalProperties: false` on:
   - `POST /vms` body schema (line 194)
   - `PATCH /vms/:name` body schema (line 506)
   - `POST /vms/:name/clone` body schema (around line 481)
4. Decide on the canonical name length and align both `validation.js` and the schema's `maxLength`. Audit notes the schema currently caps at 64 while `validateVMName` allows 128 (L1).

**Dependencies:** none (independent of B1.1).

**Test plan:**
1. `curl -X POST /api/vms -d '{"name":"../tmp/pwn", ...}'` → expect 422, no directory created under `/tmp` or `<vmsPath>`.
2. `curl -X POST /api/vms/foo/clone -d '{"newName":"../../tmp/pwn"}'` → expect 422.
3. `curl -X POST /api/vms -d '{"name":"valid", "extraField":"x"}'` → expect 400 (additionalProperties).
4. Happy path: `createVM` with a valid name still works end-to-end (disk created, domain defined, mDNS published).
5. After fix, attempt to send a 100-character valid name. Expect either accepted or rejected consistently between the schema and `validateVMName`.

**Blast radius:** Low. The schema strictening could surface frontend bugs that send extra fields — sweep `frontend/src/api/*` and `frontend/src/store/vmStore.js` for `POST /vms` / clone / patch payloads to confirm they only send declared fields.

**Doc updates:**
- `docs/spec/VM-MANAGEMENT.md` — document name rules (regex + max length) once.
- `docs/spec/API.md` — update the request body shape for `POST /vms`, `POST /vms/:name/clone`, `PATCH /vms/:name`.

**Changelog:** yes — Bug Fixes: "validate VM body names on create/clone routes; reject unknown body fields".

---

## B1.3 — Cloud-init `***` placeholder gets re-hashed as the literal string `***`

**Findings:** S3 (Critical state-sync).

**Decision needed:** no (the fix is mechanical; only the *strategy* below has options A/B — pick the one with smaller blast radius).

**Files involved:**
- `backend/src/lib/linux/vmManager/vmManagerCloudInit.js:30-31` (where `password` is replaced by `'***'` after first save)
- `backend/src/lib/linux/vmManager/vmManagerCloudInit.js:151` (`getCloudInitConfig` → returns `{ password: 'set' }`)
- `backend/src/lib/cloudInit.js:79-82` (where `await hashPassword(config.password)` runs)
- `backend/src/routes/cloudinit.js` (the public surface — unchanged for option A)

**Fix — pick one strategy:**

**Strategy A (preferred — minimal change):** Treat the `'***'` placeholder as "leave password unchanged" inside `generateCloudInitISO`/`generateCloudInit`. Read the previous hashed value from the on-disk `cloud-init.json` (or the previously generated user-data) and re-emit it instead of re-hashing the placeholder.

```js
// backend/src/lib/cloudInit.js — when building user-data
if (config.password && config.password !== '***' && config.password !== 'set') {
  userEntry.passwd = await hashPassword(config.password);
} else if (priorHashedPassword) {
  userEntry.passwd = priorHashedPassword; // preserve from prior save
}
// else: no password line at all
```

The "prior hashed password" needs to come from somewhere. Options:
- Persist `passwordHash` (the openssl-passwd output, not the plain password) to `cloud-init.json` so it can be re-read on update. The plain password never lives on disk, so persisting the hash is acceptable.
- Or read and parse the prior generated `cloud-init.iso` (more brittle).

**Strategy B (cleaner contract):** Stop persisting `'***'` to `cloud-init.json` at all. Persist only fields that are safe to re-read; the password is consumed once and then forgotten by the JSON. The frontend already shows "set"/"not set" as a derived flag; nothing actually requires the placeholder string.

In either case, ensure `getCloudInitConfig` never returns the literal `'***'`, and `updateCloudInit` never feeds `'***'` back into `hashPassword`.

**Dependencies:** none.

**Test plan:**
1. Reproducer: create a VM with a cloud-init password `secret123`. Save once. Edit (e.g. add an SSH key). Save again. Without the fix: VM password becomes literal `***`. With the fix: VM password remains `secret123` (or, if user re-typed a new one, the new one).
2. Verify by booting the VM and logging in via console, or by inspecting the generated cloud-init ISO contents (`isoinfo -i cloud-init.iso -x /USER-DATA.;1` then check the `chpasswd`/`users` block).
3. Ensure `getCloudInitConfig` never returns `'***'` to the frontend.

**Blast radius:** Low — single VM lifecycle. Existing VMs are unaffected (cloud-init only re-applies on first-boot equivalent; see also S3 audit note about cloud-init's `instance-id` semantics).

**Doc updates:**
- `docs/spec/CLOUD-INIT.md` — document the placeholder semantics: password is consumed once, never re-read; subsequent saves preserve unless user supplies a new value.

**Changelog:** yes — Bug Fixes: "preserve cloud-init password across edits (was silently downgrading to literal `***`)".

---

## B1.4 — Pino: redact `req.url` so JWT in `?token=` doesn't reach logs

**Findings:** H4 (High). Related: H8, M11 (token-in-query design).

**Decision needed:** no for the redaction. Yes if you want to follow up with full cookie migration (M1 — that lives in plan 2).

**Files involved:**
- `backend/src/index.js:49` (Fastify constructor)
- `backend/src/lib/auth.js:130-134` (the `?token=` acceptance — leave as-is for now; M11 in plan 2 narrows it)
- `frontend/src/api/sse.js:50,157`, `backend/src/routes/console.js:12`, `backend/src/routes/containerConsole.js:44` (current consumers — no change needed for redaction)

**Fix:**

Configure Pino with a redact path that strips the token from the request URL before the request log line is emitted. There are two equivalent approaches; pick (a) for simplicity:

```js
// (a) custom req serializer
const app = Fastify({
  logger: {
    serializers: {
      req: (req) => {
        const url = req.url ? req.url.replace(/([?&])token=[^&]*/g, '$1token=REDACTED') : req.url;
        return {
          method: req.method,
          url,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  forceCloseConnections: true,
});
```

Or:

```js
// (b) Pino redact paths (string match — less flexible than (a))
const app = Fastify({
  logger: { redact: { paths: ['req.url'], censor: (v) => String(v).replace(/([?&])token=[^&]*/g, '$1token=REDACTED') } },
  forceCloseConnections: true,
});
```

While editing this file, also configure pino-pretty for dev (D2) per the user's global preference:

```js
const isDev = process.env.NODE_ENV === 'development';
const app = Fastify({
  logger: {
    transport: isDev
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', singleLine: true, ignore: 'pid,hostname,reqId,req.host,req.remoteAddress,req.remotePort' } }
      : undefined,
    serializers: { req: ... },
  },
  forceCloseConnections: true,
});
```

Also: `npm i -D pino-pretty` in `backend/package.json` (devDependency only — production should remain plain JSON).

**Dependencies:** none.

**Test plan:**
1. Open SSE in dev (e.g. `/api/vms/stream?token=<jwt>`); verify the request log line writes `token=REDACTED` (not the actual token).
2. WS console connection: verify the upgrade request log line is also redacted.
3. Production: confirm no `pino-pretty` is loaded; logs remain JSON.
4. Boot dev server; confirm log entries are single-line and trimmed of the listed `ignore` fields.

**Blast radius:** Logger is global; mistakes here affect every request. Add a unit test or a simple boot smoke test.

**Doc updates:**
- `docs/spec/AUTH.md` — note that `?token=` is accepted but redacted in logs.
- `docs/TECHSTACK.md` — list `pino-pretty` as a dev-only dependency.

**Changelog:** yes — Bug Fixes: "redact JWT from request URLs in logs"; New Features: "single-line pino-pretty in dev".

---

## B1.5 — `wisp-bridge`: defense-in-depth path scrubbing on `--file-name`

**Findings:** C4 (Critical, latent — current callers safe, but no defense in depth).

**Decision needed:** no.

**Files involved:**
- `backend/scripts/wisp-bridge:139,198` (file write/delete)
- `backend/src/lib/linux/host/hostNetworkBridges.js:124-126` (caller — already constructs safe filenames)

**Fix:**

In `wisp-bridge`, validate `file_name` matches an explicit allowlist regex, and assert the resolved path remains under `/etc/netplan/`. The exact regex must match what `hostNetworkBridges.js` actually constructs — read that file to confirm. Likely something like:

```bash
file_name_re='^91-wisp-vlan__[a-zA-Z0-9._-]+__[0-9]+__[a-zA-Z0-9._-]+\.yaml$'
if ! [[ "${file_name}" =~ $file_name_re ]]; then
  echo "wisp-bridge: invalid --file-name: ${file_name}" >&2
  exit 64
fi
target="${NETPLAN_DIR}/${file_name}"
resolved="$(realpath -m -- "${target}")"
case "${resolved}" in
  "${NETPLAN_DIR}/"*) : ;; # ok, still under /etc/netplan/
  *)
    echo "wisp-bridge: --file-name escapes ${NETPLAN_DIR}: ${resolved}" >&2
    exit 64
    ;;
esac
```

Apply the same checks before both `write_file_atomic` and the delete path.

**Dependencies:** none.

**Test plan:**
1. `sudo wisp-bridge apply --file-name '../cron.d/pwn' ...` → expect non-zero exit and stderr; confirm `/etc/cron.d/pwn` is **not** created.
2. `sudo wisp-bridge apply --file-name '91-wisp-vlan__br0__10__valid.yaml' ...` → still works.
3. Symlink probe: create `/etc/netplan/link -> /etc/cron.d` and pass `--file-name 'link/pwn.yaml'` → `realpath -m` resolves outside `/etc/netplan/` → reject.

**Blast radius:** Helper is privileged; all current callers use safe names so no false rejections expected. If a future caller uses a different naming scheme, the regex must be updated in lockstep.

**Doc updates:**
- `docs/spec/DEPLOYMENT.md` "Privileged helpers checklist" — note the validation contract.

**Changelog:** yes — Bug Fixes: "wisp-bridge: validate --file-name against an allowlist (defense in depth)".

---

## B1.6 — Constrain `mountPath` to a safe prefix (admin → host root primitive)

**Findings:** C5 (Critical).

**Decision needed:** **YES.** Do not implement until the user picks the policy.

**Options to present to the user:**
- **A.** Hard prefix: `mountPath` must be under `/mnt/wisp/` (with `realpath` canonicalization to defeat symlinks). Closest to existing convention.
- **B.** Configurable allowlist: `wisp-config.json` includes a `mountRoots: string[]` field; mounts must be under one of those. More flexible; more setup.
- **C.** Per-mount-kind defaults: SMB under `/mnt/wisp/smb/`, disks under `/mnt/wisp/disks/`. Removes the `mountPath` field from the API surface — `mountPath` becomes `<root>/<id>` derived from the registry.

**Files involved:**
- `backend/src/lib/settings.js:237-243,320-326` (`validateCommonFields`, mount add/update)
- `backend/scripts/wisp-mount:41-47,72-93` (helper that does the actual `mount`)
- `backend/src/routes/mounts.js:41-88,235-272` (route schemas)
- `backend/src/lib/linux/host/smbMount.js`, `backend/src/lib/linux/host/diskMount.js` (callers)

**Fix (assuming option A):**

JS side:
```js
// settings.js — validateCommonFields
const MOUNT_ROOT = '/mnt/wisp';
function assertMountPathUnderRoot(mountPath) {
  const resolved = path.resolve(mountPath);
  if (!resolved.startsWith(MOUNT_ROOT + path.sep) && resolved !== MOUNT_ROOT) {
    throw createAppError('MOUNT_PATH_NOT_ALLOWED', `mountPath must be under ${MOUNT_ROOT}`);
  }
  if (resolved.includes('..')) throw createAppError('MOUNT_PATH_NOT_ALLOWED', 'mountPath contains ..');
}
```

Helper side (defense in depth):
```bash
# wisp-mount — early check
case "$(realpath -m -- "${mountPath}")" in
  /mnt/wisp/*) : ;;
  /mnt/wisp) : ;;
  *) echo "wisp-mount: mountPath must be under /mnt/wisp" >&2; exit 64 ;;
esac
```

**Migration** (per project rules: "feature-building mode, no migrations"): existing configured mounts under non-`/mnt/wisp` paths must be either rewritten by the user or rejected at boot. The audit's project-rules section calls this out — coordinate with the user on whether boot-time rejection is acceptable.

**Dependencies:** none, but coordinate with B1.5 since both touch privileged helpers — same review pass.

**Test plan:**
1. `POST /api/mounts` with `mountPath: "/etc"` → 422.
2. `POST /api/mounts` with `mountPath: "/mnt/wisp/foo/.."` → resolved to `/mnt/wisp` → reject the `..`.
3. Symlink probe: `/mnt/wisp/foo -> /etc`; `mountPath: "/mnt/wisp/foo"` → `realpath -m` resolves outside `/mnt/wisp` → reject.
4. Happy path: `mountPath: "/mnt/wisp/share1"` works end-to-end.

**Blast radius:** Operators with existing mounts outside `/mnt/wisp/` must move them. Surface a clear error on backend boot if any configured mount is non-conformant.

**Doc updates:**
- `docs/spec/STORAGE.md` — document mountPath constraint.
- `docs/spec/CONFIGURATION.md` — note the `/mnt/wisp/` root.
- `scripts/setup-server.sh` — ensure `/mnt/wisp/` is created at install time.

**Changelog:** yes — Bug Fixes: "constrain configured mountPath to /mnt/wisp/ (admin-to-root hardening)".

---

## B1.7 — SSRF hardening: single-resolve, IP-pinned fetch, redirect re-validation, expanded private ranges

**Findings:** H1 (High), H2 (High).

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/downloadFromUrl.js:14-44,89-167` (`assertUrlNotPrivate`, `downloadToLibrary`)
- `backend/src/lib/downloadUtils.js:81-95` (`downloadWithProgress` — currently bypasses the check)
- Callers: `backend/src/lib/downloadHaos.js:52`, `backend/src/lib/downloadUbuntuCloud.js:80`, `backend/src/lib/downloadArchCloud.js`

**Fix:**

1. **Single-resolve + IP-pinned fetch.** Switch from the global `fetch` to an `undici` Agent with a `connect` hook that re-checks the resolved IP against the private-IP set, OR resolve once via `dns.lookup` and pass the resolved IP via `host` header / SNI override. The simpler variant is to use `undici.fetch` with a custom `Agent`:

```js
import { Agent, fetch as undiciFetch, errors as undiciErrors } from 'undici';

function makePrivateIPGuardAgent() {
  return new Agent({
    connect: {
      lookup(hostname, _opts, cb) {
        dns.lookup(hostname, { all: true }, (err, addrs) => {
          if (err) return cb(err);
          for (const a of addrs) {
            if (isPrivateIP(a.address)) {
              return cb(Object.assign(new Error('SSRF_BLOCKED'), { code: 'SSRF_BLOCKED' }));
            }
          }
          // Pick the first non-private; pin to it for the connection.
          const pick = addrs.find((a) => !isPrivateIP(a.address));
          cb(null, pick.address, pick.family);
        });
      },
    },
  });
}
```

Yes, this means a new dep on `undici`. **Note:** `undici` is bundled with Node ≥ 18 (the global `fetch` is `undici` under the hood); importing it directly avoids adding a runtime dep.

2. **Manual redirect handling.** Set `redirect: 'manual'`. On a 30x, parse `Location`, run `assertUrlNotPrivate(newUrl)` against the new URL, then re-fetch. Cap at 5 redirects. Reject on non-HTTP(S) `Location`.

3. **Expand `isPrivateIPv4` to include:**
   - `0.0.0.0/8` (when `a === 0`)
   - `100.64.0.0/10` (CGNAT)
   - `192.0.0.0/24`, `198.18.0.0/15`
   - `224.0.0.0/4` (multicast)
   - `255.255.255.255` exact

4. **Expand `isPrivateIPv6`:**
   - IPv4-mapped (`::ffff:0:0/96`) — extract the IPv4 portion and re-run `isPrivateIPv4`.
   - The current heuristic for `fc00::/7` and `fe80::/10` is OK but tighten: parse properly via `node:net` or a small CIDR helper.

5. **Make `downloadWithProgress` call `assertUrlNotPrivate`** (or use the same IP-pinned agent) and pass `redirect: 'manual'`. The current bypass (audit H2) is the one operationally exploitable today.

**Dependencies:** none.

**Test plan:**
1. DNS rebinding lab: stand up a DNS server that returns `1.2.3.4` to the first `A` query and `127.0.0.1` to the second. Confirm download fails (single-resolve + pin).
2. Redirect lab: `/api/library/download` with a URL that 30x redirects to `http://127.0.0.1/`. With manual redirect, the second `assertUrlNotPrivate` rejects.
3. IPv4-mapped IPv6: pass URL `http://[::ffff:127.0.0.1]/` → reject.
4. CGNAT: URL resolving to `100.64.0.1` → reject.
5. Happy path: a real HTTPS download from `cloud-images.ubuntu.com` still completes.

**Blast radius:** Download paths are well-isolated. Risk is breaking legitimate redirect-chasing for cloud images — keep the redirect cap at 5 and verify Ubuntu/Arch/HAOS download paths still work end-to-end.

**Doc updates:**
- `docs/spec/IMAGE-LIBRARY.md` — document SSRF policy: HTTP/HTTPS only, no private IPs (any redirect target re-checked).
- `docs/TECHSTACK.md` — note `undici` is used directly (still no new prod dep since it ships with Node).

**Changelog:** yes — Bug Fixes: "SSRF hardening: pin DNS resolution, re-validate redirects, expand private IP set".

---

## B1.8 — VM rename and clone: stop deriving paths from a name that can change

**Findings:** S1 (Critical state-sync), S2 (Critical state-sync). Related: S4 (snapshot mem), S5 (deleteVM asymmetric).

**Decision needed:** **YES — strategic choice.** Do not implement until the user picks A or B.

**Options to present to the user:**

- **Option A — Rename the on-disk directory in lockstep.** When `renameVM` runs, also: (1) `mv <vmsPath>/<old>/ <vmsPath>/<new>/`; (2) rewrite every absolute path in the domain XML (`<source file=...>`, NVRAM, USB pkfs, etc.) from old to new; (3) walk `ListDomainSnapshots`, parse each, rewrite `memory @file`, redefine via `SnapshotCreateXML` with `VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE`. For clone, copy disks into `getVMBasePath(newName)` (mkdir first) and emit cloned disk source paths there. Smaller diff; preserves "directory ≈ name" mental model.
- **Option B — Key directories by UUID, decouple from name.** `getVMBasePath` becomes `getVMBasePath(uuid)`. `name` → `uuid` lookup via libvirt. Rename becomes pure metadata; clone targets a new UUID directory. No path rewrites ever. Larger diff, more invasive (every helper that takes `name` and derives a path needs to be inspected), but eliminates this whole class of bugs forever.

The audit recommends **B** for long-term simplicity. The argument for **A** is shorter time-to-fix.

**Files involved (both options):**
- `backend/src/lib/linux/vmManager/vmManagerConfig.js:61` (`renameVM` — calls libvirt `iface.Rename`)
- `backend/src/lib/linux/vmManager/vmManagerCreate.js:399-458` (`cloneVM`)
- `backend/src/lib/linux/vmManager/vmManagerCreate.js:530-547` (`deleteVM` cleanup)
- `backend/src/lib/linux/vmManager/vmManagerSnapshots.js:55-63` (snapshot mem `@file`)
- `backend/src/lib/linux/vmManager/vmManagerCloudInit.js:90,165-171`
- `backend/src/lib/linux/vmManager/vmManagerBackup.js:212,258,313-326,490`
- `backend/src/lib/paths.js:10` (`getVMBasePath`)

**Fix sketch (option A):**

```js
// backend/src/lib/linux/vmManager/vmManagerConfig.js
export async function renameVM(oldName, newName) {
  validateVMName(newName);
  const dom = await lookupByName(oldName);
  await assertOffline(dom);
  // 1. Rename the libvirt domain
  await dom.iface.Rename(newName, 0);
  // 2. Move directory
  const oldDir = getVMBasePath(oldName);
  const newDir = getVMBasePath(newName);
  await fs.rename(oldDir, newDir);
  // 3. Rewrite domain XML disk source paths and NVRAM path
  await rewriteAbsolutePathsInDomainXML(newName, oldDir, newDir);
  // 4. Rewrite snapshot mem files
  await rewriteSnapshotMemoryPaths(newName, oldDir, newDir);
}
```

Use `fast-xml-parser` (`parseDomainRaw`/`buildXml`) for both rewrite steps — never regex. Snapshot rewrite: walk `ListDomainSnapshots`, for each `GetXMLDesc(0)`, parse, replace `<memory file="...">`, `buildXml`, redefine via `SnapshotCreateXML(xml, VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE)`.

**Fix sketch (option B):**
- Add `getVMBasePathByUuid(uuid)` next to the existing function.
- Switch every internal caller to UUID-based paths. The `vmManager` facade resolves name→uuid once.
- Migrate existing on-disk dirs by reading domain XML at boot, computing the UUID, and renaming `<vmsPath>/<name>` → `<vmsPath>/<uuid>`. This is a real migration; coordinate with the user given "feature-building, no migrations" mode.

**Dependencies:** none for option A. Option B should be done before any other path-derived feature lands.

**Test plan:**
1. Create `vm-old`, write a snapshot (with memory state), backup, take a screenshot, attach a CDROM. Rename to `vm-new`.
2. Verify: `<vmsPath>/vm-new/` exists, `<vmsPath>/vm-old/` does not. `disk0.qcow2`, `cloud-init.iso`, `VARS.fd`, `snapshots/*.mem` all in the new dir.
3. Domain XML disk `<source>` points at `<vmsPath>/vm-new/disk0.qcow2`.
4. `virsh snapshot-list vm-new` shows the snapshot; revert succeeds.
5. Delete `vm-new` with `deleteDisks=true`; directory is gone.
6. Clone test: clone `vm-new` → `vm-clone`. Verify `<vmsPath>/vm-clone/` exists with disks; `<vmsPath>/vm-new/` no longer contains stray files.

**Blast radius:** Very high — touches the most-cited file in the audit (`vmManagerCreate.js`). Run the full VM lifecycle test suite (create, start, stop, snapshot, revert, backup, restore, clone, rename, delete) before merging.

**Doc updates:**
- `docs/spec/VM-MANAGEMENT.md` — document the new rename/clone semantics; if option B, document UUID-keyed paths.
- `docs/ARCHITECTURE.md` — update the VM data-flow section.

**Changelog:** yes — Bug Fixes: "VM rename now relocates the on-disk directory and rewrites snapshot/disk paths" and "VM clone now stores disks in the cloned VM's directory".

---

## B1.9 — Cloud-init YAML emission: switch from template literals to a YAML library (or strict whitelist)

**Findings:** H5 (High). Related: M2 (don't allow plaintext-equivalent).

**Decision needed:** no.

**Files involved:**
- `backend/src/lib/cloudInit.js:51-103` (template-literal YAML emission)
- `backend/src/routes/cloudinit.js:48-63` (input schema; expand the regex)

**Fix:**

Two layers:
1. **Input validation in the route schema.** Reject `\n`, `\r`, and non-printable in `hostname`, `username`, `sshKey` items. Length-limit each. Add a regex per field:
   - `hostname`: `^[a-zA-Z0-9-]{1,63}$` (matches RFC 1123 label).
   - `username`: `^[a-z][a-z0-9_-]{0,31}$`.
   - `sshKey` items: each one a single line, `\n`/`\r` rejected.
2. **Emit YAML via a real YAML library, not template literals.** Use `js-yaml` (small, mature) — yes, this adds a dep, but the audit calls out template-literal YAML as fundamentally unsafe and a small custom emitter is non-trivial to get right. Justify the new dep in the PR description.

```js
import yaml from 'js-yaml';

const userData = {
  '#cloud-config': null, // emitted as a top-of-file comment, not a key
  hostname: config.hostname || vmName,
  users: [{
    name: userEntry.name,
    sudo: 'ALL=(ALL) NOPASSWD:ALL',
    shell: '/bin/bash',
    ssh_authorized_keys: keys,
    ...(userEntry.passwd ? { passwd: userEntry.passwd, lock_passwd: false } : {}),
  }],
  // ...
};
const yamlBody = '#cloud-config\n' + yaml.dump(userData, { lineWidth: -1, noRefs: true });
```

If a new dep is undesirable, alternative: a small inline emitter that quotes every scalar (`JSON.stringify`-style) and never interpolates raw user input. Comment heavily.

**Dependencies:** none.

**Test plan:**
1. Inject test: `hostname = "x\nruncmd:\n  - echo pwn"` → expect 422 at the route (regex rejects `\n`).
2. Quoted-scalar test: `username = "evil\"key"` (assuming the regex allowed it) → confirm the YAML emits a properly escaped scalar; cloud-init parses it and uses the literal name.
3. Boot a VM with normal cloud-init config; verify `runcmd`/`packages` are not present unless the operator added them.
4. Round-trip: save → reload → save again. Confirm no semantic drift.

**Blast radius:** Medium — every new VM with cloud-init exercises this path. Run the full cloud-init create test (Ubuntu cloud image is the canonical target).

**Doc updates:**
- `docs/spec/CLOUD-INIT.md` — document field constraints (hostname / username / sshKey).
- `docs/TECHSTACK.md` — list `js-yaml` if added.

**Changelog:** yes — Bug Fixes: "cloud-init YAML emitted via parser, not template literals (injection hardening)".

---

## B1.10 — Atomic JSON writes + on-startup partial-artifact cleanup

**Findings:** S6 (High state-sync), S7 (High state-sync).

**Decision needed:** no.

**Files involved:**

JSON writes:
- `backend/src/lib/linux/containerManager/containerManagerConfigIo.js:25-29` (`container.json`)
- `backend/src/lib/settings.js:226` (`wisp-config.json`)
- `backend/src/lib/linux/containerManager/containerManagerImages.js:24-62` (`oci-image-meta.json`)

Boot cleanup:
- `backend/src/index.js` (start-up sequence — add a cleanup pass before `app.listen`)
- `backend/src/lib/jobStore.js`, all `*JobStore.js` (in-memory only — no on-disk to clean)
- `backend/src/lib/paths.js` (image dir, vmsPath, containersPath)

**Fix:**

1. Add a shared helper `writeJsonAtomic(path, obj)` (e.g. in `lib/atomicJson.js` or alongside `paths.js`):

```js
import { writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function writeJsonAtomic(filePath, obj, spaces = 2) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(obj, null, spaces), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, filePath); // atomic on the same filesystem
}
```

Replace the three call sites listed above with `writeJsonAtomic`. **Important:** keep the existing file modes intact — `wisp-password` is mode 0600; check if any of these JSON files have explicit modes and preserve them.

2. **Startup partial-artifact cleanup.** Before `app.listen`, scan and remove orphans. Conservative cleanup only — never delete anything that could be in-flight from the previous run unless we're certain:

```js
async function cleanPartialArtifacts(log) {
  // Image library: *.tmp.* files
  const dir = await ensureImageDir();
  for (const f of await readdir(dir)) {
    if (/\.tmp\.\d+\.\d+$/.test(f)) {
      await unlink(path.join(dir, f)).catch(() => {});
      log.warn({ f }, 'Removed partial download artifact');
    }
  }
  // VM dirs: defined-but-disk-missing → leave for the user to inspect
  // Container dirs: container.json corrupt → log and leave for the user
}
```

Be conservative: only remove things we know we created (`.tmp.*` suffix from `writeJsonAtomic`, half-streamed downloads from `findUniqueFilename` if they have a recognizable suffix). Do **not** touch arbitrary user data.

3. While here, **fix the settings.js read-modify-write race (S13)** in the same change since it's right next to the write path: move `readSettingsFile()` *inside* the `writeLock = writeLock.then(...)` lambda so each update reads the latest persisted state.

**Dependencies:** B1.10 should land before any new feature that writes JSON config — that includes any other plan items that touch container config or settings.

**Test plan:**
1. `kill -9` the backend mid-write (simulate crash after `writeFile` but before `rename`): confirm the tmp file exists, the original is intact, restart succeeds.
2. Drop a `.tmp.123.456` file in `imagePath`; restart backend; confirm cleanup logs and removes it.
3. Concurrent `PATCH /api/settings` from two clients: confirm the second write does not clobber the first (read inside the lock).
4. `container.json` round-trip: write → kill backend mid-`writeFile` (via `strace` or fault injection) → confirm the original `container.json` is still readable.

**Blast radius:** All three JSON files are read constantly. A bug in `writeJsonAtomic` corrupts everything. Add a minimal unit test (write a small object, verify the tmp file is gone after `rename`, and the destination contents match).

**Doc updates:**
- `docs/ARCHITECTURE.md` — note the atomic write contract.
- `docs/spec/CONFIGURATION.md` — note that config files are written atomically.

**Changelog:** yes — Bug Fixes: "atomic JSON writes for container.json, wisp-config.json, oci-image-meta.json"; "fix settings.js read-modify-write race"; "cleanup partial download artifacts at startup".

---

## Cross-bundle ordering recommendation

Bundles in this plan are mostly independent. Suggested merge order to minimize rebase pain:

1. **B1.1** (container preHandler) — small, isolated.
2. **B1.2** (VM body name validation) — small, isolated.
3. **B1.4** (Pino redact + pino-pretty) — touches `index.js` only.
4. **B1.10** (atomic JSON writes + boot cleanup) — touches `index.js` and several lib files; do before any other config-writing feature.
5. **B1.5** (`wisp-bridge`) — script-only.
6. **B1.7** (SSRF) — touches downloads only.
7. **B1.3** (cloud-init `***`) — touches cloud-init lifecycle.
8. **B1.9** (cloud-init YAML library) — touches cloud-init emission. Do after B1.3 to avoid two passes over the same files.
9. **B1.6** (mountPath allowlist) — DECISION; touches mount registry + helper.
10. **B1.8** (VM rename/clone) — DECISION; largest blast radius; do last.

Each bundle should land as its own PR with its own changelog entry and doc updates.
