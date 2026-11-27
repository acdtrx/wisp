import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createAppError } from './appErrors.js';
import { writeFileAtomic } from './base/index.js';
import { CONFIG_PATH } from './config.js';
import { parseCookieHeader, appendSetCookie, buildSetCookie } from './cookies.js';
import { verifyApiToken } from './apiTokens.js';
import { scopeCovers } from './apiTokenScopes.js';
import { isAuthRateLimited, recordFailedAuthAttempt, AUTH_RATE_WINDOW_SECONDS } from './loginRateLimit.js';

// Beside the config file, wherever WISP_CONFIG_PATH puts it, as the migration
// ledger is (docs/specs/CONFIGURATION.md → Password Storage).
const PASSWORD_FILE = join(dirname(CONFIG_PATH), 'wisp-password');
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;

// Sliding browser session: it lapses after SESSION_MAX_AGE_SECONDS without an
// authenticated request. The auth hook re-issues the cookies once the token is
// older than SESSION_REFRESH_AFTER_SECONDS, so a session in use never expires
// and the re-signing cost is paid at most hourly, not on every request.
export const SESSION_MAX_AGE_SECONDS = 7 * 86400;
const SESSION_REFRESH_AFTER_SECONDS = 3600;

/**
 * Read wisp-password content. Returns { salt, key } for hashed
 * (scrypt:salt_hex:key_hex). Returns null when the file is missing or empty
 * (not configured yet: login reports it). Throws when the file can't be read or
 * is not in the expected scrypt form — `checkPasswordFile` runs this at startup,
 * so the backend refuses to start in that case (run `wispctl password` to repair).
 * Read on every use rather than cached, so `wispctl password` applies without a
 * restart.
 */
function readPasswordFile() {
  if (!existsSync(PASSWORD_FILE)) return null;
  let raw;
  try {
    raw = readFileSync(PASSWORD_FILE, 'utf8').trim();
  } catch (err) {
    throw createAppError('PASSWORD_FILE_UNREADABLE', "wisp-password can't be read", err.message);
  }
  if (!raw) return null;
  if (!raw.startsWith('scrypt:')) {
    throw createAppError(
      'PASSWORD_FILE_UNSUPPORTED_FORMAT',
      'wisp-password is in an unsupported format — run `wispctl password` (or scripts/linux/setup/password.sh) to set a new password.',
    );
  }
  const parts = raw.slice(7).split(':');
  if (parts.length !== 2) {
    throw createAppError('PASSWORD_FILE_UNSUPPORTED_FORMAT', 'wisp-password file is malformed (expected scrypt:salt:hash)');
  }
  const salt = Buffer.from(parts[0], 'hex');
  const key = Buffer.from(parts[1], 'hex');
  if (salt.length !== SCRYPT_SALT_LEN || key.length !== SCRYPT_KEYLEN) {
    throw createAppError('PASSWORD_FILE_UNSUPPORTED_FORMAT', 'wisp-password file has the wrong scrypt parameters');
  }
  return { salt, key };
}

/** Startup check of wisp-password: throws when it exists but can't be used. */
export function checkPasswordFile() {
  readPasswordFile();
}

function getSecret() {
  const stored = readPasswordFile();
  if (stored) return stored.key;
  throw createAppError('NO_PASSWORD_CONFIGURED', 'No password configured: run wispctl password (or scripts/linux/setup/password.sh)');
}

function base64UrlEncode(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return Buffer.from(str).toString('base64url');
}

function base64UrlDecode(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString());
}

export function signJWT(payload, expiresInSeconds = SESSION_MAX_AGE_SECONDS) {
  const secret = getSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const segments = `${base64UrlEncode(header)}.${base64UrlEncode(fullPayload)}`;
  const signature = createHmac('sha256', secret).update(segments).digest('base64url');

  return `${segments}.${signature}`;
}

