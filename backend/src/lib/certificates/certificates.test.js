/*
 * The certificate client against stand-ins (node --test
 * --experimental-test-module-mocks): the outbound fetch answers as a
 * certificate authority (RFC 8555) and as Cloudflare's API would, and the DNS
 * resolver answers with the records the stand-in Cloudflare holds. The
 * authority checks every JWS signature and nonce, and signs the request it is
 * sent with a CA of the test's own (openssl), so the chain is a real one.
 */
import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CA = 'https://acme.test';
const CF = 'https://api.cloudflare.com/client/v4';
const TOKEN = 'cf-token-secret';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-certificates-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const caKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync(path.join(dir, 'ca.key'), caKey);
writeFileSync(
  path.join(dir, 'ca.pem'),
  execFileSync('openssl', ['req', '-new', '-x509', '-key', path.join(dir, 'ca.key'), '-subj', '/CN=Stand-in CA', '-days', '1']),
);

/** What the stand-ins did and will do; reset before each test. */
let world;

function freshWorld() {
  return {
    nonces: new Set(),
    nextNonce: 1,
    badNonceOnce: false,
    accounts: new Map(), // kid → public key
    authz: new Map(), // url → { domain, wildcard, token, status, polls }
    order: null,
    readOnlyToken: false,
    tokenRejected: false,
    cloudflareDown: false,
    zones: { 'example.com': { id: 'zone-1', name: 'example.com', name_servers: ['ns1.cf.test', 'ns2.cf.test'] } },
    records: new Map(), // id → { zoneId, name, content }
    nextRecord: 1,
    invalidChallenge: false,
    log: [],
  };
}

function nonce() {
  const n = `nonce-${world.nextNonce++}`;
  world.nonces.add(n);
  return n;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function acmeJson(status, body, headers = {}) {
  return json(status, body, { 'replay-nonce': nonce(), ...headers });
}

function problem(status, type, detail) {
  return new Response(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'replay-nonce': nonce() },
  });
}

