/*
 * The OIDC login against a stub issuer on 127.0.0.1: its discovery, a JWKS
 * holding RS256 keys made here, and a token endpoint answering ID tokens signed
 * here. The issuer is a loopback address, so every passing login also shows the
 * operator fetch reaching one.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';

import { beginLogin, completeLogin } from './oidc.js';

const CLIENT_ID = 'wisp-client';
const CLIENT_SECRET = 'wisp-secret';
const REDIRECT_URI = 'http://wisp.test/api/auth/oidc/callback';

function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const key1 = makeKey('k1');
const key2 = makeKey('k2');
const stranger = makeKey('k1'); // claims k1's kid, signed by another key

/** What the stub serves and what it saw. */
const stub = {
  jwks: [key1.jwk],
  hits: { discovery: 0, jwks: 0, token: 0, redirectTarget: 0 },
  /** The token endpoint's next answer: `{ status, body }`. */
  tokenAnswer: null,
  /** The last token request: its Authorization header and form fields. */
  tokenRequest: null,
};

let server;
let base;
let issuer;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/idp/.well-known/openid-configuration') {
        stub.hits.discovery += 1;
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
      } else if (req.method === 'GET' && req.url === '/idp/jwks') {
        stub.hits.jwks += 1;
        json(res, 200, { keys: stub.jwks });
      } else if (req.method === 'POST' && req.url === '/idp/token') {
        stub.hits.token += 1;
        stub.tokenRequest = { authorization: req.headers.authorization, form: new URLSearchParams(raw) };
        json(res, stub.tokenAnswer.status, stub.tokenAnswer.body);
      } else if (req.url === '/huge/.well-known/openid-configuration') {
        json(res, 200, { issuer: `${base}/huge`, padding: 'x'.repeat(2 * 1024 * 1024) });
      } else if (req.url === '/moved/.well-known/openid-configuration') {
        res.writeHead(302, { location: '/idp/.well-known/openid-configuration' });
        res.end();
      } else {
        json(res, 404, { error: 'not_found' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  issuer = `${base}/idp`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function signIdToken(claims, { kid, privateKey }) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT', kid })}.${enc(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/** A login started, then completed with the ID token `claimsFor(nonce)` signed by `key`. */
async function login({ claimsFor = (nonce) => validClaims(nonce), key = key1 } = {}) {
  const { authorizationUrl } = await beginLogin({ issuer, clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  const params = new URL(authorizationUrl).searchParams;
  stub.tokenAnswer = { status: 200, body: { id_token: signIdToken(claimsFor(params.get('nonce')), key), token_type: 'Bearer' } };
  const result = await completeLogin({
    issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, state: params.get('state'), code: 'code-1',
  });
  return { result, params };
}

function validClaims(nonce) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: issuer, aud: CLIENT_ID, sub: 'user-1', nonce, iat: now, exp: now + 300 };
}

test('beginLogin reads the discovery and answers the authorization URL', async () => {
  const { authorizationUrl } = await beginLogin({ issuer, clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  const url = new URL(authorizationUrl);
  assert.equal(`${url.origin}${url.pathname}`, `${issuer}/authorize`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  for (const name of ['state', 'nonce', 'code_challenge']) assert.ok(url.searchParams.get(name), name);
  assert.equal(stub.hits.discovery, 1);
});

test('completeLogin exchanges the code and verifies the ID token', async () => {
  const { result, params } = await login();
  assert.equal(result.claims.sub, 'user-1');

  const { authorization, form } = stub.tokenRequest;
  assert.equal(authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'code-1');
  assert.equal(form.get('redirect_uri'), REDIRECT_URI);
  const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
  assert.equal(challenge, params.get('code_challenge'));
  // The discovery is cached across logins.
  assert.equal(stub.hits.discovery, 1);
});

test('a login state is used once', async () => {
  const { params } = await login();
  await assert.rejects(completeLogin({
    issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, state: params.get('state'), code: 'code-1',
  }), { code: 'OIDC_STATE_INVALID' });
});

test('an ID token with another nonce, issuer or audience, or a bad signature, is refused', async () => {
  const cases = [
    { claimsFor: (nonce) => ({ ...validClaims(nonce), nonce: 'other' }), message: /nonce/ },
    { claimsFor: (nonce) => ({ ...validClaims(nonce), iss: `${base}/elsewhere` }), message: /issuer/ },
    { claimsFor: (nonce) => ({ ...validClaims(nonce), aud: 'another-client' }), message: /audience/ },
    { key: stranger, message: /signature/ },
  ];
  for (const { message, ...opts } of cases) {
    await assert.rejects(login(opts), (err) => err.code === 'OIDC_TOKEN_INVALID' && message.test(err.message));
  }
});

test('an unknown kid fetches the JWKS again, once', async () => {
  const jwksBefore = stub.hits.jwks;
  stub.jwks = [key1.jwk, key2.jwk];
  const { result } = await login({ key: key2 });
  assert.equal(result.claims.sub, 'user-1');
  assert.equal(stub.hits.jwks, jwksBefore + 1);
});

test('a token endpoint answering 400 fails the exchange', async () => {
  const { authorizationUrl } = await beginLogin({ issuer, clientId: CLIENT_ID, redirectUri: REDIRECT_URI });
  stub.tokenAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'code expired' } };
  await assert.rejects(completeLogin({
    issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    state: new URL(authorizationUrl).searchParams.get('state'), code: 'code-1',
  }), (err) => err.code === 'OIDC_TOKEN_EXCHANGE_FAILED' && /code expired/.test(err.message));
});

test('a discovery that redirects or is missing fails, the redirect not followed', async () => {
  const discoveries = stub.hits.discovery;
  await assert.rejects(
    beginLogin({ issuer: `${base}/moved`, clientId: CLIENT_ID, redirectUri: REDIRECT_URI }),
    (err) => err.code === 'OIDC_DISCOVERY_FAILED' && /\(302\)/.test(err.message),
  );
  await assert.rejects(
    beginLogin({ issuer: `${base}/missing`, clientId: CLIENT_ID, redirectUri: REDIRECT_URI }),
    { code: 'OIDC_DISCOVERY_FAILED' },
  );
  assert.equal(stub.hits.discovery, discoveries);
});

test('a discovery past the size bound fails, its body not read whole', async () => {
  await assert.rejects(
    beginLogin({ issuer: `${base}/huge`, clientId: CLIENT_ID, redirectUri: REDIRECT_URI }),
    (err) => err.code === 'OIDC_PROVIDER_UNREACHABLE' && /larger than 1048576 bytes/.test(err.message),
  );
});

test('an issuer that does not answer is unreachable', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    beginLogin({ issuer: `http://127.0.0.1:${port}`, clientId: CLIENT_ID, redirectUri: REDIRECT_URI }),
    { code: 'OIDC_PROVIDER_UNREACHABLE' },
  );
});
