/**
 * An ACME client (RFC 8555), as the host's certificate needs it: an account
 * without contact, an order, its authorizations' DNS challenges, the
 * finalization and the chain. It follows the standard, not one authority's
 * habits: every URL comes from the directory or an answer, each request
 * carries the latest nonce and a `badNonce` refusal is retried with the new
 * one, and nothing is assumed instant — statuses are polled, Retry-After
 * honoured.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';

import { createAppError, wrapAppError } from '../appErrors.js';
import { ssrfSafeFetch } from '../outbound/index.js';
import { retryAfterMs, waitBetweenTries } from './waiting.js';

/** One ACME round trip, its body included. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A directory, an order or a chain is a few KB. */
const MAX_BODY_BYTES = 1024 * 1024;
/** A request refused for its nonce is sent again with the fresh one, this many times. */
const BAD_NONCE_RETRIES = 5;
/** How long an authorization may stay `pending` once its challenge is answered, and an order `processing`. */
const STATUS_WAIT_MS = 5 * 60_000;

const BAD_NONCE = 'urn:ietf:params:acme:error:badNonce';

export function base64url(data) {
  return Buffer.from(data).toString('base64url');
}

/** The account key's public JWK, its members in the order RFC 7638 hashes them. */
function publicJwk(key) {
  const { crv, kty, x, y } = key.export({ format: 'jwk' });
  return { crv, kty, x, y };
}

/** The JWK thumbprint (RFC 7638) of the account key: what a key authorization ends with. */
function thumbprint(key) {
  return base64url(createHash('sha256').update(JSON.stringify(publicJwk(key))).digest());
}