/** The JWS sent to the authority: its header and payload, its signature checked. */
function openJws(body) {
  const { protected: p, payload, signature } = JSON.parse(body);
  const header = JSON.parse(Buffer.from(p, 'base64url').toString());
  const key = header.jwk ? createPublicKey({ key: header.jwk, format: 'jwk' }) : world.accounts.get(header.kid);
  assert.ok(key, 'the JWS names a known account or carries its key');
  const ok = verify('sha256', Buffer.from(`${p}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  assert.ok(ok, 'the JWS signature verifies');
  return { header, key, payload: payload === '' ? null : JSON.parse(Buffer.from(payload, 'base64url').toString()) };
}

function orderBody() {
  const o = world.order;
  return {
    status: o.status,
    identifiers: o.names.map((value) => ({ type: 'dns', value })),
    authorizations: o.authz,
    finalize: `${CA}/finalize/1`,
    ...(o.status === 'valid' ? { certificate: `${CA}/cert/1` } : {}),
  };
}

function authzBody(url) {
  const a = world.authz.get(url);
  return {
    status: a.status,
    identifier: { type: 'dns', value: a.domain },
    wildcard: a.wildcard,
    challenges: [
      { type: 'http-01', url: `${url}/http`, token: 'not-this-one', status: 'pending' },
      {
        type: 'dns-01',
        url: `${url}/dns`,
        token: a.token,
        status: a.status,
        ...(a.status === 'invalid' ? { error: { type: 'urn:ietf:params:acme:error:unauthorized', detail: 'Incorrect TXT record found' } } : {}),
      },
    ],
  };
}

function authority(url, init) {
  if (url === `${CA}/directory`) {
    return json(200, { newNonce: `${CA}/nonce`, newAccount: `${CA}/account`, newOrder: `${CA}/order` });
  }
  if (url === `${CA}/nonce`) return new Response(null, { status: 200, headers: { 'replay-nonce': nonce() } });
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/jose+json');
  const { header, key, payload } = openJws(init.body);
  assert.equal(header.url, url, 'the JWS names the URL it is sent to');
  if (!world.nonces.delete(header.nonce)) return problem(400, 'badNonce', 'JWS has an invalid anti-replay nonce');
  if (world.badNonceOnce) {
    world.badNonceOnce = false;
    world.log.push('badNonce');
    return problem(400, 'badNonce', 'JWS has an invalid anti-replay nonce');
  }

  if (url === `${CA}/account`) {
    assert.deepEqual(payload, { termsOfServiceAgreed: true }, 'no contact');
    const kid = `${CA}/acct/${world.accounts.size + 1}`;
    world.accounts.set(kid, key);
    world.log.push('account');
    return acmeJson(201, { status: 'valid' }, { location: kid });
  }
  if (url === `${CA}/order`) {
    const names = payload.identifiers.map((i) => i.value);
    world.order = { names, status: 'pending', authz: [], polls: 0 };
    names.forEach((name, i) => {
      const authzUrl = `${CA}/authz/${i + 1}`;
      world.order.authz.push(authzUrl);
      world.authz.set(authzUrl, { domain: name.replace(/^\*\./, ''), wildcard: name.startsWith('*.'), token: `tok-${i + 1}`, status: 'pending', answered: false, polls: 0 });
    });
    world.log.push('order');
    return acmeJson(201, orderBody(), { location: `${CA}/order/1` });
  }
  const authzMatch = /^(https:\/\/acme\.test\/authz\/\d+)(\/dns)?$/.exec(url);
  if (authzMatch) {
    const a = world.authz.get(authzMatch[1]);
    if (authzMatch[2]) {
      a.answered = true;
      a.seen = [...world.records.values()].filter((r) => r.name === `_acme-challenge.${a.domain}`).map((r) => r.content);
      world.log.push(`answer ${authzMatch[1]}`);
      return acmeJson(200, { type: 'dns-01', status: 'processing' });
    }
    if (a.answered && a.status === 'pending') {
      a.polls += 1;
      // The first look after the answer is still pending: the client must wait.
      if (a.polls >= 2) a.status = world.invalidChallenge ? 'invalid' : 'valid';
      world.log.push(`authz ${a.status}`);
    }
    return acmeJson(200, authzBody(authzMatch[1]), { 'retry-after': '0' });
  }
  if (url === `${CA}/order/1`) {
    const o = world.order;
    if (o.status === 'pending' && [...world.authz.values()].every((a) => a.status === 'valid')) o.status = 'ready';
    if (o.status === 'processing') {
      o.polls += 1;
      if (o.polls >= 2) o.status = 'valid';
    }
    world.log.push(`order ${o.status}`);
    return acmeJson(200, orderBody(), { 'retry-after': '0' });
  }
  if (url === `${CA}/finalize/1`) {
    const csr = Buffer.from(payload.csr, 'base64url');
    const text = execFileSync('openssl', ['req', '-inform', 'DER', '-noout', '-text'], { input: csr }).toString();
    assert.match(text, /DNS:example\.com, DNS:\*\.example\.com|DNS:home\.example\.com, DNS:\*\.home\.example\.com/);
    world.cert = execFileSync('openssl', [
      'x509', '-req', '-inform', 'DER', '-in', '/dev/stdin', '-CA', path.join(dir, 'ca.pem'), '-CAkey', path.join(dir, 'ca.key'),
      '-days', '90', '-copy_extensions', 'copy',
    ], { input: csr, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    world.order.status = 'processing';
    world.log.push('finalize');
    return acmeJson(200, orderBody());
  }
  if (url === `${CA}/cert/1`) {
    assert.equal(init.headers.accept, 'application/pem-certificate-chain');
    return new Response(world.cert, { status: 200, headers: { 'content-type': 'application/pem-certificate-chain', 'replay-nonce': nonce() } });
  }
  throw new Error(`the stand-in authority has no ${url}`);
}

function cloudflare(url, init) {
  if (world.cloudflareDown) throw new TypeError('fetch failed');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`, 'the token travels in the Authorization header');
  assert.ok(!url.includes(TOKEN), 'never in the URL');
  if (world.tokenRejected) return json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
  const u = new URL(url);
  const route = u.pathname.replace('/client/v4', '');
  if (route === '/zones' && init.method === 'GET') {
    const zone = world.zones[u.searchParams.get('name')];
    world.log.push(`zone? ${u.searchParams.get('name')}`);
    return json(200, { success: true, errors: [], result: zone ? [zone] : [] });
  }
  const rec = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(route);
  if (rec && init.method === 'POST') {
    if (world.readOnlyToken) return json(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
    const body = JSON.parse(init.body);
    assert.equal(body.type, 'TXT');
    const id = `rec-${world.nextRecord++}`;
    world.records.set(id, { zoneId: rec[1], name: body.name, content: body.content });
    world.log.push(`txt+ ${body.name}`);
    return json(200, { success: true, errors: [], result: { id } });
  }
  if (rec && init.method === 'DELETE') {
    if (!world.records.delete(rec[2])) return json(404, { success: false, errors: [{ code: 81044, message: 'Record does not exist.' }] });
    world.log.push('txt-');
    return json(200, { success: true, errors: [], result: { id: rec[2] } });
  }
  throw new Error(`the stand-in Cloudflare has no ${init.method} ${route}`);
}

mock.module(new URL('../outbound/index.js', import.meta.url).href, {
  exports: {
    ssrfSafeFetch: async (url, init) => (url.startsWith(CF) ? cloudflare(url, init) : authority(url, init)),
  },
});

class StandInResolver {
  setServers(servers) {
    assert.deepEqual(servers, ['192.0.2.53', '192.0.2.54'], "the zone's own name servers are asked");
  }

  async resolveTxt(name) {
    const values = [...world.records.values()].filter((r) => r.name === name).map((r) => [r.content]);
    if (values.length === 0) throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' });
    return values;
  }
}

mock.module('node:dns/promises', {
  exports: {
    lookup: async (host) => [{ address: host === 'ns1.cf.test' ? '192.0.2.53' : '192.0.2.54', family: 4 }],
    Resolver: StandInResolver,
  },
});

const { findZone, issueCertificate } = await import('./index.js');

beforeEach(() => {
  world = freshWorld();
});

function issue(domain, extra = {}) {
  const steps = [];
  const recordWrites = [];
  let kept = null;
  const run = issueCertificate({
    domain,
    token: TOKEN,
    directoryUrl: `${CA}/directory`,
    account: null,
    onAccount: (account) => { kept = account; },
    onStep: (step) => steps.push(step),
    onRecords: (records) => recordWrites.push(records),
    ...extra,
  });
  return { run, steps, recordWrites, account: () => kept };
}

test('a domain inside a zone finds that zone, walking up the name', async () => {
  const zone = await findZone('home.example.com', TOKEN);
  assert.equal(zone.id, 'zone-1');
  assert.deepEqual(world.log, ['zone? home.example.com', 'zone? example.com']);
  await assert.rejects(findZone('example.org', TOKEN), { code: 'CERTIFICATE_ZONE_NOT_FOUND' });
});

test('Cloudflare refusing the token, and Cloudflare unreachable, each have their code', async () => {
  world.tokenRejected = true;
  await assert.rejects(findZone('example.com', TOKEN), (err) => err.code === 'CERTIFICATE_TOKEN_REJECTED' && /Authentication error/.test(err.raw));
  world = freshWorld();
  world.cloudflareDown = true;
  await assert.rejects(findZone('example.com', TOKEN), { code: 'CERTIFICATE_DNS_UNAVAILABLE' });
});

test('the client gets a certificate for the domain and its wildcard, waiting on pending authorizations and a processing order, and retrying a badNonce', async () => {
  world.badNonceOnce = true;
  const { run, steps, recordWrites, account } = issue('home.example.com');
  const issued = await run;

  assert.deepEqual(steps, ['account', 'order', 'dns', 'validate', 'finalize']);
  // The refused nonce was retried with the fresh one: the account was still made.
  assert.deepEqual(world.log.slice(0, 2), ['badNonce', 'account']);
  // An authorization answered `pending` after its challenge was answered, and the client looked again.
  assert.ok(world.log.includes('authz pending') && world.log.includes('authz valid'));
  // The order answered `processing` after the finalization, and the client looked again.
  const afterFinalize = world.log.slice(world.log.indexOf('finalize'));
  assert.deepEqual(afterFinalize, ['finalize', 'order processing', 'order valid', 'txt-', 'txt-']);
  // Each challenge was answered only once the TXT records were written.
  for (const a of world.authz.values()) assert.equal(a.seen.length, 2);

  const leaf = new X509Certificate(issued.chain);
  assert.equal(leaf.subjectAltName, 'DNS:home.example.com, DNS:*.home.example.com');
  assert.ok(leaf.checkPrivateKey(createPrivateKey(issued.key)));
  assert.equal(issued.validUntil, leaf.validToDate.toISOString());
  assert.equal(account().url, `${CA}/acct/1`);

  // The records are gone, and the last word on them is that none is left.
  assert.equal(world.records.size, 0);
  assert.deepEqual(recordWrites.at(-1), []);
});

test('a stored account of the same directory is used, not registered again', async () => {
  const first = issue('example.com');
  await first.run;
  world.log = [];
  const second = issue('example.com', { account: first.account() });
  await second.run;
  assert.ok(!world.log.includes('account'));
  assert.equal(world.accounts.size, 1);
});

test('a failed validation names the step and the authority\'s message, and removes the records', async () => {
  world.invalidChallenge = true;
  const { run, recordWrites } = issue('example.com');
  await assert.rejects(run, (err) => {
    assert.equal(err.code, 'CERTIFICATE_ISSUE_FAILED');
    assert.match(err.message, /step "validate"/);
    assert.match(err.raw, /Incorrect TXT record found/);
    return true;
  });
  assert.equal(world.records.size, 0);
  assert.deepEqual(recordWrites.at(-1), []);
});

test('a token that may read the zone but not edit it fails at the dns step, with Cloudflare\'s message', async () => {
  world.readOnlyToken = true;
  const { run } = issue('example.com');
  await assert.rejects(run, (err) => err.code === 'CERTIFICATE_ISSUE_FAILED' && /step "dns"/.test(err.message) && /Authentication error/.test(err.raw));
  assert.equal(world.records.size, 0);
});

test('a cut job removes the records it wrote and rejects with the abort', async () => {
  const controller = new AbortController();
  const { run } = issue('example.com', {
    signal: controller.signal,
    onRecords: () => { if (world.records.size === 2) controller.abort(); },
  });
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(world.records.size, 0);
});
