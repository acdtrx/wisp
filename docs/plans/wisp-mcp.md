# Wisp MCP — Agent Access (API Tokens + MCP Server)

Make a Wisp deployment inspectable — and eventually drivable — by coding agents (Claude Code and other MCP clients). Two layers, built in order: **scoped bearer tokens** as the non-interactive auth prerequisite, then a **native MCP endpoint** with comprehension-shaped tools.

## Goal

1. An agent can authenticate non-interactively with a revocable, scoped token instead of the master password + cookie/CSRF dance.
2. An agent registered once (`claude mcp add --transport http wisp https://wisp.anapana.trixbits.ro/mcp --header "Authorization: Bearer <token>"`) can answer "what runs on this host, on which IPs/names, how services are exposed, what hardware is this" in a handful of tool calls — no API docs in context. Exposure is answered generically: list containers, then read each proxy app container's masked `appConfig` via `get_container`.
3. (Phase 2) An admin-scoped agent can deploy, update, and lifecycle a container from an image ref.

## Non-goals

- **No multi-user accounts or roles.** Tokens are credentials for the single user; `scope` is capability, not identity.
- **No third-party MCP SDK.** Hand-rolled minimal streamable-HTTP server (tools-only, stateless) — consistent with the no-JWT-lib / no-OIDC-lib precedent and the minimal-dependencies rule. If we later need resources/prompts/sessions, revisit.
- **No console/shell exposure to tokens or MCP.** The WS routes (VNC, container exec) stay cookie-session only. No MCP tool ever returns a shell.
- **No app-template-specific tools.** More than one instance of an app can be deployed (e.g. several Caddy containers), so no tool may assume a singleton or bake in per-app logic. App containers are inspected generically — `get_container` returns `metadata.app` plus the masked `appConfig`. Dedicated app tools (exposure maps, Caddy host editing, appConfig patching) are a later decision.
- **No webhooks, no OpenAPI generation.** MCP tool schemas are the machine-readable surface.
- **No VM mutations via MCP** in phase 2 (containers + Caddy only). No `delete_container` tool — destructive deletes stay in the UI.
- **No changes to the existing cookie/CSRF session model** for the SPA.

## Status

- **Current step:** Step 2 — MCP endpoint + read-only tools (next).
- **Completed:** Step 1 (2026-07-10) — scoped API tokens (lib/apiTokens.js, bearer branch in the auth hook, shared lib/loginRateLimit.js, /api/auth/tokens routes, ApiTokensSettings UI card, docs).

## Steps overview

| # | Title | Why | Commit |
|---|-------|-----|--------|
| 1 | Scoped API tokens | Non-interactive auth is the prerequisite for any agent surface; also makes plain REST curl-able. | one |
| 2 | MCP endpoint + read-only tools | The agent-facing layer: 7 read tools incl. host hardware. | one |
| 3 | Admin tools (deploy / lifecycle) | Mutating surface, gated on `admin` scope, shipped once read layer is proven. | one |

---

## Step 1 — Scoped API tokens

### Storage

