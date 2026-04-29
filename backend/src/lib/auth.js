import { createHmac, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppError } from './routeErrors.js';
import { parseCookieHeader } from './cookies.js';

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

// Routes whose canonical (post-routing) URL bypasses auth. Matched against
// `request.routeOptions.url` so trailing-slash / percent-encoded variants
// don't accidentally get marked public.
const PUBLIC_ROUTES = new Set(['/api/auth/login']);

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

export function createAuthHook() {
  return async (request, reply) => {
    const routeUrl = request.routeOptions?.url;
    if (routeUrl && PUBLIC_ROUTES.has(routeUrl)) return;

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