/** A new ECDSA P-256 key, as a KeyObject. */
export function newEcKey() {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

/** The authority's refusal, from its problem document (RFC 8555 §6.7). */
function problemError(what, res, problem) {
  const parts = [];
  if (problem && typeof problem === 'object') {
    if (problem.type) parts.push(String(problem.type).replace(/^urn:ietf:params:acme:error:/, ''));
    if (problem.detail) parts.push(String(problem.detail));
    for (const sub of Array.isArray(problem.subproblems) ? problem.subproblems : []) {
      if (sub?.detail) parts.push(`${sub.identifier?.value ?? ''} ${sub.detail}`.trim());
    }
  }
  // One line: the detail shows the authority's words, never a layout of its own.
  const cause = parts.length ? parts.join(': ').replace(/\s+/g, ' ').trim() : `HTTP ${res.status}`;
  return createAppError('CERTIFICATE_ISSUE_FAILED', `The certificate authority refused ${what}`, cause);
}

async function readBody(res) {
  const type = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (/json/.test(type)) {
    try {
      return JSON.parse(text);
    } catch {
      return null; // a JSON type with no JSON: an answer with no document
    }
  }
  return text;
}

/**
 * A client for the directory at `directoryUrl`, signing with the account in
 * `account` (`{ directory, url, key }`, the key a private JWK) when it was
 * registered under that directory, else with a new account it registers.
 * Resolves `{ client, account }`: the account as it is now, to keep.
 */
export async function openAcmeAccount({ directoryUrl, account, signal }) {
  const timed = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS));

  async function fetchAcme(url, init, what) {
    try {
      return await ssrfSafeFetch(url, { ...init, signal: timed(), maxBodyBytes: MAX_BODY_BYTES });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      throw wrapAppError('CERTIFICATE_ISSUE_FAILED', `The certificate authority could not be reached for ${what}`, err);
    }
  }

  const dirRes = await fetchAcme(directoryUrl, { method: 'GET', headers: { accept: 'application/json' } }, 'its directory');
  const directory = await readBody(dirRes);
  if (!dirRes.ok || !directory || typeof directory !== 'object' || !directory.newNonce || !directory.newAccount || !directory.newOrder) {
    throw problemError('the directory request', dirRes, directory);
  }

  let nonce = null;
  const keepNonce = (res) => {
    const fresh = res.headers.get('replay-nonce');
    if (fresh) nonce = fresh;
  };

  async function freshNonce() {
    const res = await fetchAcme(directory.newNonce, { method: 'HEAD' }, 'a nonce');
    keepNonce(res);
    if (!nonce) throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The certificate authority gave no nonce', `HTTP ${res.status}`);
  }

  const reuse = account && account.directory === directoryUrl && account.url && account.key;
  const key = reuse ? createPrivateKey({ key: account.key, format: 'jwk' }) : newEcKey();
  let kid = reuse ? account.url : null;

  /**
   * POST a JWS to `url`: `payload` an object, or null for POST-as-GET.
   * Resolves `{ res, body }` for a 2xx; a refusal throws its problem.
   */
  async function post(url, payload, what, { accept } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      if (!nonce) await freshNonce();
      const header = { alg: 'ES256', nonce, url, ...(kid ? { kid } : { jwk: publicJwk(key) }) };
      nonce = null;
      const protected64 = base64url(JSON.stringify(header));
      const payload64 = payload === null ? '' : base64url(JSON.stringify(payload));
      const signature = sign('sha256', Buffer.from(`${protected64}.${payload64}`), { key, dsaEncoding: 'ieee-p1363' });
      const res = await fetchAcme(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json', ...(accept ? { accept } : {}) },
        body: JSON.stringify({ protected: protected64, payload: payload64, signature: base64url(signature) }),
      }, what);
      keepNonce(res);
      const body = await readBody(res);
      if (res.ok) return { res, body };
      if (body?.type === BAD_NONCE && attempt < BAD_NONCE_RETRIES) continue;
      throw problemError(what, res, body);
    }
  }

  if (!kid) {
    const { res } = await post(directory.newAccount, { termsOfServiceAgreed: true }, 'the new account');
    kid = res.headers.get('location');
    if (!kid) throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The certificate authority gave the new account no URL');
  }

  /**
   * POST-as-GET `url` until `done(body)` says the status settled, honouring
   * Retry-After, within STATUS_WAIT_MS. Resolves the settled body.
   */
  async function pollUntil(url, what, done) {
    const deadline = Date.now() + STATUS_WAIT_MS;
    for (let attempt = 0; ; attempt += 1) {
      const { res, body } = await post(url, null, what);
      if (done(body)) return body;
      if (Date.now() >= deadline) {
        throw createAppError('CERTIFICATE_ISSUE_FAILED', `The certificate authority left ${what} ${body?.status ?? 'unsettled'} for ${STATUS_WAIT_MS / 60_000} minutes`);
      }
      await waitBetweenTries(attempt, retryAfterMs(res.headers.get('retry-after')), deadline, signal);
    }
  }

  const accountKeyThumbprint = thumbprint(key);

  const client = {
    /** `{ url, order }` for an order of `names` (DNS identifiers). */
    async newOrder(names) {
      const { res, body } = await post(directory.newOrder, { identifiers: names.map((value) => ({ type: 'dns', value })) }, 'the order');
      const url = res.headers.get('location');
      if (!url || !Array.isArray(body?.authorizations) || !body.finalize) {
        throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The certificate authority answered the order without its URLs');
      }
      return { url, order: body };
    },
    async getAuthorization(url) {
      return (await post(url, null, 'an authorization')).body;
    },
    /** The TXT value that answers a dns-01 challenge's token (RFC 8555 §8.4). */
    dnsChallengeValue(token) {
      return base64url(createHash('sha256').update(`${token}.${accountKeyThumbprint}`).digest());
    },
    /** Tell the authority to check the challenge at `url`. */
    async answerChallenge(url) {
      await post(url, {}, 'the challenge answer');
    },
    /** Wait until the authorization at `url` is no longer `pending`; resolves it. */
    waitForAuthorization(url) {
      return pollUntil(url, 'an authorization', (body) => body?.status !== 'pending');
    },
    /** Wait until the order at `url` is past `pending` (all authorizations judged); resolves it. */
    waitForOrderReady(url) {
      return pollUntil(url, 'the order', (body) => body?.status !== 'pending');
    },
    /** Send the DER signing request; resolves the order as it answers. */
    async finalize(finalizeUrl, csrDer) {
      return (await post(finalizeUrl, { csr: base64url(csrDer) }, 'the finalization')).body;
    },
    /** Wait until the order at `url` is past `processing`; resolves it. */
    waitForOrderIssued(url) {
      return pollUntil(url, 'the order', (body) => body?.status !== 'processing' && body?.status !== 'ready');
    },
    /** The PEM chain at `url`, exactly as delivered. */
    async downloadChain(url) {
      const { body } = await post(url, null, 'the certificate download', { accept: 'application/pem-certificate-chain' });
      if (typeof body !== 'string' || !body.includes('-----BEGIN CERTIFICATE-----')) {
        throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The certificate authority answered the download with no certificate');
      }
      return body;
    },
  };

  return { client, account: { directory: directoryUrl, url: kid, key: key.export({ format: 'jwk' }) } };
}
