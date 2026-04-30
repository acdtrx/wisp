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
2. Recompute HMAC-SHA256 of `header.payload`
3. Compare signatures using `timingSafeEqual` (constant-time comparison to prevent timing attacks)
4. Check `exp` claim against current time
5. Return decoded payload on success, `null` on failure

## Route Protection

An `onRequest` hook is registered globally on the backend server. Every incoming request passes through this hook before reaching any route handler. Fastify v5 selects the matching route before `onRequest` runs, so the hook reads `request.routeOptions.url` (the registered route URL) for public-route matching — trailing slashes and percent-encoded variants don't accidentally bypass auth.

### Public routes

Only one route is public (no authentication required):

- `POST /api/auth/login`

### Token extraction

The auth hook extracts the JWT from the `wisp_session` cookie. There is **no** `Authorization: Bearer …` header path and **no** `?token=…` query string fallback — both were removed when sessions moved to cookies. The browser sends the cookie automatically on every same-origin request (HTTP, SSE via fetch, WebSocket upgrade, link clicks for the run-log download), so no custom client code is needed to forward it.

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

`POST /api/auth/logout` clears both cookies and returns 204. The frontend's `useAuthStore.logout` calls it before broadcasting the multi-tab signal.

**Multi-tab logout.** Logout in one tab calls `broadcastLogout()` which writes a `wisp_logout` localStorage entry. Every other open tab subscribes to the `storage` event and bounces to `/login` on that key change. The session cookie itself is shared across tabs (same browser profile, same origin), so any tab that tries an authenticated request after logout also gets 401 and redirects.

**Password change closes live connections.** `POST /api/auth/change-password` writes the new hash, calls `closeAllSSE()` + `closeAllWebSockets('password changed')`, then re-issues a fresh `wisp_session` and `wisp_csrf` against the new secret so the user who just changed their password isn't immediately bounced. Pre-rotation tokens can no longer keep streaming on connections that were authed before the secret changed.

## WebSocket Authentication

WebSocket connections (VNC + container console) carry the same `wisp_session` cookie that authenticates HTTP requests. The browser sends cookies on the upgrade handshake automatically for same-origin URLs (Wisp's prod deployment serves the frontend and backend from the same origin; dev uses Vite's WS proxy so it's still same-origin from the browser's view).

The global `onRequest` auth hook validates the cookie before the WebSocket upgrade completes — by the time the route handler runs, `request.user` is set and no per-route token check is needed. The WS routes still enforce an `Origin` header allow-list (`isAllowedWsOrigin`) since CORS does not apply to WebSocket; cross-origin pages are rejected with close code `1008` even if they have a stolen cookie.

## Login Rate Limiting

Failed login attempts are tracked per source IP (in-memory `Map`). The window is **60 s** with a maximum of **5 failed attempts per IP**; further attempts in the same window return **429**. The map is swept every 60 s for expired entries and capped at 10 000 distinct IPs to bound memory under flood conditions.

The IP used as the map key is **`request.ip`**. Backend Fastify is configured with `trustProxy: ['127.0.0.1', '::1']` — loopback only — because the bundled frontend proxy (`frontend/server.js`) always connects to the backend from `127.0.0.1` and injects `X-Forwarded-For` / `X-Forwarded-Proto`. Trust is intentionally narrow: only headers from loopback are honored, so an attacker connecting directly to backend port 3001 over the LAN cannot forge `X-Forwarded-For` to bypass the rate limit. If a future deployment puts a TLS-terminating reverse proxy in front of the frontend on a different host, extend the allow-list to that proxy's IP — never set `trustProxy: true`.

## Security Considerations

- **Timing-safe comparison** for both password verification and JWT signature verification
- **Password file permissions** restricted to `0600` (owner read/write only)
- **No password in JWT payload** — the token only contains `iat` and `exp`
- **HMAC-SHA256** signing prevents token forgery
- **24-hour expiry** limits the window of exposure for leaked tokens
- **No token on the URL** — the JWT lives in an `HttpOnly` cookie, so it never appears in `Authorization`, `?token=`, image tags, link previews, or browser history.
- **`HttpOnly + Secure + SameSite=Lax`** session cookie + double-submit `X-CSRF-Token` — both layers must be defeated for cross-site abuse to succeed.
- **WS Origin allow-list** since CORS does not apply to WebSocket — cross-origin pages with a stolen cookie still get `close 1008`.
- **Single password change invalidates all tokens** since the signing secret changes; live SSE/WS are explicitly closed and the user's session is re-issued.
