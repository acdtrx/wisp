/*
 * The signing request Wisp encodes, read back by openssl (the test may run it;
 * the backend does not): its signature verifies, it names the domain and its
 * wildcard as DNS names, and a domain longer than a common name may be fits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';

import { buildSigningRequest } from './signingRequest.js';

function readByOpenssl(der) {
  return execFileSync('openssl', ['req', '-inform', 'DER', '-noout', '-text', '-verify'], {
    input: der,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}

test('openssl reads the request: the signature verifies and the names are the domain and its wildcard', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const text = readByOpenssl(buildSigningRequest('home.example.com', key));
  assert.match(text, /DNS:home\.example\.com, DNS:\*\.home\.example\.com/);
  assert.match(text, /ecdsa-with-SHA256/);
  assert.match(text, /Requested Extensions:/);
});

test('a domain of 200 characters is encoded with long-form lengths and still verifies', () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const domain = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`;
  const text = readByOpenssl(buildSigningRequest(domain, key));
  assert.ok(text.includes(`DNS:${domain}, DNS:*.${domain}`));
});
