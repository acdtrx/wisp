/**
 * Stream a URL to the image directory with progress reporting.
 * Only HTTP/HTTPS URLs allowed. Private/loopback IPs blocked (SSRF protection).
 */

import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { lookup } from 'node:dns/promises';
import { ensureImageDir } from './paths.js';
import { detectType } from './fileTypes.js';
import { createAppError } from './routeErrors.js';
import { findUniqueFilename, streamResponseToFile } from './downloadUtils.js';

function isPrivateIPv4(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(addr) {
  const normalized = addr.toLowerCase();
  if (normalized === '::1') return true;
  const segs = normalized.split(':').filter(Boolean);
  if (segs.length === 0) return true; // :: 
  const first = segs[0];
  if (first.length >= 2) {
    const high = parseInt(first.slice(0, 2), 16);
    if (high >= 0xfc && high <= 0xfe) return true; // fc00::/7, fe80::/10
  }
  if (normalized.startsWith('fe80:')) return true;
  return false;
}

function isPrivateIP(addr) {
  if (addr.includes(':')) return isPrivateIPv6(addr);
  return isPrivateIPv4(addr);
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
 * Call before fetching. Throws if URL is disallowed.
 */
export async function assertUrlNotPrivate(urlStr) {
  if (!isAllowedUrl(urlStr)) {
    throw createAppError('INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
  }
  try {
    const u = new URL(urlStr);
    const hostname = u.hostname;
    if (!hostname) return;
    const addrs = await lookup(hostname, { all: true });
    for (const { address } of addrs) {
      if (isPrivateIP(address)) {
        throw createAppError('SSRF_BLOCKED', 'URL must not resolve to a private or loopback address');
      }
    }
  } catch (err) {
    if (err.code === 'SSRF_BLOCKED' || err.code === 'INVALID_URL') throw err;
    throw createAppError('DNS_FAILED', 'Could not resolve URL host', err.message);
  }
}

/**
 * Run a HEAD request and return { ok, contentLength, error }.
 */
export async function checkUrl(urlStr) {
  if (!isAllowedUrl(urlStr)) {
    return { ok: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  }
  try {
    await assertUrlNotPrivate(urlStr);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const res = await fetch(urlStr, { method: 'HEAD', redirect: 'follow' });
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
  await assertUrlNotPrivate(urlStr);

  const res = await fetch(urlStr, { redirect: 'follow' });
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
