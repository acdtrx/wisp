/**
 * OIDC (OpenID Connect) authorization-code login for the single-user app.
 *
 * Wisp stays single-user: a successful OIDC login is treated exactly like a
 * correct password — it yields the same `wisp_session` JWT (still signed with
 * the password-derived secret). Access control is delegated to the identity
 * provider (restrict the Wisp OIDC client to your own user/group there); Wisp
 * accepts any subject that authenticates, but still fully validates the ID
 * token (issuer, audience, expiry, nonce, and JWKS signature).
 *
 * No third-party OIDC/JWT library — discovery + token exchange go over
 * `fetch`, and ID-token signatures are verified with `node:crypto` (RS256 /
 * ES256 via `createPublicKey({ format: 'jwk' })`), matching the project's
 * "no JWT library / minimize dependencies" rules. The confidential-client
 * flow uses PKCE in addition to the client secret.
 */
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { createAppError } from './routeErrors.js';

const HTTP_TIMEOUT_MS = 10_000;
// Discovery + JWKS rarely change; cache to avoid a round-trip per login.
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
// A login must complete (browser round-trip through the IdP) within this window.
const PENDING_TTL_MS = 10 * 60 * 1000; // 10m
const PENDING_SWEEP_MS = 60 * 1000;
const PENDING_MAX_ENTRIES = 1000;
// Small tolerance for clock skew between Wisp and the IdP when checking exp/nbf.
const CLOCK_SKEW_SECONDS = 60;

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function decodeJwtSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

async function fetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
  } catch (err) {
    throw createAppError('OIDC_PROVIDER_UNREACHABLE', `Could not reach identity provider: ${err.message}`);
  }
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body — surfaced below via status check */
    }
  }
  return { ok: res.ok, status: res.status, body, text };
}

/* ---------------------------------------------------------------- discovery */

const discoveryCache = new Map(); // issuer -> { at, doc }

function normalizeIssuer(issuer) {
  // Trailing slash matters for the well-known path; drop it consistently.
  return issuer.replace(/\/+$/, '');
}

async function discover(issuer) {
  const key = normalizeIssuer(issuer);
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;

  const url = `${key}/.well-known/openid-configuration`;
  const { ok, status, body } = await fetchJson(url);
  if (!ok || !body) {
    throw createAppError('OIDC_DISCOVERY_FAILED', `OIDC discovery failed (${status}) at ${url}`);
  }
  if (!body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
    throw createAppError('OIDC_DISCOVERY_FAILED', 'OIDC discovery document is missing required endpoints');
  }
  const doc = {
    issuer: body.issuer || key,
    authorizationEndpoint: body.authorization_endpoint,
    tokenEndpoint: body.token_endpoint,
    jwksUri: body.jwks_uri,
    tokenAuthMethods: Array.isArray(body.token_endpoint_auth_methods_supported)
      ? body.token_endpoint_auth_methods_supported
      : null,
  };
  discoveryCache.set(key, { at: Date.now(), doc });
  return doc;
}

/* --------------------------------------------------------------------- jwks */

const jwksCache = new Map(); // jwksUri -> { at, keys }

async function loadJwks(jwksUri, { force = false } = {}) {
  const cached = jwksCache.get(jwksUri);
  if (!force && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const { ok, status, body } = await fetchJson(jwksUri);
  if (!ok || !body || !Array.isArray(body.keys)) {
    throw createAppError('OIDC_JWKS_FAILED', `Could not fetch signing keys (${status})`);
  }
  jwksCache.set(jwksUri, { at: Date.now(), keys: body.keys });
  return body.keys;
}

async function findSigningKey(jwksUri, kid) {
  let keys = await loadJwks(jwksUri);
  let jwk = keys.find((k) => (kid ? k.kid === kid : true));
  if (!jwk) {
    // Unknown kid — provider may have rotated keys since our cache. Refetch once.
    keys = await loadJwks(jwksUri, { force: true });
    jwk = keys.find((k) => (kid ? k.kid === kid : true));
  }
  if (!jwk) throw createAppError('OIDC_TOKEN_INVALID', 'No matching signing key for ID token');
  return jwk;
}

// Map a JWS alg to node's crypto.verify args. Only asymmetric algs a public
// JWKS can carry are supported (RS256 is Pocket ID's default; ES256 covered too).
function verifyArgsForAlg(alg, keyObject) {
  switch (alg) {
    case 'RS256':
      return ['sha256', keyObject];
    case 'RS384':
      return ['sha384', keyObject];
    case 'RS512':
      return ['sha512', keyObject];
    case 'ES256':
      return ['sha256', { key: keyObject, dsaEncoding: 'ieee-p1363' }];
    case 'ES384':
      return ['sha384', { key: keyObject, dsaEncoding: 'ieee-p1363' }];
    default:
      throw createAppError('OIDC_TOKEN_INVALID', `Unsupported ID token signature algorithm: ${alg}`);
  }
}

async function verifyIdToken(idToken, { issuer, clientId, nonce, jwksUri }) {
  if (typeof idToken !== 'string') throw createAppError('OIDC_TOKEN_INVALID', 'No ID token returned');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw createAppError('OIDC_TOKEN_INVALID', 'Malformed ID token');

  let header;
  try {
    header = decodeJwtSegment(parts[0]);
  } catch {
    throw createAppError('OIDC_TOKEN_INVALID', 'Malformed ID token header');
  }
  if (!header?.alg || header.alg === 'none') {
    throw createAppError('OIDC_TOKEN_INVALID', 'ID token has no signature algorithm');
  }

  const jwk = await findSigningKey(jwksUri, header.kid);
  let keyObject;
  try {
    keyObject = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    throw createAppError('OIDC_TOKEN_INVALID', 'Signing key could not be parsed');
  }

  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  const [algName, keyArg] = verifyArgsForAlg(header.alg, keyObject);
  const sigOk = cryptoVerify(algName, signingInput, keyArg, signature);
  if (!sigOk) throw createAppError('OIDC_TOKEN_INVALID', 'ID token signature verification failed');

  let claims;
  try {
    claims = decodeJwtSegment(parts[1]);
  } catch {
    throw createAppError('OIDC_TOKEN_INVALID', 'Malformed ID token payload');
  }

  // Issuer must match the configured/discovered issuer exactly.
  if (normalizeIssuer(claims.iss || '') !== normalizeIssuer(issuer)) {
    throw createAppError('OIDC_TOKEN_INVALID', 'ID token issuer mismatch');
  }
  // Audience must include our client id.
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) {
    throw createAppError('OIDC_TOKEN_INVALID', 'ID token audience mismatch');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw createAppError('OIDC_TOKEN_INVALID', 'ID token has expired');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw createAppError('OIDC_TOKEN_INVALID', 'ID token not yet valid');
  }
  // Nonce binds the ID token to the login we started (replay defence).
  if (nonce && claims.nonce !== nonce) {
    throw createAppError('OIDC_TOKEN_INVALID', 'ID token nonce mismatch');
  }
  return claims;
}

