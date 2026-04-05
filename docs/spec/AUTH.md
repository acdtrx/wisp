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

**`config/wisp-password`** (mode `0600`) holds either:

- **Plain text** — single line (legacy; trim applied).
- **Scrypt hash** — `scrypt:<salt_hex>:<key_hex>` (install, `wispctl password`, change-password).

If the file is missing, JWT signing fails until a password is set (`wispctl password` or install). There is no `WISP_PASSWORD` env fallback.

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

- **Plain password:** The signing secret is `SHA-256(effective_password)`.
- **Scrypt hash in config/wisp-password:** The signing secret is the stored derived key (64 bytes). No plain password is available.

Changing the password (or writing a new hash) changes the signing secret and invalidates all existing tokens.

### Token lifetime

24 hours (86400 seconds). No refresh token mechanism — the user must re-authenticate after expiry.

### Verification

1. Split token into three parts
2. Recompute HMAC-SHA256 of `header.payload`
3. Compare signatures using `timingSafeEqual` (constant-time comparison to prevent timing attacks)
4. Check `exp` claim against current time
5. Return decoded payload on success, `null` on failure

## Route Protection

An `onRequest` hook is registered globally on the backend server. Every incoming request passes through this hook before reaching any route handler.

### Public routes

Only one route is public (no authentication required):

- `POST /api/auth/login`

### Token extraction

The auth hook extracts the JWT from (in order):

1. `Authorization: Bearer <token>` header (standard HTTP requests)
2. `?token=<token>` query parameter (WebSocket connections, since WebSocket handshakes cannot set custom headers)

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

## WebSocket Authentication

WebSocket connections (VNC console) cannot send `Authorization` headers during the handshake. Instead, the JWT is passed as a query parameter:

```
ws://host:port/ws/console/:name/vnc?token=<jwt>
```

The console route handler verifies the token from `request.query.token` before establishing the VNC proxy connection. If invalid, the WebSocket is closed with code `4001` and reason "Authentication required".

## Security Considerations

- **Timing-safe comparison** for both password verification and JWT signature verification
- **Password file permissions** restricted to `0600` (owner read/write only)
- **No password in JWT payload** — the token only contains `iat` and `exp`
- **HMAC-SHA256** signing prevents token forgery
- **24-hour expiry** limits the window of exposure for leaked tokens
- **Single password change invalidates all tokens** since the signing secret changes
