/**
 * Stream a URL to the image directory with progress reporting.
 * Only HTTP/HTTPS URLs allowed. Private/loopback IPs blocked (SSRF protection).
 *
 * SSRF design:
 *  - Single DNS resolve via dns.lookup (no redirect-time re-lookup that could
 *    diverge from the validated address).
 *  - undici Agent with a `connect.lookup` hook pins the connection to the
 *    pre-validated IPs. DNS rebinding cannot bypass us because the second
 *    lookup never happens.
 *  - `redirect: 'manual'`: we follow up to MAX_REDIRECTS ourselves and re-run
 *    `assertUrlNotPrivate` on every Location target.
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';

import { ensureImageDir } from '../paths.js';
import { detectType } from './fileTypes.js';
import { createAppError } from '../routeErrors.js';
import { findUniqueFilename, streamResponseToFile } from './downloadUtils.js';

const MAX_REDIRECTS = 5;

function ipv4Octets(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return parts;
}

export function isPrivateIPv4(addr) {
  const parts = ipv4Octets(addr);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0) return true;                                  // 0.0.0.0/8
  if (a === 10) return true;                                 // 10.0.0.0/8
  if (a === 127) return true;                                // 127.0.0.0/8 (loopback)
  if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 (CGNAT)
  if (a === 169 && b === 254) return true;                   // 169.254.0.0/16 (link-local + AWS metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;          // 172.16.0.0/12
  if (a === 192 && b === 0 && parts[2] === 0) return true;   // 192.0.0.0/24
  if (a === 192 && b === 168) return true;                   // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true;      // 198.18.0.0/15 (benchmarking)
  if (a >= 224 && a <= 239) return true;                     // 224.0.0.0/4 (multicast)
  if (a >= 240) return true;                                 // 240.0.0.0/4 (reserved + 255.255.255.255)
  return false;
}

export function isPrivateIPv6(addr) {
  const normalized = addr.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) in dotted form.
  const ipv4MappedDotted = normalized.match(/^::ffff:([0-9.]+)$/);
  if (ipv4MappedDotted) return isPrivateIPv4(ipv4MappedDotted[1]);
  const ipv4CompatDotted = normalized.match(/^::([0-9.]+)$/);
  if (ipv4CompatDotted && ipv4CompatDotted[1].includes('.')) return isPrivateIPv4(ipv4CompatDotted[1]);

  // All-hex IPv4-mapped form: Node's URL parser normalises `::ffff:127.0.0.1`
  // to `::ffff:7f00:1`. Decode the last 32 bits back into a.b.c.d and re-check.
  const ipv4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (ipv4MappedHex) {
    const high = parseInt(ipv4MappedHex[1], 16);
    const low = parseInt(ipv4MappedHex[2], 16);
    const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isPrivateIPv4(v4);
  }

  const segs = normalized.split(':').filter(Boolean);
  if (segs.length === 0) return true;
  const first = segs[0];
  if (first.length >= 2) {
    const high = parseInt(first.slice(0, 2), 16);
    if (high >= 0xfc && high <= 0xfd) return true;           // fc00::/7 (unique local)
    if (high === 0xfe) {
      const second = parseInt(first.slice(0, 4).padEnd(4, '0').slice(2, 4), 16);
      if (second >= 0x80 && second <= 0xbf) return true;     // fe80::/10 (link-local)
    }
    if (high === 0xff) return true;                          // ff00::/8 (multicast)
  }
  return false;
}

export function isPrivateIP(addr) {
  if (addr.includes(':')) return isPrivateIPv6(addr);
  return isPrivateIPv4(addr);
}

function makePinnedLookup(pinnedAddrs) {
  return function pinnedLookup(_hostname, opts, cb) {
    if (!pinnedAddrs.length) {
      return cb(Object.assign(new Error('No allowed addresses for host'), { code: 'SSRF_BLOCKED' }));
    }
    if (opts && opts.all) {
      return cb(null, pinnedAddrs);
    }
    const first = pinnedAddrs[0];
    cb(null, first.address, first.family);
  };
}

function makePrivateIPGuardAgent(pinnedAddrs) {
  return new Agent({
    connect: { lookup: makePinnedLookup(pinnedAddrs) },
  });
}

function parseContentDisposition(header) {
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/filename\*?=(?:UTF-8'')?["']?([^"'\s;]+)["']?/i) || header.match(/filename=["']?([^"'\s;]+)["']?/i);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

function filenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const pathname = u.pathname || '';
    const name = pathname.split('/').filter(Boolean).pop() || 'download';
    return decodeURIComponent(name);
  } catch {
    /* invalid URL string — use generic filename */
    return 'download';
  }
}

function sanitizeFilename(name) {
  const base = basename(name);
  if (!base) return 'download';
  return base.replace(/[^\w.\-]/g, '_');
}

export { streamResponseToFile as streamDownloadToFile } from './downloadUtils.js';

