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
import { createAppError, errorBody, isAppError, wrapAppError } from '../appErrors.js';
import { limitBody, streamResponseToFile, streamResponseToUniqueFile } from './downloadUtils.js';

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

/**
 * The eight 16-bit groups of an IPv6 address (`::` expanded, a trailing dotted
 * IPv4 part and a `%zone` accepted), or null when it is not one.
 */
function ipv6Groups(addr) {
  const text = addr.toLowerCase().replace(/%.*$/, '');
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (half) => {
    if (half === '') return [];
    const parts = half.split(':');
    const groups = [];
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1 && part.includes('.')) {
        const octets = ipv4Octets(part);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        groups.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // A dotted IPv4 part only ends the address: `::1.2.3.4:5` is not one.
  if (head.length + tail.length > 7 || halves[0].includes('.')) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

/** The IPv4 address two groups carry, as a.b.c.d. */
function embeddedIPv4(high, low) {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Whether an IPv6 address is one an outbound request must not reach. An
 * address that wraps an IPv4 one is judged by that address's rule: the
 * IPv4-mapped and IPv4-compatible forms, NAT64 and 6to4 all reach it. An
 * address that does not parse is refused.
 */
export function isPrivateIPv6(addr) {
  const g = ipv6Groups(addr);
  if (!g) return true;
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIPv4(embeddedIPv4(g[6], g[7])); // ::ffff:0:0/96 (IPv4-mapped)
  if (zeros(0, 6)) return isPrivateIPv4(embeddedIPv4(g[6], g[7]));     // ::/96 (IPv4-compatible; :: and ::1 among them)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) {
    return isPrivateIPv4(embeddedIPv4(g[6], g[7]));                    // 64:ff9b::/96 (NAT64)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;     // 64:ff9b:1::/48 (local-use NAT64)
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(g[1], g[2])); // 2002::/16 (6to4)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                         // fc00::/7 (unique local)
  if ((g[0] & 0xffc0) === 0xfe80) return true;                         // fe80::/10 (link-local)
  if ((g[0] & 0xffc0) === 0xfec0) return true;                         // fec0::/10 (site-local, deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                         // ff00::/8 (multicast)
  return false;
}

export function isPrivateIP(addr) {
  if (addr.includes(':')) return isPrivateIPv6(addr);
  return isPrivateIPv4(addr);
}

function makePinnedLookup(pinnedAddrs) {
  return function pinnedLookup(_hostname, opts, cb) {
    if (!pinnedAddrs.length) {
      return cb(createAppError('SSRF_BLOCKED', 'No allowed addresses for host'));
    }
    if (opts && opts.all) {
      return cb(null, pinnedAddrs);
    }
    const first = pinnedAddrs[0];
    cb(null, first.address, first.family);
  };
}

/*
 * Explicit, not undici's defaults (CODING-RULES §6): a connect that takes 10 s
 * is a dead host; 30 s to the response headers; and between body chunks 120 s —
 * an idle bound, not a total one, so a large image download on a slow link
 * still finishes while a stalled one fails.
 */
const CONNECT_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 30_000;
const BODY_IDLE_TIMEOUT_MS = 120_000;
/** A HEAD probe is one round trip. */
const CHECK_URL_TIMEOUT_MS = 15_000;

function makePrivateIPGuardAgent(pinnedAddrs) {
  return new Agent({
    connect: { lookup: makePinnedLookup(pinnedAddrs), timeout: CONNECT_TIMEOUT_MS },
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_IDLE_TIMEOUT_MS,
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
 * Settle with `promise`, or reject with the signal's reason once it aborts —
 * for work that takes no signal of its own (dns.lookup), which keeps running
 * but no longer holds the caller.
 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * The fetch for every URL from user input, and for a public source whose
 * redirects Wisp does not control; only an endpoint the operator sets (the
 * OIDC issuer) goes through `fetchOperatorEndpoint` instead. Refuses a host
 * that resolves to a private or loopback address (SSRF_BLOCKED).
 *
 * Fetch with manual redirect handling. Each Location target is re-validated by
 * `assertUrlNotPrivate` and DNS-pinned to a fresh undici Agent — one per hop,
 * since its lookup answers that hop's addresses whatever the host. Up to
 * `MAX_REDIRECTS` redirects are followed.
 *
 * Each hop's Agent is closed as soon as its answer's headers are in: undici's
 * close is graceful, so the request in flight — its body, read by the caller
 * at its own pace — completes first, and the Agent's sockets go when it has.
 *
 * Pass `method` (`'GET'` / `'HEAD'`) and any standard fetch options, and
 * `maxBodyBytes` for an answer read whole: the body then fails with
 * DOWNLOAD_FAILED past it (see `limitBody`). Returns a Response whose `body`
 * (web ReadableStream) can be piped.
 */
export async function ssrfSafeFetch(urlStr, { maxBodyBytes, ...init } = {}) {
  let currentUrl = urlStr;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // The caller's signal bounds the DNS lookup too, not only the request.
    const addrs = await untilAborted(assertUrlNotPrivate(currentUrl), init.signal);
    const dispatcher = makePrivateIPGuardAgent(addrs);

    let res;
    try {
      res = await undiciFetch(currentUrl, {
        ...init,
        redirect: 'manual',
        dispatcher,
      });
    } finally {
      dispatcher.close().catch(() => {
        /* a close fails only on an Agent already destroyed: nothing is left to release */
      });
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        return limitBody(res, maxBodyBytes); // 3xx without Location — the answer as is
      }
      const next = new URL(location, currentUrl).toString();
      // Drain the redirect response body so its Agent's close completes.
      try { await res.arrayBuffer(); } catch { /* the hop is abandoned either way */ }
      currentUrl = next;
      continue;
    }
    return limitBody(res, maxBodyBytes);
  }
  throw createAppError('SSRF_BLOCKED', `Exceeded redirect limit (${MAX_REDIRECTS})`);
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