export function verifyJWT(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const secret = getSecret();
  const [headerB64, payloadB64, signatureB64] = parts;

  // Pin the algorithm. We only ever issue HS256; reject any other alg (including
  // "none") before verifying so a future asymmetric verification branch can't be
  // tricked via alg-confusion. Defense-in-depth — the HMAC check below already
  // fails closed for a forged signature.
  let header;
  try {
    header = base64UrlDecode(headerB64);
  } catch {
    /* malformed JWT header JSON */
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;

  const segments = `${headerB64}.${payloadB64}`;

  const expected = createHmac('sha256', secret).update(segments).digest('base64url');

  const sigBuf = Buffer.from(signatureB64, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = base64UrlDecode(payloadB64);
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    /* malformed JWT payload JSON */
    return null;
  }
}

export function verifyPassword(input) {
  const stored = readPasswordFile();
  if (!stored) return false;
  const derived = scryptSync(input, stored.salt, SCRYPT_KEYLEN);
  if (derived.length !== stored.key.length) return false;
  return timingSafeEqual(derived, stored.key);
}

/**
 * Write new password to wisp-password (mode 0o600, atomically). Used by change-password route.
 * Stores a scrypt hash so the password is not stored in plain text.
 */
export async function setPassword(newPassword) {
  const str = String(newPassword).trim();
  if (!str) throw createAppError('PASSWORD_EMPTY', 'Password cannot be empty');
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const key = scryptSync(str, salt, SCRYPT_KEYLEN);
  const line = `scrypt:${salt.toString('hex')}:${key.toString('hex')}\n`;
  await writeFileAtomic(PASSWORD_FILE, line, { mode: 0o600 });
}

/**
 * Route access levels. Every route declares one in its own options as
 * `config: { auth: <level> }`; the auth hook enforces only that declaration and
 * never looks at the URL (docs/specs/AUTH.md § Route access levels):
 *
 *   public  — anyone (login, OIDC start/callback/status, static assets + SPA shell)
 *   session — browser session only; API tokens refused (/api/auth/*, consoles)
 *   read    — session, or an API token of any scope (GETs exposing no secrets)
 *   agent   — session, or an agent- or admin-scoped API token (building,
 *             running and updating containers)
 *   admin   — session, or an admin-scoped API token
 *   mcp     — API token only (any scope); per-tool scope is the MCP layer's job
 *
 * `read`, `agent` and `admin` are also token scopes, in that order: a token
 * passes such a route when its scope covers the level (lib/apiTokenScopes.js).
 *
 * A route that declares nothing, or an unknown level, is treated as `admin`:
 * fail closed. Development refuses to boot with such a route
 * (`checkRouteAccess`), so the default only ever applies in production.
 */
export const AUTH_LEVELS = Object.freeze(['public', 'session', 'read', 'agent', 'admin', 'mcp']);
const AUTH_LEVEL_SET = new Set(AUTH_LEVELS);
const UNDECLARED_AUTH_LEVEL = 'admin';

function isDeclaredAuthLevel(value) {
  return AUTH_LEVEL_SET.has(value);
}

/** The level the hook enforces for a route's config. */
export function routeAuthLevel(routeConfig) {
  const declared = routeConfig?.auth;
  return isDeclaredAuthLevel(declared) ? declared : UNDECLARED_AUTH_LEVEL;
}

/**
 * Collects every registered route through an `onRoute` hook so the declared
 * levels and schemas can be checked once routing is final (`app.ready()`).
 * The route options object is kept by reference and its config read at
 * listing time: hooks that run after this one may still set it. The schema
 * is the one the route declared, taken before the app's own `onRoute` hooks
 * complete it (routes/schemas.js).
 */
export function createRouteAccessRegistry() {
  const routes = [];
  return {
    onRoute(routeOptions) {
      const method = [].concat(routeOptions.method).join(',');
      routes.push({ method, url: routeOptions.url, routeOptions, declaredSchema: routeOptions.schema });
    },
    list() {
      return routes.map(({ method, url, routeOptions, declaredSchema }) => {
        const declared = routeOptions.config?.auth;
        return {
          method,
          url,
          auth: routeAuthLevel(routeOptions.config),
          declared: isDeclaredAuthLevel(declared),
          declaredValue: declared,
          declaredSchema,
          config: routeOptions.config,
          websocket: routeOptions.websocket === true,
        };
      });
    },
  };
}

function describeUndeclared(route) {
  const what = route.declaredValue === undefined
    ? 'no auth level'
    : `unknown auth level ${JSON.stringify(route.declaredValue)}`;
  return `${route.method} ${route.url} (${what})`;
}

/**
 * Startup check over the collected routes. `strict` (development) throws,
 * listing every route without a valid declaration; otherwise each one is
 * logged as a warning and enforced as `admin`.
 */
export function checkRouteAccess(routes, { strict, log }) {
  const undeclared = routes.filter((r) => !r.declared);
  if (undeclared.length === 0) return;
  const lines = undeclared.map(describeUndeclared);
  if (strict) {
    throw new Error(
      `Refusing to start: ${undeclared.length} route(s) lack an explicit access level `
      + `(add config: { auth: '${AUTH_LEVELS.join("' | '")}' }):\n  ${lines.join('\n  ')}`,
    );
  }
  for (const line of lines) {
    log.warn(`Route without an access declaration, enforced as ${UNDECLARED_AUTH_LEVEL}: ${line}`);
  }
}

export const SESSION_COOKIE = 'wisp_session';
export const CSRF_COOKIE = 'wisp_csrf';
const CSRF_HEADER = 'x-csrf-token';
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// `Secure` must reflect the actual request scheme. Browsers silently drop
// Secure cookies received over plain HTTP for non-localhost origins — so
// hardcoding `secure: true` in production breaks LAN-HTTP installs (login
// returns 200, browser discards the cookie, next API call 401s, frontend
// bounces to /login). With trustProxy enabled and the frontend proxy passing
// X-Forwarded-Proto, request.protocol is the original browser-side scheme.
export function setSessionCookies(reply, request, jwt, csrfToken) {
  const baseAttrs = {
    secure: request.protocol === 'https',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
  appendSetCookie(reply, buildSetCookie(SESSION_COOKIE, jwt, { ...baseAttrs, httpOnly: true }));
  appendSetCookie(reply, buildSetCookie(CSRF_COOKIE, csrfToken, { ...baseAttrs, httpOnly: false }));
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer API tokens authenticate non-interactive clients (agents, scripts) on
 * `read`, `agent`, `admin`, and `mcp` routes. `session` routes (consoles, everything
 * under /api/auth) refuse them before the token is even checked, so a leaked
 * token can never open a shell, change the password, or mint more tokens.
 * Bearer requests skip the CSRF check on purpose: double-submit defends
 * against ambient cookie credentials, which a bearer request doesn't carry.
 */
/** Which tokens a route of each token-reachable level takes, for its refusal. */
const LEVEL_TOKENS = Object.freeze({
  read: 'an API token',
  agent: 'an agent- or admin-scoped token',
  admin: 'an admin-scoped token',
});

/** The challenge `/mcp` answers a missing or invalid token with (MCP.md, Authentication). */
const MCP_AUTHENTICATE = 'Bearer realm="wisp"';

async function handleBearerAuth(request, reply, token, level) {
  if (level === 'session') {
    throw createAppError('SESSION_REQUIRED', 'API tokens cannot access this route; it requires a browser session');
  }
  const ip = request.ip || 'unknown';
  if (isAuthRateLimited(ip)) {
    throw createAppError('RATE_LIMITED', `Too many authentication attempts — try again after ${AUTH_RATE_WINDOW_SECONDS} seconds`);
  }
  const info = await verifyApiToken(token);
  if (!info) {
    recordFailedAuthAttempt(ip);
    if (level === 'mcp') reply.header('WWW-Authenticate', MCP_AUTHENTICATE);
    throw createAppError('AUTH_INVALID', 'Invalid API token');
  }
  // `mcp` routes accept every scope — the MCP layer gates each tool by scope,
  // since JSON-RPC over POST says nothing about mutation.
  if (level !== 'mcp' && !scopeCovers(info.scope, level)) {
    throw createAppError('SCOPE_INSUFFICIENT', `This route needs ${LEVEL_TOKENS[level]}; this token is ${info.scope}-scoped`);
  }
  request.user = { via: 'token', tokenId: info.id, label: info.label, scope: info.scope };
}

/**
 * The scope of the token a request came with, or null for a session (whose
 * requests are never narrowed). An operation that refuses part of a request
 * from an `agent` token by what is stored is told this (AUTH.md, The `agent`
 * scope: Narrowed requests).
 */
export function callerScope(request) {
  return request.user?.via === 'token' ? request.user.scope : null;
}

/**
 * Where `body` holds what one `agentRefuses` entry names, as `a/0/b` paths:
 * the entry is a key, or a path of keys through the body, split on `/`, in
 * which a `*` step is each item of a list (each mount's `sourceId`).
 */
function sentPaths(value, segments, at = []) {
  if (segments.length === 0) return [at.join('/')];
  const [head, ...rest] = segments;
  if (head === '*') {
    return Array.isArray(value) ? value.flatMap((item, i) => sentPaths(item, rest, [...at, i])) : [];
  }
  return value && typeof value === 'object' && Object.hasOwn(value, head) ? sentPaths(value[head], rest, [...at, head]) : [];
}

/**
 * The body keys an `agent` route refuses from an `agent` token, declared in
 * its options as `config: { auth: 'agent', agentRefuses: [...] }`: a key, or a
 * path to one inside the body (above). The route's last `preHandler`
 * (app.js): it runs once the body passed its schema and the route's own
 * checks of its shape (a malformed request is 400 first), and before the
 * handler writes anything.
 */
export async function refuseAgentKeys(request) {
  const refused = request.routeOptions.config?.agentRefuses;
  if (!refused || callerScope(request) !== 'agent') return;
  const sent = refused.flatMap((key) => sentPaths(request.body, key.split('/')));
  if (sent.length === 0) return;
  const keys = sent.map((key) => `body/${key}`).join(', ');
  throw createAppError('SCOPE_INSUFFICIENT', `${keys}: an agent token cannot send ${sent.length > 1 ? 'these' : 'this'}; it needs an admin-scoped token or a session`);
}

export function createAuthHook() {
  return async (request, reply) => {
    // No route matched: no handler runs and the not-found handler answers, so
    // there is nothing to authorize.
    if (request.is404) return;

    const level = routeAuthLevel(request.routeOptions.config);
    if (level === 'public') return;

    const authHeader = request.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
      await handleBearerAuth(request, reply, authHeader.slice(7).trim(), level);
      return;
    }

    // `mcp` is bearer-only: cookies are ignored entirely (no ambient-credential
    // surface, no CSRF concern), so a missing bearer header ends here.
    if (level === 'mcp') {
      reply.header('WWW-Authenticate', MCP_AUTHENTICATE);
      throw createAppError('AUTH_REQUIRED', 'The MCP endpoint requires an API token (Authorization: Bearer wisp_…)');
    }

    const cookies = parseCookieHeader(request.headers?.cookie);
    const token = cookies[SESSION_COOKIE] || null;

    if (!token) throw createAppError('AUTH_REQUIRED', 'You are not signed in');

    const payload = verifyJWT(token);
    if (!payload) throw createAppError('AUTH_INVALID', 'Your session has expired or is no longer valid: sign in again');

    // Double-submit CSRF: state-changing requests must echo the wisp_csrf
    // cookie value back as X-CSRF-Token. SameSite=Lax already stops most
    // cross-site forgery, but this header check defends against subdomain
    // bleeds and a mistake-class regression that flips SameSite to None.
    if (STATE_CHANGING_METHODS.has(request.method)) {
      const headerToken = request.headers?.[CSRF_HEADER];
      const cookieToken = cookies[CSRF_COOKIE];
      if (
        typeof headerToken !== 'string' ||
        typeof cookieToken !== 'string' ||
        !timingSafeEqualString(headerToken, cookieToken)
      ) {
        throw createAppError('CSRF_FAILED', 'Missing or mismatched CSRF token');
      }
    }

    // Slide the session: re-issue both cookies with a fresh expiry, keeping
    // the CSRF value so requests already in flight in other tabs still match.
    // A handler that sets the cookies itself (change-password, logout) appends
    // its Set-Cookie after these, and the browser applies the last one.
    const cookieCsrf = cookies[CSRF_COOKIE];
    const ageSeconds = Math.floor(Date.now() / 1000) - (payload.iat || 0);
    if (ageSeconds > SESSION_REFRESH_AFTER_SECONDS && typeof cookieCsrf === 'string' && cookieCsrf) {
      setSessionCookies(reply, request, signJWT({ role: 'admin' }), cookieCsrf);
    }

    request.user = payload;
  };
}
