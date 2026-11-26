# Authentication

Wisp uses single-user JWT authentication carried in **HttpOnly cookies**. There is one password for the entire application — no user accounts, roles, or multi-user support.

## Login Flow

1. User navigates to the app. If no `wisp_csrf` cookie is present, the SPA redirects to `/login`.
2. User enters the password and submits.
3. Frontend sends `POST /api/auth/login` with `{ password }` and `credentials: 'include'`.
4. Backend verifies the password using timing-safe comparison.
5. On success, backend sets two cookies and returns `{ ok: true }`:
   - **`wisp_session`** — the JWT itself. `HttpOnly` (JS cannot read it), `SameSite=Lax`, `Path=/`, `Max-Age=604800` (7 days, refreshed while in use — see § Token lifetime). `Secure` is set when the request scheme is HTTPS (derived from `request.protocol`, which honors `X-Forwarded-Proto` from loopback proxies via `trustProxy`). On plain-HTTP LAN deployments the flag is omitted — browsers silently discard `Secure` cookies received over HTTP for non-`localhost` origins, which would otherwise leave the user stuck on the login page.
   - **`wisp_csrf`** — a per-session random 32-byte token used for double-submit CSRF defence. Same attributes as the session cookie except **not** `HttpOnly` (JS reads it to echo on state-changing requests).
6. Frontend has nothing to store; subsequent requests automatically carry both cookies.
7. On failure, backend returns 401 `LOGIN_FAILED`.

## CSRF protection

`SameSite=Lax` already blocks the simple cross-site form-submission CSRF cases, but Wisp also enforces double-submit:

- Frontend reads the `wisp_csrf` cookie value (non-HttpOnly) and sends it as `X-CSRF-Token` on every **POST/PUT/PATCH/DELETE**.
- Backend's auth hook compares the header to the cookie via `timingSafeEqual`; mismatch returns **403** `CSRF_FAILED`.
- GETs (including SSE streams and the WebSocket upgrade handshake) skip the CSRF check — they don't mutate state, and `SameSite=Lax` keeps the session cookie from leaking to cross-site GETs in any meaningful way.

## Password Storage

