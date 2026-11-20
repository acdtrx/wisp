/*
 * The SSO routes of the real app (built without listening, as in app.test.js),
 * SSO enabled against a stub issuer on 127.0.0.1: only a GET completes a
 * login. Fastify answers a HEAD on a GET route by running the GET handler, so
 * without this a HEAD on the callback would consume the state and set the
 * session cookies.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

const CLIENT_ID = 'wisp-client';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

/** The nonce of the login the stub's token endpoint answers for. */
let nonce;
let issuer;

function signIdToken(claims) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${enc(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const stub = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/.well-known/openid-configuration') {
      json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      });
    } else if (req.url === '/jwks') {
      json({ keys: [jwk] });
    } else if (req.url === '/token') {
      const now = Math.floor(Date.now() / 1000);
      json({ id_token: signIdToken({ iss: issuer, aud: CLIENT_ID, sub: 'user-1', nonce, iat: now, exp: now + 300 }) });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
issuer = `http://127.0.0.1:${stub.address().port}`;

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-oidc-test-'));
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  oidc: { enabled: true, issuer, clientId: CLIENT_ID, clientSecret: 'wisp-secret' },
}));
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

let app;

before(async () => {
  const { setPassword } = await import('../lib/auth.js');
  setPassword('test-login-password');
  const { buildApp } = await import('../app.js');
  ({ app } = await buildApp(Fastify({ logger: { level: 'silent' } }).log));
});

after(async () => {
  await app?.close();
  stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('a HEAD on the SSO routes is no route: it neither starts nor completes a login', async () => {
  const headLogin = await app.inject({ method: 'HEAD', url: '/api/auth/oidc/login' });
  assert.equal(headLogin.statusCode, 404);
  assert.equal(headLogin.headers.location, undefined);

  const start = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
  assert.equal(start.statusCode, 302);
  const authorize = new URL(start.headers.location);
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${issuer}/authorize`);
  const state = authorize.searchParams.get('state');
  nonce = authorize.searchParams.get('nonce');
  const callback = `/api/auth/oidc/callback?code=code-1&state=${encodeURIComponent(state)}`;

  const head = await app.inject({ method: 'HEAD', url: callback });
  assert.equal(head.statusCode, 404);
  assert.equal(head.headers['set-cookie'], undefined);

  // The state is still unused: the GET completes the login.
  const get = await app.inject({ method: 'GET', url: callback });
  assert.equal(get.statusCode, 302);
  assert.equal(get.headers.location, '/');
  assert.ok(get.cookies.some((c) => c.name === 'wisp_session' && c.value));
});
