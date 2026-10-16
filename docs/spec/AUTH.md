# Authentication

Wisp uses single-user JWT authentication carried in **HttpOnly cookies**. There is one password for the entire application — no user accounts, roles, or multi-user support.

## Login Flow

1. User navigates to the app. If no `wisp_csrf` cookie is present, the SPA redirects to `/login`.
2. User enters the password and submits.
3. Frontend sends `POST /api/auth/login` with `{ password }` and `credentials: 'include'`.
4. Backend verifies the password using timing-safe comparison.
5. On success, backend sets two cookies and returns `{ ok: true }`:
   - **`wisp_session`** — the JWT itself. `HttpOnly` (JS cannot read it), `SameSite=Lax`, `Path=/`, `Max-Age=86400`. `Secure` is set when the request scheme is HTTPS (derived from `request.protocol`, which honors `X-Forwarded-Proto` from loopback proxies via `trustProxy`). On plain-HTTP LAN deployments the flag is omitted — browsers silently discard `Secure` cookies received over HTTP for non-`localhost` origins, which would otherwise leave the user stuck on the login page.
   - **`wisp_csrf`** — a per-session random 32-byte token used for double-submit CSRF defence. Same attributes as the session cookie except **not** `HttpOnly` (JS reads it to echo on state-changing requests).
6. Frontend has nothing to store; subsequent requests automatically carry both cookies.
7. On failure, backend returns 401 with `{ error, detail }`.

## CSRF protection

`SameSite=Lax` already blocks the simple cross-site form-submission CSRF cases, but Wisp also enforces double-submit:

- Frontend reads the `wisp_csrf` cookie value (non-HttpOnly) and sends it as `X-CSRF-Token` on every **POST/PUT/PATCH/DELETE**.
- Backend's auth hook compares the header to the cookie via `timingSafeEqual`; mismatch returns **403 CSRF check failed**.
- GETs (including SSE streams and the WebSocket upgrade handshake) skip the CSRF check — they don't mutate state, and `SameSite=Lax` keeps the session cookie from leaking to cross-site GETs in any meaningful way.

## Password Storage

**`config/wisp-password`** (mode `0600`) holds a **scrypt hash** in the form `scrypt:<salt_hex>:<key_hex>` (written by install, `wispctl password`, and change-password).

If the file is missing, JWT signing fails until a password is set (`wispctl password` or install). There is no `WISP_PASSWORD` env fallback. If the file exists but is not in the expected scrypt form, the backend refuses to use it (the auth route returns 503 with `PASSWORD_FILE_UNSUPPORTED_FORMAT`) — run `wispctl password` to repair.

### Password change

- `POST /api/auth/change-password` with `{ currentPassword, newPassword }`
- On success, writes a new **scrypt hash** to `config/wisp-password` with mode `0600`
- Returns 204 (no content). Changing the password invalidates all existing tokens because the signing secret is derived from the password (or the new hash).
- A wrong `currentPassword` returns **422 `INVALID_PASSWORD`**, shown inline in the form. Not 401: the session is valid, and a 401 would log every tab out (see § Frontend handling).

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

24 hours (86400 seconds). No refresh token mechanism — the user must re-authenticate after expiry.

### Verification

1. Split token into three parts
2. Decode the header and require `alg === 'HS256'` — any other value (including `none`) is rejected before verification, so a future asymmetric branch can't be tricked via alg-confusion
3. Recompute HMAC-SHA256 of `header.payload`
4. Compare signatures using `timingSafeEqual` (constant-time comparison to prevent timing attacks)
5. Check `exp` claim against current time
6. Return decoded payload on success, `null` on failure

## Route Protection

### Route access levels

**Rule (settled 2026-10-16):** authorization is a property of each route, not of its URL. Every route declares its level in its own options — `config: { auth: '<level>' }` — and one global `onRequest` hook (`createAuthHook` in `backend/src/lib/auth.js`) enforces only that declaration. The hook never tests the URL, a prefix, or the HTTP method. A route that declares nothing, or an unknown level, is enforced as **`admin`** (fail closed).

| Level | Who may call | Used for |
|-------|--------------|----------|
| `public` | anyone | `POST /api/auth/login`, the three OIDC routes, static assets + SPA shell |
| `session` | browser session only — API tokens get **403 Session required** | the rest of `/api/auth/*` (logout, change-password, token management), the `/ws` consoles |
| `read` | session, or an API token of either scope | GETs whose response carries no secret material (lists, masked details, stats/progress/log streams) |
| `admin` | session, or an `admin`-scoped API token; a `read` token gets **403 Insufficient scope** | every mutation, plus GETs that return raw file content or make outbound requests |
| `mcp` | API token only (either scope) — cookies ignored; per-tool scope in the MCP layer | `/mcp` |