/* --------------------------------------------------------- pending logins */

const pending = new Map(); // state -> { nonce, codeVerifier, redirectUri, createdAt }

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(state);
  }
}, PENDING_SWEEP_MS).unref();

/* ---------------------------------------------------------------- public API */

/**
 * Start an OIDC login. Generates state + nonce + PKCE, stashes them keyed by
 * state, and returns the provider authorization URL to redirect the browser to.
 *
 * @param {{ issuer: string, clientId: string, redirectUri: string, scope?: string }} cfg
 * @returns {Promise<{ authorizationUrl: string }>}
 */
export async function beginLogin({ issuer, clientId, redirectUri, scope = 'openid profile email' }) {
  const doc = await discover(issuer);

  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(16));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  if (pending.size >= PENDING_MAX_ENTRIES) {
    // Bounded — a flood of un-completed logins can't grow the map without limit.
    // The sweep clears expired entries; until then, refuse new starts.
    throw createAppError('OIDC_BUSY', 'Too many in-flight logins; try again shortly');
  }
  pending.set(state, { nonce, codeVerifier, redirectUri, createdAt: Date.now() });

  const url = new URL(doc.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  return { authorizationUrl: url.toString() };
}

function pickAuthMethod(methods) {
  if (!methods) return 'client_secret_basic';
  if (methods.includes('client_secret_basic')) return 'client_secret_basic';
  if (methods.includes('client_secret_post')) return 'client_secret_post';
  return 'client_secret_basic';
}

/**
 * Complete an OIDC login from the provider redirect. Validates the state,
 * exchanges the code for tokens, and validates the ID token. Returns the
 * verified claims (e.g. `sub`, `email`) — the caller issues the session.
 *
 * @param {{ issuer: string, clientId: string, clientSecret: string, state: string, code: string }} args
 * @returns {Promise<{ claims: object }>}
 */
export async function completeLogin({ issuer, clientId, clientSecret, state, code }) {
  if (!state || !code) throw createAppError('OIDC_CALLBACK_INVALID', 'Missing state or code');
  const entry = pending.get(state);
  // One-time use — consume immediately so a replayed callback can't reuse it.
  if (entry) pending.delete(state);
  if (!entry) throw createAppError('OIDC_STATE_INVALID', 'Unknown or expired login state');
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    throw createAppError('OIDC_STATE_INVALID', 'Login state expired');
  }

  const doc = await discover(issuer);
  const authMethod = pickAuthMethod(doc.tokenAuthMethods);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: entry.redirectUri,
    code_verifier: entry.codeVerifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (authMethod === 'client_secret_basic') {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  const { ok, status, body: tokenBody } = await fetchJson(doc.tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  if (!ok || !tokenBody) {
    const detail = tokenBody?.error_description || tokenBody?.error || `token endpoint returned ${status}`;
    throw createAppError('OIDC_TOKEN_EXCHANGE_FAILED', `Token exchange failed: ${detail}`);
  }

  const claims = await verifyIdToken(tokenBody.id_token, {
    issuer,
    clientId,
    nonce: entry.nonce,
    jwksUri: doc.jwksUri,
  });
  return { claims };
}
