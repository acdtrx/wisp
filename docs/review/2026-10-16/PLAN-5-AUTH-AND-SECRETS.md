# Fix Plan 5 — Per-route auth and secret file mounts

**Audit:** [`AUDIT.md`](AUDIT.md) (A1, A3). **Created:** 2026-10-16, after the user reviewed the
Phase 1 fixes. Conventions: see [`PLAN-1-SECURITY.md`](PLAN-1-SECURITY.md) § Shared conventions.
Builds on `fix/audit-final`.

**Why:** the Phase 1 fixes closed the reported holes but kept the shape that produced them:
- A1's fix still decides "needs auth" from a URL — the matched route pattern instead of the raw
  URL. Protection depends on where a route sits in the URL tree, not on the route.
- A3's fix special-cases app containers; a secret a user keeps in a generic container's file mount
  is still readable by a read-scoped token.

---

## P5.1 — Auth declared per route, enforced by one hook, fail closed

**Decision (user, settled 2026-10-16):** each route declares its access in its own definition;
one hook enforces only that declaration; a route that declares nothing is admin-only.
Rejected: an explicit `requireAuth()` call in each handler (a forgotten call leaves the route open),
protection by plugin registration scope (easy to break in a refactor), and any URL/prefix test.

**Access levels** (`config: { auth: <level> }` on the route options):
| Level | Who may call |
|---|---|
| `public` | anyone (login, OIDC status/login/callback, static assets + SPA shell) |
| `session` | browser session only — tokens refused (all `/api/auth/*` except public ones, `/ws` consoles/VNC) |
| `read` | session, or a token of any scope (safe GETs that expose no secrets) |
| `admin` | session, or an admin-scoped token (**default when undeclared**) |
| `mcp` | bearer token only, per-tool scope in the MCP layer (`/mcp`) |

CSRF double-submit stays a property of cookie auth on state-changing methods.

**Steps:**
1. `lib/auth.js`: the hook reads `request.routeOptions.config?.auth`, never the URL. Unmatched
   requests (no route) carry no handler and need no decision — they go to the not-found handler.
   Remove `PUBLIC_ROUTES`, `routePath`'s auth use, `READ_ONLY_METHODS`-based scope inference.
2. Declare `auth` on every route (all `routes/*.js`, `mcp.js`, static/SPA registration). Read
   scope becomes an explicit per-route choice; review each GET for secret exposure (MCP.md's
   read-token promise is the contract).
3. Startup check: after `app.ready()`, enumerate routes (`onRoute` hook collecting
   `{method, url, auth}`); in development, refuse to boot if any route lacks an explicit `auth`
   (production still fails closed to admin). A script (`npm run route-access`) prints the table.
4. Docs: AUTH.md gets the level table + the per-route rule (settled); API.md marks each endpoint's
   level; MCP.md read-token contract.

**Acceptance:** every route has an explicit level (startup check passes); the encoded-path probes
from Phase 1 (`/%61pi/…`, `/%77s/…`) still 401; a read token gets 403 on every `admin` and
`session` route and 200 on `read` routes; `/mcp` unchanged; SPA + assets public; an undeclared
test route answers 401/403 in production mode and blocks boot in development.

---

## P5.2 — Secret file mounts (write-only, like secret env vars)

**Decision (user, settled 2026-10-16):** a file mount can be marked `secret: true`. Its content is
write-only for every caller (session or token): never returned by the content route, shown in the
UI as set / not set with replace and clear actions — the same model as secret env vars. Apps mark
their own secret files (tiny-samba passwords, zot `session-keys`, `htpasswd`). App-generated files
stay **write-protected** (`APP_CONFIG_ONLY`) because the app regenerates them; non-secret app files
(e.g. Caddyfile) become readable again. Backups include secret mounts, as they include secret env.

**Steps:**
1. containerManager: `secret` on file mounts (validation, persistence, list/detail payload
   `secret` + `isSet`/size-only metadata); `getMountFileTextContent` refuses secret mounts.
2. Route guard: replace the read half of `assertMountNotAppManaged` with the secret rule; keep the
   app-managed write refusal.
3. containerApps: tiny-samba, zot (and any other app writing secrets) declare those mounts secret.
4. Frontend: mount editor gets a Secret toggle for file mounts; secret rows show set/not set with
   replace/clear, never fetch content (follow the env-var secret pattern in UI-PATTERNS.md).
5. MCP: `get_container` shows `secret` on mounts; no content path.
6. Docs: CONTAINERS.md, CUSTOM-APPS.md, API.md, MCP.md, UI-PATTERNS.md.

**Acceptance:** generic container with a secret file mount → content GET refused for session and
tokens, PUT/upload work, UI shows set/not set; tiny-samba/zot secret files refused, Caddyfile
readable but not writable; existing app containers pick up the secret marking on their next app
save or on startup derivation (no migration code — state the manual step if one is needed).

---

## Verification

darwin dev stack for both (routes, tokens, UI); tini for container mounts + an app container.