New `apiTokens` array in `config/wisp-config.json` (already `0600`, atomic writes, settings mutex, preserved by the updater's `RSYNC_EXCLUDES` — **no updater changes needed**):

```jsonc
"apiTokens": [
  { "id": "<uuid>", "label": "claude-code", "scope": "read",  // or "admin"
    "tokenHash": "<sha256 hex of full token string>", "createdAt": "<iso>" }
]
```

Token string minted as `wisp_<scope>_<base64url(32 random bytes)>` — the scope in the prefix is cosmetic (human/agent readability); the stored record is authoritative. Plaintext is shown **once** at creation and never stored; verification hashes the presented token (SHA-256) and `timingSafeEqual`s against each entry. No `lastUsedAt` (avoids config write churn; wisp philosophy — fewer knobs).

### Backend

- New flat glue file `backend/src/lib/apiTokens.js` (auth.js stays JWT/password-focused): `createApiToken(label, scope)`, `verifyApiToken(token)` → `{ id, label, scope } | null`, `revokeApiToken(id)`, `listApiTokens()`. Persists via the settings lib (`withSettingsWriteLock`).
- `createAuthHook()` in `backend/src/lib/auth.js`:
  - If `Authorization: Bearer wisp_…` is present on an `/api` request → `verifyApiToken`; on success set `request.user = { via: 'token', tokenId, scope }` and **skip the CSRF check** (double-submit is a cookie-world defence; bearer requests carry no ambient credential).
  - **Scope enforcement:** `read` → only `GET`/`HEAD`; anything else returns `403 { error: 'Insufficient scope', detail }`. `admin` → all methods.
  - **Bearer denied** on `/ws/*` (consoles stay cookie-only) and on all `/api/auth/*` routes (login, logout, change-password, and token management are interactive concerns — an admin token cannot mint or revoke tokens).
  - Invalid bearer attempts feed the same per-IP rate-limit map as failed logins.
- Routes in `backend/src/routes/auth.js` (cookie-session only):
  - `GET /api/auth/tokens` → `[{ id, label, scope, createdAt }]`
  - `POST /api/auth/tokens` `{ label, scope }` → `201 { id, token }` (plaintext, once)
  - `DELETE /api/auth/tokens/:id` → `204`
- Password change does **not** revoke API tokens (independent credentials, deliberately — rotating the login password shouldn't break agents; revoke explicitly instead).

### Frontend

Host → App Config → new **API Tokens** `SectionCard` (below Single sign-on). Row list (label, scope, created), `headerAction` Plus opens a create dialog (label + scope radio), success state shows the token once with a copy button and a "this will not be shown again" note. Row delete is icon-only with confirm. Row-scoped persistence per `UI-PATTERNS.md`.

### Docs

`docs/spec/AUTH.md` (new "API tokens" section: format, scopes, CSRF exemption, denied surfaces), `docs/spec/CONFIGURATION.md` (schema row), `docs/spec/API.md` (token routes + bearer auth note), `docs/spec/UI.md`.

---

## Step 2 — MCP endpoint + read-only tools

### Server

- `backend/src/lib/mcp/mcpServer.js` — minimal JSON-RPC 2.0 dispatch over **streamable HTTP in stateless, single-JSON-response mode** (the spec permits `application/json` responses; no SSE stream, no session ids). Methods: `initialize` (protocolVersion `2025-06-18`, `capabilities: { tools: {} }`, `serverInfo: { name: 'wisp', version }`, `instructions` — a short paragraph naming the server and what the tools cover), `notifications/initialized` (accept, 202), `ping`, `tools/list`, `tools/call`. Unknown methods → JSON-RPC `-32601`.
- `backend/src/lib/mcp/tools/` — one file per domain (`overviewTools.js`, `containerTools.js`, `vmTools.js`, `hostTools.js`), each tool `{ name, title, description, inputSchema, scope, handler }`. Handlers call the **same facades and glue the routes call** (`containerManager`, `vmManager`, `lib/host`, `lib/containerApps`, settings) — the MCP layer is app-glue, flat under `lib/`, and must respect the strict-manager import rules. Secrets ride the existing masking (`maskSecrets`, settings masking); no tool output may contain a secret.
- `backend/src/routes/mcp.js` — `POST /mcp`; `GET`/`DELETE /mcp` → 405. Tool handler errors map to a `tools/call` result with `isError: true` and the standard `{ error, detail }` as text; every success returns `structuredContent` (JSON) plus a stringified `text` block for clients that only render text.
- Auth hook: extend the gate to `/mcp` — **bearer only** (cookies ignored entirely, which also makes the endpoint CSRF-irrelevant); missing/invalid → `401` with `WWW-Authenticate: Bearer`. `tools/list` returns only the tools the token's scope can call.
- Dev note: on darwin the manager facades are stubs, so `/mcp` runs in dev with stub data; Vite doesn't proxy `/mcp` (MCP clients hit the backend port directly).

### Phase-1 tools (all `scope: 'read'`)

| Tool | Input | Returns |
|------|-------|---------|
| `get_deployment_overview` | — | wisp version, hostname/serverName, bridges, sections; containers `[{ name, state, image, ip, mdnsName, app, autostart }]`; VMs `[{ name, state, vcpus, memoryMiB, ips }]` |
| `get_container` | `{ name }` | full container detail as the REST GET returns it (env with secrets masked, mounts, network, restartPolicy, limits, state, ip) — **including `metadata.app` and the full masked `appConfig`**, which is how an agent reads any app's configuration (e.g. a Caddy container's `{ domain, hosts: [{ subdomain, target }] }` answers "what is exposed and where does it route") |
| `get_vm` | `{ name }` | VM config + state (disks, NICs, cloud-init summary, snapshots list) |
| `get_container_logs` | `{ name, lines? = 100 }` | tail of the latest run log |
| `list_images` | — | images in the `wisp` containerd namespace with digests + `updateAvailable` flags |
| `get_host_stats` | — | one-shot snapshot from the stats collector (CPU, memory, disks, network, thermals) — snapshot, not stream; agents don't consume SSE |
| `get_host_hardware` | — | `getHostHardwareInfo()` from the `lib/host` facade — CPU model/topology (P/E cores), RAM modules, disks + SMART summary, PCI devices, GPUs |

### Docs

New `docs/spec/MCP.md` (protocol subset, auth, tool catalogue with schemas, client registration examples incl. Claude Code). Update `docs/ARCHITECTURE.md` (module + request flow), `docs/spec/API.md` (`/mcp` route), `docs/spec/AUTH.md` (bearer-only endpoint), `README.md` feature bullet. Per `CLAUDE.md` § Kora Memory Sync, update the kora documents when this ships.

### Verification

`curl` the JSON-RPC handshake (`initialize` → `tools/list` → `tools/call get_deployment_overview`) against dev; then `claude mcp add --transport http wisp http://<host>:8080/mcp --header "Authorization: Bearer <token>"` and drive it from a real session; finally through Caddy at `https://wisp.anapana.trixbits.ro/mcp`.

---

## Step 3 — Admin tools (`scope: 'admin'`)

| Tool | Input | Behaviour |
|------|-------|-----------|
| `deploy_container` | `{ name, image, env?, autostart?, restartPolicy?, memoryLimitMiB?, cpuLimit? }` | Create a new generic container (same path as `POST /api/containers`), then start it. Rejects if the name exists. |
| `update_container_image` | `{ name, image? }` | Point an existing container at a new ref (or re-pull the current tag), restart — rootfs re-prepared picks up the new digest. |
| `start_container` / `stop_container` / `restart_container` | `{ name }` | Lifecycle, same lib calls as the routes. |
| `check_image_updates` | — | Trigger the digest check, return the flags. |

Notes: no VM mutations, no deletes, no mount/file editing, and no appConfig writes in this phase (per the no-app-specific-tools non-goal — app configuration changes happen in the UI). Container create via MCP is intentionally a **simple** shape (image + env + limits); anything richer (app templates, storage mounts) is done in the UI. Errors surface as `{ error, detail }` tool errors, same mapping as routes.

---

## Security summary

- Tokens: hashed at rest (SHA-256, `0600` config file), shown once, revocable, scoped, never logged; invalid attempts rate-limited per IP.
- `read` scope is truly read-only (method-gated at the hook, before any handler) and cannot reach consoles or auth/token management.
- `/mcp` never accepts cookies → no CSRF surface; bearer required on every call.
- All tool output goes through the existing secret-masking paths; the Cloudflare token, OIDC/zot secrets, SMB passwords, and env secrets are never returned.
- TLS via the existing Caddy front (`wisp.anapana.trixbits.ro`); tokens never appear in URLs.
