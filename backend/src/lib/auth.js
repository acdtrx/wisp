import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppError } from './routeErrors.js';
import { parseCookieHeader } from './cookies.js';
import { verifyApiToken } from './apiTokens.js';
import { isAuthRateLimited, recordFailedAuthAttempt, AUTH_RATE_WINDOW_SECONDS } from './loginRateLimit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASSWORD_FILE = resolve(__dirname, '../../../config/wisp-password');
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;

/**
 * Read config/wisp-password content. Returns { salt, key } for hashed
 * (scrypt:salt_hex:key_hex). Returns null when the file is missing or empty.
 * Throws when the file exists but is not in the expected scrypt form — the
 * backend refuses to start in that case (run `wispctl password` to repair).
 */
function readPasswordFile() {
  if (!existsSync(PASSWORD_FILE)) return null;
  let raw;
  try {
    raw = readFileSync(PASSWORD_FILE, 'utf8').trim();
  } catch {
    /* unreadable password file — treat as not configured */
    return null;
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

export function signJWT(payload, expiresInSeconds = 86400) {
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
 * Write new password to config/wisp-password (mode 0o600). Used by change-password route.
 * Stores a scrypt hash so the password is not stored in plain text.
 */
export function setPassword(newPassword) {
  const str = String(newPassword).trim();
  if (!str) throw createAppError('PASSWORD_EMPTY', 'Password cannot be empty');
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const key = scryptSync(str, salt, SCRYPT_KEYLEN);
  const line = `scrypt:${salt.toString('hex')}:${key.toString('hex')}\n`;
  writeFileSync(PASSWORD_FILE, line, { mode: 0o600, encoding: 'utf8' });
}

/**
 * Route access levels. Every route declares one in its own options as
 * `config: { auth: <level> }`; the auth hook enforces only that declaration and
 * never looks at the URL (docs/spec/AUTH.md § Route access levels):
 *
 *   public  — anyone (login, OIDC start/callback/status, static assets + SPA shell)
 *   session — browser session only; API tokens refused (/api/auth/*, consoles)
 *   read    — session, or an API token of any scope (GETs exposing no secrets)
 *   admin   — session, or an admin-scoped API token
 *   mcp     — API token only (any scope); per-tool scope is the MCP layer's job
 *
 * A route that declares nothing, or an unknown level, is treated as `admin`:
 * fail closed. Development refuses to boot with such a route
 * (`checkRouteAccess`), so the default only ever applies in production.
 */
export const AUTH_LEVELS = Object.freeze(['public', 'session', 'read', 'admin', 'mcp']);
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
 * levels can be checked once routing is final (`app.ready()`). The route
 * options object is kept by reference and its config read at listing time:
 * hooks that run after this one may still set it.
 */
export function createRouteAccessRegistry() {
  const routes = [];
  return {
    onRoute(routeOptions) {
      const method = [].concat(routeOptions.method).join(',');
      routes.push({ method, url: routeOptions.url, routeOptions });
    },
    list() {
      return routes.map(({ method, url, routeOptions }) => {
        const declared = routeOptions.config?.auth;
        return {
          method,
          url,
          auth: routeAuthLevel(routeOptions.config),
          declared: isDeclaredAuthLevel(declared),
          declaredValue: declared,
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

const SESSION_COOKIE = 'wisp_session';
const CSRF_COOKIE = 'wisp_csrf';
const CSRF_HEADER = 'x-csrf-token';
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer API tokens authenticate non-interactive clients (agents, scripts) on
 * `read`, `admin`, and `mcp` routes. `session` routes (consoles, everything
 * under /api/auth) refuse them before the token is even checked, so a leaked
 * token can never open a shell, change the password, or mint more tokens.
 * Bearer requests skip the CSRF check on purpose: double-submit defends
 * against ambient cookie credentials, which a bearer request doesn't carry.
 */
async function handleBearerAuth(request, reply, token, level) {
  if (level === 'session') {
    reply.code(403).send({ error: 'Session required', detail: 'API tokens cannot access this route; it requires a browser session' });
    return;
  }
  const ip = request.ip || 'unknown';
  if (isAuthRateLimited(ip)) {
    reply.code(429).send({
      error: 'Too many authentication attempts',
      detail: `Try again after ${AUTH_RATE_WINDOW_SECONDS} seconds`,
    });
    return;
  }
  const info = await verifyApiToken(token);
  if (!info) {
    recordFailedAuthAttempt(ip);
    reply.code(401).send({ error: 'Authentication failed', detail: 'Invalid API token' });
    return;
  }
  // `read` and `mcp` routes accept either scope — on /mcp the MCP layer gates
  // each tool by scope, since JSON-RPC over POST says nothing about mutation.
  if (level === 'admin' && info.scope !== 'admin') {
    reply.code(403).send({
      error: 'Insufficient scope',
      detail: 'This route requires an admin-scoped token',
    });
    return;
  }
  request.user = { via: 'token', tokenId: info.id, label: info.label, scope: info.scope };
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
      reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="wisp"')
        .send({ error: 'Authentication required', detail: 'The MCP endpoint requires an API token (Authorization: Bearer wisp_…)' });
      return;
    }

    const cookies = parseCookieHeader(request.headers?.cookie);
    const token = cookies[SESSION_COOKIE] || null;

    if (!token) {
      reply.code(401).send({ error: 'Authentication required', detail: 'No session cookie' });
      return;
    }

    const payload = verifyJWT(token);
    if (!payload) {
      reply.code(401).send({ error: 'Authentication failed', detail: 'Invalid or expired session' });
      return;
    }

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
        reply.code(403).send({ error: 'CSRF check failed', detail: 'Missing or mismatched CSRF token' });
        return;
      }
    }

    request.user = payload;
  };
}
