/**
 * Cloudflare's DNS API, as the certificate needs it: the zone that holds a
 * domain, and the TXT records of the DNS challenge. The token travels in the
 * Authorization header only, and no message here carries it.
 */
import { createAppError, wrapAppError } from '../appErrors.js';
import { ssrfSafeFetch } from '../outbound/index.js';

const API = 'https://api.cloudflare.com/client/v4';
/** One small JSON round trip: 15 s over its DNS lookup, the request and the body. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A zone lookup or a record answer is a few KB. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Cloudflare's own words for a refusal: the `errors` of its answer. */
function cloudflareMessage(data, status) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const text = errors
    .map((e) => (e && typeof e === 'object' ? [e.code, e.message].filter(Boolean).join(' ') : String(e)))
    .filter(Boolean)
    .join('; ');
  // One line: the detail shows Cloudflare's words, never a layout of its own.
  return text.replace(/\s+/g, ' ').trim() || `HTTP ${status}`;
}

/** Cloudflare's error codes that say the request's credential is refused, whatever the status. */
const AUTH_ERROR_CODES = new Set([6003, 6111, 9106, 9109, 10000]);

/** Whether a refusal is of the token: 401 or 403, or a 400 Cloudflare explains by one of its authentication codes. */
function refusesToken(status, data, badRequestIsToken) {
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  if (badRequestIsToken) return true;
  return (Array.isArray(data?.errors) ? data.errors : []).some((e) => AUTH_ERROR_CODES.has(Number(e?.code)));
}

/**
 * One API call. A failure to reach Cloudflare, or an answer that is not its
 * JSON, is CERTIFICATE_DNS_UNAVAILABLE; a refused token (`refusesToken`)
 * CERTIFICATE_TOKEN_REJECTED; any other refusal CERTIFICATE_DNS_UNAVAILABLE
 * with Cloudflare's message (a record refused, e.g. 81058 "identical record
 * already exists", is not the token's fault). `badRequestIsToken`: a 400 can
 * only be the Authorization header (the zone lookup, a bare GET). A status in
 * `absentStatus` resolves null. The caller's `signal` aborting rejects with its
 * reason, untouched.
 */
async function call(token, method, path, { body, signal, absentStatus, badRequestIsToken = false } = {}) {
  const bound = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const init = {
    method,
    headers,
    signal: signal ? AbortSignal.any([signal, bound]) : bound,
    maxBodyBytes: MAX_BODY_BYTES,
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  let data;
  try {
    res = await ssrfSafeFetch(`${API}${path}`, init);
    if (res.status === absentStatus) {
      await res.body?.cancel();
      return null;
    }
    data = await res.json();
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw wrapAppError('CERTIFICATE_DNS_UNAVAILABLE', 'Cloudflare could not be reached', err);
  }
  if (refusesToken(res.status, data, badRequestIsToken)) {
    throw createAppError('CERTIFICATE_TOKEN_REJECTED', 'Cloudflare refused the API token', cloudflareMessage(data, res.status));
  }
  if (!res.ok || data?.success !== true) {
    throw createAppError('CERTIFICATE_DNS_UNAVAILABLE', `Cloudflare answered HTTP ${res.status}`, cloudflareMessage(data, res.status));
  }
  return data.result;
}

/**
 * The names a domain's zone can be: the domain itself, then each parent down
 * to two labels (`a.home.example.com`, `home.example.com`, `example.com`).
 */
function zoneCandidates(domain) {
  const labels = domain.split('.');
  const out = [];
  for (let i = 0; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

/**
 * The Cloudflare zone that holds `domain`: the domain itself or its nearest
 * parent that the token sees as a zone. `{ id, name, nameServers }`.
 * Throws CERTIFICATE_ZONE_NOT_FOUND when none is, and the codes of `call`.
 */
export async function findZone(domain, token, { signal } = {}) {
  for (const name of zoneCandidates(domain)) {
    const result = await call(token, 'GET', `/zones?name=${encodeURIComponent(name)}`, { signal, badRequestIsToken: true });
    const zone = Array.isArray(result) ? result.find((z) => z?.name === name) : null;
    if (zone) {
      return {
        id: String(zone.id),
        name: zone.name,
        nameServers: Array.isArray(zone.name_servers) ? zone.name_servers.filter((ns) => typeof ns === 'string') : [],
      };
    }
  }
  throw createAppError(
    'CERTIFICATE_ZONE_NOT_FOUND',
    `The Cloudflare token sees no zone that holds ${domain}`,
    'Give the token Zone:Read and DNS:Edit on the zone of the domain',
  );
}

/** Write a TXT record into the zone; resolves its record id. */
export async function createTxtRecord(token, zoneId, name, value, { signal } = {}) {
  const result = await call(token, 'POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
    body: { type: 'TXT', name, content: value, ttl: 60 },
    signal,
  });
  return String(result?.id);
}

/** Remove a record Wisp wrote; one already gone (404) counts as removed. */
export async function deleteTxtRecord(token, zoneId, recordId, { signal } = {}) {
  await call(token, 'DELETE', `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`, {
    signal,
    absentStatus: 404,
  });
}
