/**
 * Tiny cookie helpers — no @fastify/cookie dependency. Wisp only needs to set
 * two cookies on login (session + CSRF), clear them on logout, and read them
 * on each authenticated request. Anything beyond that lives in this file.
 */

const COOKIE_VALUE_RE = /^[^\x00-\x1f\x7f;]*$/;

/**
 * Parse the `Cookie:` request header into a plain object. Returns {} if the
 * header is missing or malformed. Accepts standard cookie syntax:
 *   `name=value; other=value`. Values are returned URL-decoded.
 */
export function parseCookieHeader(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Format a Set-Cookie header line. Validates name/value to avoid header
 * injection (refuses control chars, semicolons, etc.).
 *
 * `attrs.maxAge` is in seconds. `attrs.httpOnly` defaults to false.
 * `attrs.path` defaults to '/'. `attrs.sameSite` defaults to 'Lax'.
 */
export function buildSetCookie(name, value, attrs = {}) {
  if (!/^[a-zA-Z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
    throw new Error('Invalid cookie name');
  }
  const v = String(value);
  if (!COOKIE_VALUE_RE.test(v)) {
    throw new Error('Invalid cookie value');
  }
  const parts = [`${name}=${encodeURIComponent(v)}`];
  parts.push(`Path=${attrs.path || '/'}`);
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.secure) parts.push('Secure');
  parts.push(`SameSite=${attrs.sameSite || 'Lax'}`);
  if (typeof attrs.maxAge === 'number') {
    parts.push(`Max-Age=${Math.floor(attrs.maxAge)}`);
  }
  return parts.join('; ');
}

/**
 * Append one or more Set-Cookie headers to the reply. Fastify's reply.header
 * overwrites repeats; reply.raw.appendHeader keeps both.
 */
export function appendSetCookie(reply, header) {
  reply.raw.appendHeader('Set-Cookie', header);
}
