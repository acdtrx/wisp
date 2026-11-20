/**
 * The fetch for an endpoint only the operator sets: the OIDC issuer, and the
 * endpoints its discovery document names.
 */
import { fetch as undiciFetch } from 'undici';

import { createAppError } from '../appErrors.js';
import { isAllowedUrl } from './downloadFromUrl.js';
import { limitBody } from './downloadUtils.js';

/** Discovery, a JWKS, a token exchange: one short round trip each, its body included. */
const OPERATOR_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fetch `urlStr`, an endpoint the operator configured. Use it only there: every
 * other URL — one from user input, or a public source Wisp names but whose
 * redirects it does not control — goes through `ssrfSafeFetch`, which refuses
 * private and loopback addresses.
 *
 * - Private and loopback addresses are allowed, so an identity provider on the
 *   LAN works: the operator, not a request, chose the host.
 * - No redirect is followed: a 3xx comes back as the answer, which a caller
 *   that wants a 2xx treats as a failure. A token exchange carries the client
 *   secret, which must reach only the endpoint the discovery named.
 * - One total bound over the request and its body, combined with the caller's
 *   `init.signal` when given; and `maxBodyBytes`, a bound on the body's size,
 *   which then fails with DOWNLOAD_FAILED past it (see `limitBody`).
 *
 * Only `http:` and `https:` URLs: anything else throws INVALID_URL. A network
 * failure or an abort rejects with the platform's error, for the caller to wrap.
 */
export async function fetchOperatorEndpoint(urlStr, { maxBodyBytes, ...init } = {}) {
  if (!isAllowedUrl(urlStr)) {
    throw createAppError('INVALID_URL', 'Only HTTP and HTTPS URLs are allowed');
  }
  const deadline = AbortSignal.timeout(OPERATOR_REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return limitBody(await undiciFetch(urlStr, { ...init, redirect: 'manual', signal }), maxBodyBytes);
}
