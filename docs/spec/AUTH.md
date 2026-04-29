# Authentication

Wisp uses single-user JWT authentication. There is one password for the entire application — no user accounts, roles, or multi-user support.

## Login Flow

1. User navigates to the app. If no valid JWT is stored, they are redirected to `/login`.
2. User enters the password and submits.
3. Frontend sends `POST /api/auth/login` with `{ password }`.
4. Backend verifies the password using timing-safe comparison.
5. On success, backend returns `{ token }` — a signed JWT with 24-hour expiry.
6. Frontend stores the token in `localStorage` and redirects to the main app.
7. On failure, backend returns 401 with `{ error, detail }`.

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

The auth hook extracts the JWT from (in order):

1. `Authorization: Bearer <token>` header (standard HTTP requests).
2. `?token=<token>` query parameter — **only on routes tagged with `config.acceptQueryToken: true`**. Currently those are SSE endpoints and the WebSocket consoles, which can't set custom headers from the browser. Every other route requires the Bearer header so a JWT in an image tag's URL, link preview, or browser history can't be replayed.

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

The frontend fetch wrapper checks for 401 responses. On receiving a 401:

1. Clears the stored token from `localStorage`
2. Redirects to `/login`

This handles both token expiry and password changes gracefully.

**Multi-tab logout.** `frontend/src/api/client.js` registers a `storage` event listener so when one tab clears the token (logout, password change), every other open tab also bounces to `/login`. Without this, a stale tab keeps making authenticated requests with its in-memory token copy until the JWT expires.

**Password change closes live connections.** `POST /api/auth/change-password` writes the new hash and immediately calls `closeAllSSE()` and `closeAllWebSockets('password changed')`. Pre-rotation tokens can no longer keep streaming on connections that were authed before the secret changed; new connections fail JWT verify against the new secret and the frontend redirect cycle takes over.

## WebSocket Authentication

WebSocket connections (VNC console) cannot send `Authorization` headers during the handshake. Instead, the JWT is passed as a query parameter:

```
ws://host:port/ws/console/:name/vnc?token=<jwt>
```

The console route handler verifies the token from `request.query.token` before establishing the VNC proxy connection. If invalid, the WebSocket is closed with code `4001` and reason "Authentication required".

## Login Rate Limiting

Failed login attempts are tracked per source IP (in-memory `Map`). The window is **60 s** with a maximum of **5 failed attempts per IP**; further attempts in the same window return **429**. The map is swept every 60 s for expired entries and capped at 10 000 distinct IPs to bound memory under flood conditions.

## Security Considerations

- **Timing-safe comparison** for both password verification and JWT signature verification
- **Password file permissions** restricted to `0600` (owner read/write only)
- **No password in JWT payload** — the token only contains `iat` and `exp`
- **HMAC-SHA256** signing prevents token forgery
- **24-hour expiry** limits the window of exposure for leaked tokens
- **Token redacted from request logs:** Fastify's `req` serializer rewrites `?token=...` query values to `token=REDACTED` so JWTs from SSE/WebSocket URLs never reach `journald` / `stdout`.
- **`?token=` only on SSE/WebSocket routes** — every other route requires the `Authorization: Bearer …` header.
- **Single password change invalidates all tokens** since the signing secret changes