**`config/wisp-password`** (mode `0600`; beside the config file, which only development and tests move: [CONFIGURATION.md → Password Storage](CONFIGURATION.md#password-storage)) holds a **scrypt hash** in the form `scrypt:<salt_hex>:<key_hex>` (written by install, `wispctl password`, and change-password).

If the file is missing, JWT signing fails until a password is set (`wispctl password` or install). There is no `WISP_PASSWORD` env fallback. If the file exists but is not in the expected scrypt form, or can't be read, the backend refuses to start (settled 2026-11-12) — run `wispctl password` to repair. The file is read on each use, not cached, so `wispctl password` applies without a restart; one broken while Wisp runs answers 503 (`PASSWORD_FILE_UNSUPPORTED_FORMAT` / `PASSWORD_FILE_UNREADABLE`).

### Password change

- `POST /api/auth/change-password` with `{ currentPassword, newPassword }`
- On success, writes a new **scrypt hash** to `config/wisp-password` with mode `0600`
- Returns 204 (no content). Changing the password invalidates all existing tokens because the signing secret is derived from the password (or the new hash).
- A wrong `currentPassword` returns **422 `INVALID_PASSWORD`**, shown inline in the form, and counts against the per-IP failed-attempt window (§ Login Rate Limiting); once it is exhausted the route answers **429** `RATE_LIMITED` before checking. Not 401: the session is valid, and a 401 would log every tab out (see § Frontend handling).

## JWT Implementation

JWT is implemented using Node.js `crypto` built-ins — no third-party JWT library.

### Token structure

Standard JWT with three base64url-encoded segments: `header.payload.signature`

- **Header:** `{ "alg": "HS256", "typ": "JWT" }`
- **Payload:** `{ "iat": <unix-seconds>, "exp": <unix-seconds> }`
- **Signature:** HMAC-SHA256 of `header.payload` using a secret derived from the password

### Secret derivation

The signing secret is the stored scrypt-derived key (64 bytes). Changing the password writes a new hash and so changes the signing secret, invalidating all existing tokens.

### Token lifetime

**Sliding 7-day session (settled 2026-10-30).** Tokens and both cookies carry a 7-day lifetime (604800 seconds). The auth hook re-issues them on any cookie-authenticated request once the token is more than an hour old: a fresh JWT plus both cookies with a new `Max-Age`, keeping the existing CSRF value so other tabs' in-flight requests still match. The session therefore lapses only after 7 days with no authenticated request (give or take the hour), and the re-signing cost is paid at most hourly.

There is no separate refresh token — the session cookie is its own refresh credential. It is not a fixed lifetime, which would log the single user out while actively using the app. When a route handler sets the cookies itself (change-password, logout), its `Set-Cookie` headers come after the hook's, and browsers apply the last one.

### Verification

The header must carry `alg === 'HS256'` — any other value (including `none`) is rejected before verification, so a future asymmetric branch can't be tricked via alg-confusion. Signatures are compared in constant time, and `exp` is checked against the current time.

## Route Protection

### Route access levels

**Rule (settled 2026-10-16):** authorization is a property of each route, not of its URL. Every route declares its level in its own options — `config: { auth: '<level>' }` — and one global `onRequest` hook enforces only that declaration. The hook never tests the URL, a prefix, or the HTTP method. A route that declares nothing, or an unknown level, is enforced as **`admin`** (fail closed).

| Level | Who may call | Used for |
|-------|--------------|----------|
| `public` | anyone | `POST /api/auth/login`, the three OIDC routes, the CLI's downloads (`/api/cli`, [CLI.md](CLI.md#getting-it)), static assets + SPA shell |
| `session` | browser session only — API tokens get **403** `SESSION_REQUIRED` | the rest of `/api/auth/*` (logout, change-password, token management), `PATCH /api/settings/oidc`, the `/ws` consoles |
| `read` | session, or an API token of any scope | GETs whose response carries no secret material (lists, masked details, stats/progress/log streams) |
| `agent` | session, or an `agent`- or `admin`-scoped API token; a `read` token gets **403** `SCOPE_INSUFFICIENT` | what building, running and updating a container takes ([§ The `agent` scope](#the-agent-scope)): create, lifecycle, config, the mounts kept on this host and their content, services, a container's backup, the image update check |
| `admin` | session, or an `admin`-scoped API token; a `read` or `agent` token gets **403** `SCOPE_INSUFFICIENT` | every other mutation, plus GETs that make outbound requests |
| `mcp` | API token only (any scope) — cookies ignored; per-tool scope in the MCP layer | `/mcp` |

CSRF double-submit is a property of cookie auth on state-changing methods, independent of the level (see § CSRF protection).

`read` is a deliberate per-route choice, governed by the read-token contract in [MCP.md](MCP.md) § Authentication: a read token must not recover a secret. A GET whose response could carry one is above `read`: `GET /api/containers/:name/mounts/:mountName/content` (raw file content) is `agent`. A GET that is an action rather than a read is `admin`: `GET /api/library/check-url` makes an outbound request on demand. The `API-*.md` area files tag every endpoint with its level; `npm run route-access` prints the live table (method, URL, level), exiting non-zero if any route is undeclared.

**Startup check.** An `onRoute` hook records every route; once the app is ready, **development refuses to boot** while any route lacks a valid declaration, listing them. Production enforces such a route as `admin` and logs a warning per route. Third-party plugins that register their own routes — the dev CORS preflight and `@fastify/static` — have the routes they add while they load marked `public`, and nothing else falls in that window.

**Unmatched requests.** A request that matches no route runs no handler, so the hook has nothing to authorize and the not-found handler answers: a JSON 404 `ROUTE_NOT_FOUND` for API-looking paths, the SPA shell otherwise (production). Because the decision is the matched route's declaration, percent-encoding cannot change it — `/%61pi/vms` dispatches to `/api/vms` and gets exactly its level.

### Token extraction

For browser sessions, the auth hook extracts the JWT from the `wisp_session` cookie. There is **no** bearer or `?token=…` path for the session JWT — the browser sends the cookie automatically on every same-origin request (HTTP, SSE via fetch, WebSocket upgrade, link clicks for the run-log download), so no custom client code is needed to forward it.

When a request carries an `Authorization: Bearer …` header instead, the hook takes the **API token** path (see § API tokens below) and never falls through to the cookie flow.

### Rejection

If no token is found or the token is invalid/expired, the hook short-circuits the request with:

```json
401 { "error": "AUTH_REQUIRED", "detail": "..." }
```

or:

```json
401 { "error": "AUTH_INVALID", "detail": "..." }
```

### Frontend handling

The frontend fetch wrapper sends `credentials: 'include'` on every request, reads the `wisp_csrf` cookie via `document.cookie`, and echoes it as `X-CSRF-Token` on state-changing methods. It recognises a lost session by
its code, `AUTH_REQUIRED` or `AUTH_INVALID` (both 401), on the REST calls, the uploads and
the streams alike. On one:

1. Writes a `wisp_logout` flag to localStorage so other tabs see the logout
2. Leaves the error's text for the login page, which shows it once
3. Redirects to `/login`

A 401 with another code (none is sent today) does not log out. **401 is reserved for "no or
expired session"** on every route the client calls. A route that rejects the request itself while the session is fine answers with another status (change-password's wrong current password → 422). The login route's 401 for a wrong password is the exception that stays: the login page posts with a bare `fetch`, outside the shared client.

`POST /api/auth/logout` clears both cookies and returns 204. The frontend calls it before broadcasting the multi-tab signal, then the tab lands on **`/login?sso=signedout`** — the marker keeps the login page from auto-redirecting to the SSO provider, which with a live provider session would sign the user straight back in.

**Multi-tab logout.** Logout in one tab writes a `wisp_logout` localStorage entry carrying the reason (`signedout` for a deliberate sign-out, `expired` for a lost session: `AUTH_REQUIRED` or `AUTH_INVALID`). Every other open tab subscribes to the `storage` event and bounces on that key change — to `/login?sso=signedout` for a sign-out (so no tab SSO-signs back in), to plain `/login` for an expired session. A tab already on the login page stays put. The session cookie itself is shared across tabs (same browser profile, same origin), so any tab that tries an authenticated request after logout also gets `AUTH_REQUIRED` and redirects.

**Password change closes live connections.** `POST /api/auth/change-password` writes the new hash, closes every SSE stream and WebSocket, then re-issues a fresh `wisp_session` and `wisp_csrf` against the new secret so the user who just changed their password isn't immediately bounced. Pre-rotation tokens can no longer keep streaming on connections that were authed before the secret changed.

## API tokens

Scoped bearer tokens let non-interactive clients (coding agents, scripts, MCP clients) call the REST API without the password + cookie + CSRF dance. They are managed in **Host → App Config → API tokens**.

### Format and storage

- Token string: `wisp_<scope>_<base64url(32 random bytes)>`. The scope in the prefix is cosmetic; the stored record is authoritative.
- Stored in `wisp-config.json` under `apiTokens[]` as `{ id, label, scope, tokenHash, createdAt }` — **SHA-256 hash only**, file mode `0600`, atomic writes under the settings mutex. The plaintext is returned exactly once by `POST /api/auth/tokens` and never again.
- Verification hashes the presented token and compares against each stored hash with `timingSafeEqual`, scanning the full list regardless of match position.
- No `lastUsedAt`: recording each use would rewrite `wisp-config.json` on every authenticated request.

### Scopes

Three scopes, each holding the one before it:

| Scope | Allowed |
|-------|---------|
| `read` | `read` and `mcp` routes. `agent` and `admin` routes → **403** `SCOPE_INSUFFICIENT`. |
| `agent` | `read`, `agent` and `mcp` routes, less what an `agent` route refuses from it ([below](#the-agent-scope)). `admin` routes → **403** `SCOPE_INSUFFICIENT`. |
| `admin` | `read`, `agent`, `admin` and `mcp` routes. |

On **`/mcp`** every scope passes the route (MCP is JSON-RPC over POST, so the method says nothing about mutation); scope is enforced **per tool** in the MCP layer instead — see [MCP.md](MCP.md).

A token keeps the scope it was made with: there is no changing it, only revoking the token and making another.

### The `agent` scope

For a coding agent that builds, runs and updates containers. It cannot delete, cannot give a container more reach into the host, and cannot change a VM or the host. The token form preselects it.

| Area | An `agent` token may |
|------|----------------------|
| Everything `read` has | Lists, masked details, stats, logs, jobs |
| Containers | Create a generic container (it lands on the default bridge); start, stop, restart, kill |
| Container config | Change the image, the command, the env (a secret value is write-only), the CPU and memory limits, the restart policy, start at boot, the scheduled backup, Local DNS, the icon |
| App containers | Change an app's config, in the fields the app marks agent-writable ([CUSTOM-APPS.md](CUSTOM-APPS.md#backend-app-module-interface); today Caddy's sites) |
| Mounts | Add and edit a folder, a file or a memory folder kept on this host; upload a file or a zip; write and read a file's content |
| Services | Add, edit and remove the names a container announces |
| Images | Upload an image; check for updates; point a container at another image |
| Backups | Take a backup of a container |

| Area | Stays `admin` |
|------|---------------|
| Every delete | Containers, mounts, a mount's data, images, backups |
| Restores and eject | Restoring a backup, ejecting an app |
| A container's reach into the host | A mount backed by a storage share or drive, devices, running as root, the bridge and the MAC |
| Containers | Renaming one; creating one from an app; an app's other fields |
| VMs | Every change |
| The host | Storage, bridges, power, OS updates, Wisp updates, settings, the certificate, the library, sections, the Home page |

Token management, the consoles and sign-on stay out of every token's reach ([Denied surfaces](#denied-surfaces-every-scope)).

- **A zip upload replaces a folder's content**, and an `agent` token may send one: it is how a site or a config folder is shipped.
- **Reading a file mount's content** follows the one secret rule: a secret file mount is unreadable for every caller, any other file is readable. A file that holds a secret and is not marked secret is therefore readable with an `agent` token.

**Narrowed requests.** An `agent` route may take less from an `agent` token than from a session or an `admin` token: a body key (`runAsRoot`), or a target (a mount backed by a storage share). Each route's entry in [API-CONTAINERS.md](API-CONTAINERS.md) lists what it refuses.

- The refusal is **403** `SCOPE_INSUFFICIENT`, its `detail` naming the key or the reason.
- It comes after the request passed its schema (a malformed request is **400** first) and before anything is written or a job starts.
- The body keys a route refuses are declared in its options, beside its level, and one hook enforces them; `npm run route-access` prints them with the level. A refusal that depends on what is stored (the mount's backing, the app's writable fields) is made by the operation, which is told the caller's scope.

**The scope is not a wall around the containers that exist.** An `agent` token may change the image, the command and the env of any container, one that runs as root or holds a device or a storage share included: what that container was given, the new image has.

### Denied surfaces (every scope)

`session` routes refuse every token with **403** `SESSION_REQUIRED`, before the token is even verified:

- **Consoles** (`/ws/console/:name/vnc`, `/ws/container-console/:name`) — a leaked token can never open a VM VNC session or a container shell.
- **`/api/auth/*`** (except the `public` login/OIDC routes) — logout, change-password, and token management are interactive concerns. A token can never mint or revoke tokens.
- **OIDC configuration** (`PATCH /api/settings/oidc`) **(settled 2026-10-16)** — whoever sets the issuer decides who can complete an SSO login, so a token that could repoint it to a provider it controls would mint itself a full browser session (consoles, tokens, password) that outlives the token's revocation. `PATCH /api/settings` refuses an `oidc` key from every caller with **403** `OIDC_SESSION_ONLY`, so the session route is the only write path.

Conversely, **`mcp` is bearer-only**: session cookies are ignored there entirely (which also makes it CSRF-irrelevant); a request without a valid token gets **401** (`AUTH_REQUIRED`, or `AUTH_INVALID` for an unknown token) with `WWW-Authenticate: Bearer`.

### Semantics

- Bearer requests **skip the CSRF check** — double-submit defends against ambient cookie credentials, which bearer requests don't carry.
- Invalid bearer attempts feed the **same per-IP rate-limit window as failed logins**, so an attacker can't double their guessing budget by alternating surfaces.
- **Password change does not revoke API tokens** — they are independent credentials (rotating the login password must not break agents). Revoke tokens explicitly from the UI or `DELETE /api/auth/tokens/:id`; revocation takes effect on the next request.

## WebSocket Authentication

WebSocket connections (VNC + container console) carry the same `wisp_session` cookie that authenticates HTTP requests. The browser sends cookies on the upgrade handshake automatically for same-origin URLs (Wisp's prod deployment serves the frontend and backend from the same origin; dev uses Vite's WS proxy so it's still same-origin from the browser's view).

Both console routes are `session`: the global `onRequest` auth hook validates the cookie before the WebSocket upgrade completes. The WS routes still enforce an `Origin` header allow-list since CORS does not apply to WebSocket; cross-origin pages are rejected with close code `1008` even if they have a stolen cookie.

## Login Rate Limiting

Failed authentication attempts — wrong passwords on `POST /api/auth/login`, wrong current passwords on `POST /api/auth/change-password` *(settled 2026-11-12: a stolen session gets no unlimited guesses)* **and** invalid bearer API tokens — are tracked per source IP, in memory. The window is **60 s** with a maximum of **5 failed attempts per IP**; further attempts in the same window return **429** `RATE_LIMITED`. The record is swept every 60 s for expired entries and capped at 10 000 distinct IPs to bound memory under flood conditions.

The IP is the request's peer address. `X-Forwarded-For` / `X-Forwarded-Proto` are honored only from loopback, which is always trusted, and from the `trustedProxies` entries ([CONFIGURATION.md](CONFIGURATION.md) § Reverse proxy / HTTPS). Trust is intentionally narrow: an attacker connecting directly to the backend port over the LAN cannot forge `X-Forwarded-For` to bypass the rate limit — never trust every source.

## OIDC / SSO login

Optional single sign-on via **OpenID Connect** (e.g. [Pocket ID](https://pocket-id.org)). Wisp stays **single-user**: a successful OIDC login is treated exactly like a correct password — it yields the same `wisp_session` / `wisp_csrf` cookies, signed with the same password-derived secret. The password therefore **remains configured and works as a backup**, and OIDC cannot be used without a password on file (the session JWT secret is derived from it).

No third-party OIDC/JWT library is used: discovery, the JWKS and the token exchange are plain HTTP requests, and ID-token signatures are verified with `node:crypto` (RS256/ES256).

**Requests to the issuer go through the operator fetch (settled 2026-11-20).** The issuer and the endpoints its discovery names are fetched with the fetch for an endpoint only the operator sets, not the SSRF guard: private and loopback addresses are allowed, so a provider on the LAN (or on the host) works. That is safe because only a session can set the issuer (§ Denied surfaces). No redirect is followed: a 3xx fails the step like any other non-2xx answer, so the client secret reaches only the token endpoint the discovery named (an issuer that redirects would fail the `iss` check anyway). Each request is bounded at **10 s**, its body included, and its body at **1 MiB**: a discovery document, a JWKS or a token answer is a few KB.

**What Wisp trusts the issuer for (settled 2026-11-20).** The configured issuer is the root of SSO's trust: its discovery document names where the client secret is sent (the token endpoint) and whose keys sign the ID token (the JWKS), so whoever answers as the issuer can complete a login. Wisp therefore checks the document before using it: its `issuer` must be the configured one (OIDC Discovery 4.3; a trailing slash aside), and under an `https` issuer each endpoint it names — `authorization_endpoint`, `token_endpoint`, `jwks_uri` — must be `https` too. The endpoints may be on other hosts, as real providers have them; a check fails discovery (`?sso=error`). A plain `http` issuer stays allowed, for a provider on the LAN, but nothing then protects the exchange: anyone on the network path can read the authorization code and the token exchange that carries the client secret, or answer as the issuer — its discovery and its signing keys included — and so log in. Use an `https` issuer wherever that path is not trusted.

### Access control

Delegated to the identity provider. Restrict the Wisp OIDC client to your own user/group **in the provider**; Wisp accepts any subject that authenticates for that client as the single user. Wisp does **not** maintain its own allowlist. It still fully validates every login (below), so a token minted for a different client or a tampered token is rejected.

### Configuration

Stored under `settings.oidc` in `wisp-config.json` (`{ enabled, issuer, clientId, clientSecret }`) and edited in **Host → App Config → Single sign-on** through `PATCH /api/settings/oidc` — a `session` route, never reachable with an API token (see § Denied surfaces). The client secret is masked on read (`hasClientSecret` boolean, like SMB passwords) and the file is written `0600`. `enabled: true` requires `issuer` (valid `http`/`https`), `clientId`, and `clientSecret`: the PATCH refuses it otherwise with **422** `INVALID_OIDC`, and a file that has it fails startup ([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)).

**The saved secret is bound to its issuer and client (settled 2026-10-16).** An empty or omitted `clientSecret` keeps the saved one only while `issuer` and `clientId` stay the same; changing either without a new secret is refused with **422** `INVALID_OIDC` (clearing either field drops the saved secret instead). Otherwise the secret issued by one provider would be sent to another provider's token endpoint.

### Flow (authorization code + PKCE, confidential client)

1. `GET /api/auth/oidc/login` fetches the provider's `/.well-known/openid-configuration` (cached), generates `state` + `nonce` + a PKCE verifier (held in a short-lived in-memory map, 10-minute TTL, one-time use), and **302**-redirects the browser to the authorization endpoint.
   The route is public, so the pending map is capped at 1000 entries and a full map **evicts the oldest start** rather than refusing a new one: a flood of abandoned starts can only fail a login whose provider round trip overlaps the flood (the user sees `?sso=error` and retries), never lock SSO out until entries expire. Eviction, not a per-IP rate limit: the shared failed-auth window would charge every legitimate SSO start against the password-login budget, and a per-IP limit does nothing against a flood from many addresses.
2. The `redirect_uri` is `<origin of advertisedUrl>/api/auth/oidc/callback` when the `advertisedUrl` setting is set (see [SETTINGS.md](SETTINGS.md) § LAN Discovery) — the configured browser-facing URL, so no request header can steer it, and the callback (with its session cookies) lands on that origin even if the login started from another one. **Set `advertisedUrl` whenever Wisp sits behind a reverse proxy or is reached under more than one name.** Without it the callback falls back to the request origin, `<scheme>://<Host>/api/auth/oidc/callback`: the scheme comes from `X-Forwarded-Proto` (honored only from `trustedProxies`, see [CONFIGURATION.md](CONFIGURATION.md) § Reverse proxy / HTTPS — otherwise a TLS proxy on another host yields `http://…` and the provider rejects it), and the Host is what the browser sent. A forged Host can only come from a non-browser client, and the provider rejects the resulting authorization request because OIDC requires redirect URIs to exactly match a registered one. **Register the exact callback URL** as the client's allowed redirect in the provider.
3. The provider redirects back to `GET /api/auth/oidc/callback` — GET only, like the login route: a `HEAD` on either is no route, so it never consumes a `state` or sets a session ([API-AUTH.md](API-AUTH.md)). Wisp validates and consumes the `state`, exchanges `code` at the token endpoint (client auth chosen from the provider's advertised `token_endpoint_auth_methods_supported` — `client_secret_basic`, else `client_secret_post`), and validates the ID token: **JWKS signature**, `iss`, `aud` contains the client id, `azp` is the client id when there are several audiences or an `azp` is present (OIDC Core 3.1.3.7), `exp` present and not past, `nbf` (both with 60 s skew), and `nonce`.
4. On success Wisp issues the session cookies and **302**s to `/`.

### Failure / cancel handling (no dead ends)

`login` and `callback` never leave the user stranded at a broken provider page — they bounce back to the SPA with a marker the login page reads:

- Provider returns `error=access_denied` (user cancelled) → `/login?sso=cancelled`
- SSO disabled mid-flow → `/login?sso=disabled`
- Provider unreachable, discovery/JWKS failure, invalid/expired state, token-exchange or ID-token validation failure → `/login?sso=error`

The frontend adds one marker of its own: a deliberate sign-out lands on `/login?sso=signedout` (see § Frontend handling).

The login page auto-redirects to the provider when SSO is enabled **and** no `?sso=` marker is present; the marker both shows the message and breaks the redirect loop so the password form (with a "Sign in with SSO" button below it) is reachable. See [UI.md](UI.md) § Login Page.

## Security Considerations

- **Timing-safe comparison** for both password verification and JWT signature verification
- **Password file permissions** restricted to `0600` (owner read/write only)
- **No password in JWT payload** — the token only contains `iat` and `exp`
- **HMAC-SHA256** signing prevents token forgery
- **7-day idle expiry** bounds the window of exposure for a leaked session cookie that is not in use; an actively used leaked cookie stays valid until the password changes
- **No token on the URL** — the JWT lives in an `HttpOnly` cookie, so it never appears in `Authorization`, `?token=`, image tags, link previews, or browser history.
- **`HttpOnly + Secure + SameSite=Lax`** session cookie + double-submit `X-CSRF-Token` — both layers must be defeated for cross-site abuse to succeed.
- **WS Origin allow-list** since CORS does not apply to WebSocket — cross-origin pages with a stolen cookie still get `close 1008`.
- **Single password change invalidates all sessions** since the signing secret changes; live SSE/WS are explicitly closed and the user's session is re-issued. API tokens survive by design and must be revoked explicitly.
- **API tokens** are hashed at rest (SHA-256 in a `0600` file), shown once, scoped (each route's declared level is checked before any handler runs), revocable, barred from consoles, auth routes and OIDC configuration, and rate-limited alongside logins.
- **OIDC** uses authorization-code flow with **PKCE** and a confidential client secret; `state` (one-time, CSRF/replay defence) and `nonce` (binds the ID token to the login) are enforced, and the ID token's **signature is verified against the provider JWKS** — a token from another client or a tampered token is rejected. The client secret is stored `0600` and never leaves the server.
