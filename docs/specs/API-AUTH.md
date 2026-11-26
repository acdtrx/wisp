# API — Authentication

Login, logout, password change, API tokens and OIDC sign-in. Shared contracts (access levels, errors, command responses, jobs, the events stream): [API.md](API.md).

## Authentication

### POST /api/auth/login · `public`

Authenticate with password. On success, sets two cookies (`wisp_session` HttpOnly + `wisp_csrf` non-HttpOnly, `SameSite=Lax`, 7-day Max-Age, slid forward while in use — see [AUTH.md](AUTH.md) § Token lifetime) and returns `{ ok: true }`.

- **Auth:** Public (no token required)
- **Rate limit:** 5 attempts per IP per 60 seconds (sweep 60 s, max 10 000 entries)
- **Body:** `{ password: string }`
- **200:** `{ ok: true }` + `Set-Cookie: wisp_session=…; HttpOnly; SameSite=Lax`, `Set-Cookie: wisp_csrf=…; SameSite=Lax`
- **401:** `{ error, detail }` — `LOGIN_FAILED`: invalid password
- **429:** `{ error, detail }` — `RATE_LIMITED`

### POST /api/auth/logout · `session`

Clear the session cookies. Idempotent.

- **204:** No content + `Set-Cookie: wisp_session=; Max-Age=0`, `Set-Cookie: wisp_csrf=; Max-Age=0`

### POST /api/auth/change-password · `session`

Change the application password. On success, re-issues fresh `wisp_session` and `wisp_csrf` cookies against the new secret so the caller stays logged in. Existing SSE / WebSocket connections are server-closed because their pre-rotation tokens no longer verify.

- **Body:** `{ currentPassword: string, newPassword: string }`
- **204:** No content + new `Set-Cookie` lines for both cookies
- **422:** `{ error, detail }` — `INVALID_PASSWORD`: current password incorrect. Deliberately not 401 — the caller's session is valid, and 401 is reserved for "no/expired session" (the frontend logs every tab out on it)
- **429:** `{ error, detail }` — `RATE_LIMITED`: too many failed attempts from this IP (the login window; a wrong current password counts)
- **500:** `{ error, detail }` — `INTERNAL_ERROR`: failed to write new password

### API tokens

Scoped bearer tokens for non-interactive clients (coding agents, scripts). All three routes are `session` — the auth hook refuses bearer tokens on them, so a token can never list, mint, or revoke tokens. Tokens are stored as SHA-256 hashes in `wisp-config.json` (`apiTokens[]`, see [CONFIGURATION.md](CONFIGURATION.md)); the plaintext is returned exactly once at creation. Changing the application password does **not** revoke API tokens — revoke them explicitly.

#### GET /api/auth/tokens · `session`

- **200:** `[{ id, label, scope: "read" | "agent" | "admin", createdAt }]` (never includes the hash or plaintext)

#### POST /api/auth/tokens · `session`

- **Body:** `{ label: string (1–64), scope: "read" | "agent" | "admin" }`
- **201:** `{ id, label, scope, createdAt, token }` — `token` (`wisp_<scope>_<random>`) is shown only in this response
- **400:** `VALIDATION_FAILED` — a label of 0 or over 64 characters, a scope other than `read` / `agent` / `admin`, or an unknown key (the body's schema)
- **422:** `TOKEN_INVALID` — a label of whitespace only

#### DELETE /api/auth/tokens/:id · `session`

- **204:** No content — clients using the token get 401 immediately
- **404:** `{ error, detail }` — `TOKEN_NOT_FOUND`

### OIDC / SSO login

Optional single sign-on via OpenID Connect (authorization-code flow with PKCE + confidential client secret). Configured under `settings.oidc` (see `GET /api/settings`, `PATCH /api/settings/oidc` and [CONFIGURATION.md](CONFIGURATION.md)). All three routes are **public** (they run before a session exists). Access control is delegated to the provider — any subject that authenticates for the Wisp client becomes the single Wisp user; the ID token is still fully validated (issuer, audience, expiry, nonce, JWKS signature). A successful callback issues the **same** `wisp_session` / `wisp_csrf` cookies as password login (the session JWT is still signed with the password-derived secret, so a password must be configured). See [AUTH.md](AUTH.md) § OIDC.

#### GET /api/auth/oidc/status · `public`

Tells the login page whether to show (and auto-redirect to) SSO. Secret-free.

- **Auth:** Public
- **200:** `{ enabled: boolean }`

#### GET /api/auth/oidc/login · `public`

Begins the flow: generates state + nonce + PKCE, then **302**-redirects the browser to the provider authorization endpoint. The `redirect_uri` is `<advertisedUrl origin>/api/auth/oidc/callback` when the `advertisedUrl` setting is set; otherwise it falls back to the request origin (`<scheme>://<Host>/api/auth/oidc/callback`; `X-Forwarded-Proto` honored only from trusted proxies). See [AUTH.md](AUTH.md) § OIDC. On any failure — SSO disabled, no `advertisedUrl` and no `Host`, unreachable/invalid provider — it **302**s to `/login?sso=<disabled|error>` instead of dead-ending. A start never fails for being one too many: the in-memory table of pending logins is capped at 1000 and evicts the oldest start.

- **Auth:** Public
- **302:** `Location: <provider authorize URL>` on success; `Location: /login?sso=error` (or `?sso=disabled`) on failure

#### GET /api/auth/oidc/callback · `public`

Provider redirect target. Validates the one-time `state`, exchanges `code` for tokens (client auth per the provider's advertised method), verifies the ID token, and issues the session.

- **Auth:** Public
- **Query:** `code`, `state` (success) or `error`, `error_description` (provider-side failure); extra params ignored
- **302 (success):** `Location: /` + `Set-Cookie: wisp_session=…; HttpOnly`, `Set-Cookie: wisp_csrf=…`
- **302 (cancelled):** `Location: /login?sso=cancelled` when the provider returns `error=access_denied`
- **302 (failure):** `Location: /login?sso=error` for any other provider error, invalid/expired state, token-exchange failure, or ID-token validation failure

Both SSO routes are **GET only (settled 2026-11-20)**: neither has the automatic `HEAD` route the others get, so a `HEAD` (a link checker, a prefetch) answers **404** `ROUTE_NOT_FOUND` and never starts a login, consumes a `state` or sets the session cookies. Fastify would answer one by running the GET handler.