CSRF double-submit is a property of cookie auth on state-changing methods, independent of the level (see § CSRF protection).

`read` is a deliberate per-route choice, governed by the read-token contract in [MCP.md](MCP.md) § Authentication: a read token must not recover a secret. GETs stay `admin` when their response could carry one — `GET /api/containers/:name/mounts/:mountName/content` (raw file content) — or when they are actions rather than reads: `GET /api/library/check-url` and `GET /api/github/keys/:username` make outbound requests on demand. [API.md](API.md) tags every endpoint with its level; `npm run route-access` prints the live table (method, URL, level), exiting non-zero if any route is undeclared.

**Startup check.** An `onRoute` hook records every route; once the app is ready, **development refuses to boot** while any route lacks a valid declaration, listing them. Production enforces such a route as `admin` and logs a warning per route. Third-party plugins that register their own routes — the dev CORS preflight and `@fastify/static` — are registered through `registerPluginWithPublicRoutes` in `index.js`, which marks the routes the plugin adds while it loads as `public` (pending plugins are flushed first, so nothing else falls in that window).

**Unmatched requests.** A request that matches no route runs no handler, so the hook has nothing to authorize and the not-found handler answers: a JSON 404 for API-looking paths, the SPA shell otherwise (production). Because the decision is the matched route's declaration, percent-encoding cannot change it — `/%61pi/vms` dispatches to `/api/vms` and gets exactly its level.

**Rejected alternatives:**
- An explicit `requireAuth()` call in each handler — a forgotten call leaves the route open.
- Protection by plugin registration scope (auth hooks on an encapsulated group of routes) — moving a route between plugins in a refactor silently changes its protection.
- Any URL or prefix test (the previous `/api` / `/ws` / `/mcp` gate plus a public-route list) — protection then depended on where a route sat in the URL tree, and every encoding or routing subtlety became an auth question.

### Token extraction

For browser sessions, the auth hook extracts the JWT from the `wisp_session` cookie. There is **no** bearer or `?token=…` path for the session JWT — the browser sends the cookie automatically on every same-origin request (HTTP, SSE via fetch, WebSocket upgrade, link clicks for the run-log download), so no custom client code is needed to forward it.

When a request carries an `Authorization: Bearer …` header instead, the hook takes the **API token** path (see § API tokens below) and never falls through to the cookie flow.

### Rejection

If no token is found or the token is invalid/expired, the hook short-circuits the request with:

```json
401 { "error": "Authentication required", "detail": "..." }
```

or:

```json
401 { "error": "Authentication failed", "detail": "Invalid or expired token" }
```

### Frontend handling

The frontend fetch wrapper sends `credentials: 'include'` on every request, reads the `wisp_csrf` cookie via `document.cookie`, and echoes it as `X-CSRF-Token` on state-changing methods. On a 401 response:

1. Writes a `wisp_logout` flag to localStorage so other tabs see the logout
2. Redirects to `/login`