/** @deprecated Use findUniqueFilename from downloadUtils.js */
export { findUniqueFilename as uniqueFilename } from './downloadUtils.js';

export function isAllowedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return true;
  } catch {
    /* malformed URL */
    return false;
  }
}

/**
 * Resolve hostname and reject if any resolved IP is private/loopback (SSRF protection).
 * Returns the resolved addresses (host:port-pinned) so the caller can build an
 * IP-pinned undici Agent. Throws if the URL is disallowed.
 */
export async function assertUrlNotPrivate(urlStr) {
  if (!isAllowedUrl(urlStr)) {
    throw createAppError('INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
  }
  let u;
  try {
    u = new URL(urlStr);
  } catch (err) {
    throw createAppError('INVALID_URL', 'Malformed URL', err.message);
  }
  const hostname = u.hostname;
  if (!hostname) {
    throw createAppError('INVALID_URL', 'URL has no host');
  }

  // If the host is a literal IP, validate it directly without DNS.
  const literalAddrs = literalIpAddrs(hostname);
  if (literalAddrs) {
    for (const { address } of literalAddrs) {
      if (isPrivateIP(address)) {
        throw createAppError('SSRF_BLOCKED', 'URL must not resolve to a private or loopback address');
      }
    }
    return literalAddrs;
  }

  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch (err) {
    throw createAppError('DNS_FAILED', 'Could not resolve URL host', err.message);
  }
  if (!addrs.length) {
    throw createAppError('DNS_FAILED', `No addresses for host ${hostname}`);
  }
  for (const { address } of addrs) {
    if (isPrivateIP(address)) {
      throw createAppError('SSRF_BLOCKED', 'URL must not resolve to a private or loopback address');
    }
  }
  return addrs;
}

function literalIpAddrs(hostname) {
  // Node's URL.hostname for an IPv6 literal still includes the brackets
  // (e.g. `[::1]`); strip them before further checks.
  const trimmed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (trimmed.includes(':')) {
    if (/^[0-9a-fA-F:.]+$/.test(trimmed)) {
      return [{ address: trimmed, family: 6 }];
    }
    return null;
  }
  if (ipv4Octets(trimmed)) {
    return [{ address: trimmed, family: 4 }];
  }
  return null;
}

/**
 * Fetch with manual redirect handling. Each Location target is re-validated by
 * `assertUrlNotPrivate` and DNS-pinned to a fresh undici Agent. Up to
 * `MAX_REDIRECTS` redirects are followed.
 *
 * Pass `method` (`'GET'` / `'HEAD'`) and any standard fetch options. Returns
 * an undici Response object whose `body` (web ReadableStream) can be piped.
 */
export async function ssrfSafeFetch(urlStr, init = {}) {
  let currentUrl = urlStr;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const addrs = await assertUrlNotPrivate(currentUrl);
    const dispatcher = makePrivateIPGuardAgent(addrs);

    const res = await undiciFetch(currentUrl, {
      ...init,
      redirect: 'manual',
      dispatcher,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return res; // 3xx without Location — return as-is
      }
      const next = new URL(location, currentUrl).toString();
      // Drain the redirect response body so the connection can be reused/closed.
      try { await res.arrayBuffer(); } catch { /* ignore */ }
      currentUrl = next;
      continue;
    }
    return res;
  }
  throw createAppError('SSRF_BLOCKED', `Exceeded redirect limit (${MAX_REDIRECTS})`);
}

/**
 * Run a HEAD request and return { ok, contentLength, error }.
 */
export async function checkUrl(urlStr) {
  if (!isAllowedUrl(urlStr)) {
    return { ok: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  }
  try {
    const res = await ssrfSafeFetch(urlStr, { method: 'HEAD' });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    }
    const contentLength = res.headers.get('content-length');
    return {
      ok: true,
      contentLength: contentLength ? parseInt(contentLength, 10) : null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Download url to the image directory. onProgress(percent, loaded, total).
 * Returns { name, type, size, modified } on success.
 */
export async function downloadToLibrary(urlStr, onProgress) {
  if (!isAllowedUrl(urlStr)) {
    throw createAppError('INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
  }
  const res = await ssrfSafeFetch(urlStr);
  if (!res.ok) {
    throw createAppError('DOWNLOAD_FAILED', `Download failed: HTTP ${res.status}`, String(res.status));
  }

  let filename = parseContentDisposition(res.headers.get('content-disposition')) || filenameFromUrl(urlStr);
  filename = sanitizeFilename(filename);
  if (!filename) filename = 'download';

  const dir = await ensureImageDir();
  const { destPath, filename: finalName } = await findUniqueFilename(dir, filename);

  await streamResponseToFile(res, destPath, onProgress);

  const info = await stat(destPath);
  return {
    name: finalName,
    type: detectType(finalName),
    size: info.size,
    modified: info.mtime.toISOString(),
  };
}
