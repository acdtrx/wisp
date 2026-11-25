/**
 * The URL downloads into the image library, and the HEAD probe of a URL, all
 * through the SSRF-guarded fetch (lib/outbound).
 */
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { ensureImageDir } from '../paths.js';
import { createAppError, errorBody, isAppError, wrapAppError } from '../appErrors.js';
import { isAllowedUrl, ssrfSafeFetch } from '../outbound/index.js';
import { detectType } from './fileTypes.js';
import { streamResponseToFile, streamResponseToUniqueFile } from './downloadUtils.js';

/** A HEAD probe is one round trip. */
const CHECK_URL_TIMEOUT_MS = 15_000;

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

/**
 * A HEAD request to `urlStr`: `{ ok: true, contentLength }` (null without a
 * usable Content-Length) when it answers 2xx, else `{ ok: false, error,
 * detail }` — the error body of why not (an unusable URL, a blocked or
 * unreachable host) — with the answer's `status` when it answered non-2xx.
 */
export async function checkUrl(urlStr) {
  try {
    if (!isAllowedUrl(urlStr)) throw createAppError('INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
    const res = await ssrfSafeFetch(urlStr, { method: 'HEAD', signal: AbortSignal.timeout(CHECK_URL_TIMEOUT_MS) });
    if (!res.ok) {
      const answered = createAppError('DOWNLOAD_FAILED', `The URL answered HTTP ${res.status}`);
      return { ok: false, ...errorBody(answered), status: res.status };
    }
    const contentLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    return { ok: true, contentLength: Number.isFinite(contentLength) ? contentLength : null };
  } catch (err) {
    const why = isAppError(err) ? err : wrapAppError('DOWNLOAD_FAILED', 'The URL could not be reached', err);
    return { ok: false, ...errorBody(why) };
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
  const { destPath, filename: finalName } = await streamResponseToUniqueFile(res, dir, filename, onProgress);

  const info = await stat(destPath);
  return {
    name: finalName,
    type: detectType(finalName),
    size: info.size,
    modified: info.mtime.toISOString(),
  };
}

async function fetchOk(url) {
  const res = await ssrfSafeFetch(url);
  if (!res.ok) {
    throw createAppError('DOWNLOAD_FAILED', `Download failed: HTTP ${res.status}`, String(res.status));
  }
  return res;
}

async function describeFile(destPath) {
  const info = await stat(destPath);
  const name = basename(destPath);
  return {
    name,
    type: detectType(name),
    size: info.size,
    modified: info.mtime.toISOString(),
  };
}

/**
 * Download url to a new file at destPath with progress. onProgress(percent, loaded, totalBytes).
 * Partial file removed on error. Returns { name, type, size, modified } on success.
 *
 * Uses ssrfSafeFetch (DNS-pinned, manual redirect re-validation) so even
 * hardcoded mirror URLs cannot be redirected to private/loopback addresses by
 * a hostile or compromised mirror.
 */
export async function downloadWithProgress(url, destPath, onProgress) {
  const res = await fetchOk(url);
  await streamResponseToFile(res, destPath, onProgress);
  return describeFile(destPath);
}

/**
 * Download url into dir under baseName (or the next free ` (n)` variant).
 * Same progress, cleanup, and SSRF guarantees as downloadWithProgress.
 * Returns { name, type, size, modified } on success.
 */
export async function downloadToUniqueFile(url, dir, baseName, onProgress) {
  const res = await fetchOk(url);
  const { destPath } = await streamResponseToUniqueFile(res, dir, baseName, onProgress);
  return describeFile(destPath);
}
