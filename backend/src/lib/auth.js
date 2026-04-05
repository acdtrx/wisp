import { createHmac, timingSafeEqual, createHash, scryptSync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASSWORD_FILE = resolve(__dirname, '../../../config/wisp-password');
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;

/**
 * Read config/wisp-password content. Returns { plain } or { salt, key } for hashed (scrypt:salt_hex:key_hex).
 */
function readPasswordFile() {
  if (!existsSync(PASSWORD_FILE)) return null;
  try {
    const raw = readFileSync(PASSWORD_FILE, 'utf8').trim();
    if (!raw) return null;
    if (raw.startsWith('scrypt:')) {
      const parts = raw.slice(7).split(':');
      if (parts.length !== 2) return null;
      const salt = Buffer.from(parts[0], 'hex');
      const key = Buffer.from(parts[1], 'hex');
      if (salt.length !== SCRYPT_SALT_LEN || key.length !== SCRYPT_KEYLEN) return null;
      return { salt, key };
    }
    return { plain: raw };
  } catch {
    /* unreadable password file — treat as not configured */
    return null;
  }
}

function getSecret() {
  const stored = readPasswordFile();
  if (stored) {
    if ('key' in stored) return stored.key;
    if ('plain' in stored) return createHash('sha256').update(stored.plain).digest();
  }
  throw new Error('No password configured: run wispctl password (or scripts/linux/setup/password.sh)');
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

  if ('key' in stored) {
    const derived = scryptSync(input, stored.salt, SCRYPT_KEYLEN);
    if (derived.length !== stored.key.length) return false;
    return timingSafeEqual(derived, stored.key);
  }

  const expected = stored.plain;
  const inputBuf = Buffer.from(input);
  const expectedBuf = Buffer.from(expected);
  if (inputBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(inputBuf, expectedBuf);
}

/**
 * Write new password to config/wisp-password (mode 0o600). Used by change-password route.
 * Stores a scrypt hash so the password is not stored in plain text.
 */
export function setPassword(newPassword) {
  const str = String(newPassword).trim();
  if (!str) throw new Error('Password cannot be empty');
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const key = scryptSync(str, salt, SCRYPT_KEYLEN);
  const line = `scrypt:${salt.toString('hex')}:${key.toString('hex')}\n`;
  writeFileSync(PASSWORD_FILE, line, { mode: 0o600, encoding: 'utf8' });
}

export function createAuthHook() {
  const publicPaths = new Set(['/api/auth/login']);

  return async (request, reply) => {
    const urlPath = request.url.split('?')[0];
    if (publicPaths.has(urlPath)) return;

    let token = null;

    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (request.query?.token) {
      token = request.query.token;
    }

    if (!token) {
      reply.code(401).send({ error: 'Authentication required', detail: 'Missing or malformed Authorization header' });
      return;
    }

    const payload = verifyJWT(token);
    if (!payload) {
      reply.code(401).send({ error: 'Authentication failed', detail: 'Invalid or expired token' });
      return;
    }

    request.user = payload;
  };
}