So **401 is reserved for "no or expired session"** on every route the client calls. A route that rejects the request itself while the session is fine answers with another status (change-password's wrong current password → 422). The login route's 401 for a wrong password is the exception that stays: the login page posts with a bare `fetch`, outside the shared client.

`POST /api/auth/logout` clears both cookies and returns 204. The frontend's `useAuthStore.logout` calls it before broadcasting the multi-tab signal, then the tab lands on **`/login?sso=signedout`** — the marker keeps the login page from auto-redirecting to the SSO provider, which with a live provider session would sign the user straight back in.

**Multi-tab logout.** Logout in one tab calls `broadcastLogout('signedout')`, which writes a `wisp_logout` localStorage entry carrying the reason (`signedout` for a deliberate sign-out, `expired` for a 401). Every other open tab subscribes to the `storage` event and bounces on that key change — to `/login?sso=signedout` for a sign-out (so no tab SSO-signs back in), to plain `/login` for an expired session. A tab already on the login page stays put. The session cookie itself is shared across tabs (same browser profile, same origin), so any tab that tries an authenticated request after logout also gets 401 and redirects.

**Password change closes live connections.** `POST /api/auth/change-password` writes the new hash, calls `closeAllSSE()` + `closeAllWebSockets('password changed')`, then re-issues a fresh `wisp_session` and `wisp_csrf` against the new secret so the user who just changed their password isn't immediately bounced. Pre-rotation tokens can no longer keep streaming on connections that were authed before the secret changed.

## API tokens

Scoped bearer tokens let non-interactive clients (coding agents, scripts, future MCP clients) call the REST API without the password + cookie + CSRF dance. Implementation: `backend/src/lib/apiTokens.js` (mint/verify/revoke), bearer branch in the auth hook (`backend/src/lib/auth.js`), management routes in `backend/src/routes/auth.js`, UI in **Host → App Config → API tokens**.

### Format and storage

- Token string: `wisp_<scope>_<base64url(32 random bytes)>`. The scope in the prefix is cosmetic; the stored record is authoritative.
- Stored in `wisp-config.json` under `apiTokens[]` as `{ id, label, scope, tokenHash, createdAt }` — **SHA-256 hash only**, file mode `0600`, atomic writes under the settings mutex. The plaintext is returned exactly once by `POST /api/auth/tokens` and never again.
- Verification hashes the presented token and compares against each stored hash with `timingSafeEqual`, scanning the full list regardless of match position.

### Scopes

| Scope | Allowed |
|-------|---------|
| `read` | `read` and `mcp` routes. `admin` routes → **403 Insufficient scope**. |
| `admin` | `read`, `admin`, and `mcp` routes. |

On **`/mcp`** both scopes pass the route (MCP is JSON-RPC over POST, so the method says nothing about mutation); scope is enforced **per tool** in the MCP layer instead — see [MCP.md](MCP.md).

### Denied surfaces (both scopes)

`session` routes refuse every token with **403 Session required**, before the token is even verified:

- **Consoles** (`/ws/console/:name/vnc`, `/ws/container-console/:name`) — a leaked token can never open a VM VNC session or a container shell.
- **`/api/auth/*`** (except the `public` login/OIDC routes) — logout, change-password, and token management are interactive concerns. A token can never mint or revoke tokens.

Conversely, **`mcp` is bearer-only**: session cookies are ignored there entirely (which also makes it CSRF-irrelevant); a request without a valid token gets **401** with `WWW-Authenticate: Bearer`.

### Semantics

- Bearer requests **skip the CSRF check** — double-submit defends against ambient cookie credentials, which bearer requests don't carry.
- Invalid bearer attempts feed the **same per-IP rate-limit window as failed logins** (`backend/src/lib/loginRateLimit.js`), so an attacker can't double their guessing budget by alternating surfaces.
- **Password change does not revoke API tokens** — they are independent credentials (rotating the login password must not break agents). Revoke tokens explicitly from the UI or `DELETE /api/auth/tokens/:id`; revocation takes effect on the next request.
- `request.user` for token-authed requests is `{ via: 'token', tokenId, label, scope }`.

## WebSocket Authentication

WebSocket connections (VNC + container console) carry the same `wisp_session` cookie that authenticates HTTP requests. The browser sends cookies on the upgrade handshake automatically for same-origin URLs (Wisp's prod deployment serves the frontend and backend from the same origin; dev uses Vite's WS proxy so it's still same-origin from the browser's view).

Both console routes are `session`: the global `onRequest` auth hook validates the cookie before the WebSocket upgrade completes — by the time the route handler runs, `request.user` is set and no per-route token check is needed. The WS routes still enforce an `Origin` header allow-list (`isAllowedWsOrigin`) since CORS does not apply to WebSocket; cross-origin pages are rejected with close code `1008` even if they have a stolen cookie.

## Login Rate Limiting

Failed authentication attempts — wrong passwords on `POST /api/auth/login` **and** invalid bearer API tokens — are tracked per source IP in a shared in-memory `Map` (`backend/src/lib/loginRateLimit.js`). The window is **60 s** with a maximum of **5 failed attempts per IP**; further attempts in the same window return **429**. The map is swept every 60 s for expired entries and capped at 10 000 distinct IPs to bound memory under flood conditions.

The IP used as the map key is **`request.ip`**. Backend Fastify is configured with `trustProxy: ['127.0.0.1', '::1', ...trustedProxies]` — loopback is always trusted, plus any entries from the `trustedProxies` config field. In production the backend serves the SPA itself and browsers connect to it directly, so with no proxy `request.ip` is the real peer address; the loopback allow-list covers an *optional* TLS-terminating reverse proxy (Caddy/nginx) running on the **same host** that can pass `X-Forwarded-For` / `X-Forwarded-Proto` so cookies pick the right `Secure` flag. When the proxy runs on a **different host/container**, add its IP or subnet to `trustedProxies` in `wisp-config.json` (read at boot; see [CONFIGURATION.md](CONFIGURATION.md) § Reverse proxy / HTTPS). Trust is intentionally narrow: only headers from trusted sources are honored, so an attacker connecting directly to the backend port over the LAN cannot forge `X-Forwarded-For` to bypass the rate limit — never set `trustProxy: true`.

## OIDC / SSO login

Optional single sign-on via **OpenID Connect** (e.g. [Pocket ID](https://pocket-id.org)). Wisp stays **single-user**: a successful OIDC login is treated exactly like a correct password — it yields the same `wisp_session` / `wisp_csrf` cookies, signed with the same password-derived secret. The password therefore **remains configured and works as a backup**, and OIDC cannot be used without a password on file (the session JWT secret is derived from it).

No third-party OIDC/JWT library is used: discovery and token exchange go over `fetch`, and ID-token signatures are verified with `node:crypto` (`createPublicKey({ format: 'jwk' })`, RS256/ES256). Implementation in `backend/src/lib/oidc.js`; routes in `backend/src/routes/auth.js`.

### Access control

Delegated to the identity provider. Restrict the Wisp OIDC client to your own user/group **in the provider**; Wisp accepts any subject that authenticates for that client as the single user. Wisp does **not** maintain its own allowlist. It still fully validates every login (below), so a token minted for a different client or a tampered token is rejected.

### Configuration

Stored under `settings.oidc` in `wisp-config.json` (`{ enabled, issuer, clientId, clientSecret }`) and edited in **Host → App Config → Single sign-on**. The client secret is masked on read (`hasClientSecret` boolean, like SMB passwords) and the file is written `0600`. `enabled` only sticks when `issuer` (valid `http`/`https`), `clientId`, and `clientSecret` are all present.

### Flow (authorization code + PKCE, confidential client)

1. `GET /api/auth/oidc/login` fetches the provider's `/.well-known/openid-configuration` (cached), generates `state` + `nonce` + a PKCE verifier (held in a short-lived in-memory map, 10-minute TTL, one-time use), and **302**-redirects the browser to the authorization endpoint.
   The route is public, so the pending map is capped at 1000 entries and a full map **evicts the oldest start** rather than refusing a new one: a flood of abandoned starts can only fail a login whose provider round trip overlaps the flood (the user sees `?sso=error` and retries), never lock SSO out until entries expire. Eviction was chosen over a per-IP rate limit: the shared failed-auth window (`loginRateLimit.js`) would charge every legitimate SSO start against the password-login budget, and a per-IP limit does nothing against a flood from many addresses.
2. The `redirect_uri` is `<origin of advertisedUrl>/api/auth/oidc/callback` when the `advertisedUrl` setting is set (see [SETTINGS.md](SETTINGS.md) § LAN Discovery) — the configured browser-facing URL, so no request header can steer it, and the callback (with its session cookies) lands on that origin even if the login started from another one. **Set `advertisedUrl` whenever Wisp sits behind a reverse proxy or is reached under more than one name.** Without it the callback falls back to the request origin, `<scheme>://<Host>/api/auth/oidc/callback`: the scheme comes from `X-Forwarded-Proto` (honored only from `trustedProxies`, see [CONFIGURATION.md](CONFIGURATION.md) § Reverse proxy / HTTPS — otherwise a TLS proxy on another host yields `http://…` and the provider rejects it), and the Host is what the browser sent. A forged Host can only come from a non-browser client, and the provider rejects the resulting authorization request because OIDC requires redirect URIs to exactly match a registered one. **Register the exact callback URL** as the client's allowed redirect in the provider.
3. The provider redirects back to `GET /api/auth/oidc/callback`. Wisp validates and consumes the `state`, exchanges `code` at the token endpoint (client auth chosen from the provider's advertised `token_endpoint_auth_methods_supported` — `client_secret_basic`, else `client_secret_post`), and validates the ID token: **JWKS signature**, `iss`, `aud` contains the client id, `exp`/`nbf` (60 s skew), and `nonce`.
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
- **24-hour expiry** limits the window of exposure for leaked tokens
- **No token on the URL** — the JWT lives in an `HttpOnly` cookie, so it never appears in `Authorization`, `?token=`, image tags, link previews, or browser history.
- **`HttpOnly + Secure + SameSite=Lax`** session cookie + double-submit `X-CSRF-Token` — both layers must be defeated for cross-site abuse to succeed.
- **WS Origin allow-list** since CORS does not apply to WebSocket — cross-origin pages with a stolen cookie still get `close 1008`.
- **Single password change invalidates all sessions** since the signing secret changes; live SSE/WS are explicitly closed and the user's session is re-issued. API tokens survive by design and must be revoked explicitly.
- **API tokens** are hashed at rest (SHA-256 in a `0600` file), shown once, scoped (each route's declared level is checked before any handler runs), revocable, barred from consoles and auth routes, and rate-limited alongside logins.
- **OIDC** uses authorization-code flow with **PKCE** and a confidential client secret; `state` (one-time, CSRF/replay defence) and `nonce` (binds the ID token to the login) are enforced, and the ID token's **signature is verified against the provider JWKS** — a token from another client or a tampered token is rejected. The client secret is stored `0600` and never leaves the server.
