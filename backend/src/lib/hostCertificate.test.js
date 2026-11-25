/*
 * The certificate setting on a temporary config folder (WISP_CONFIG_PATH, set
 * before the modules load), with Cloudflare stood in by the outbound fetch,
 * the job starter recorded and the certificate client's issue stood in: what a
 * save checks before it stores anything, what it stores and starts, what a
 * job's end leaves in the record, and what a removal leaves.
 */
import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-host-certificate-test-'));
const configFile = path.join(dir, 'wisp-config.json');
const storeFile = path.join(dir, 'certificate.json');
process.env.WISP_CONFIG_PATH = configFile;
after(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = 'cf-secret-token-value';
let cloudflare;
const started = [];
/** What the stood-in issue does: resolves a certificate, or throws. */
let issue;

mock.module(new URL('./outbound/index.js', import.meta.url).href, {
  exports: { ssrfSafeFetch: async (url, init) => cloudflare(url, init) },
});
// The zone lookup is the real one, over the stood-in Cloudflare; the issue is stood in.
const realCertificates = await import('./certificates/index.js');
mock.module(new URL('./certificates/index.js', import.meta.url).href, {
  exports: {
    findZone: realCertificates.findZone,
    describeChain: realCertificates.describeChain,
    removeTxtRecords: async () => [],
    issueCertificate: (opts) => issue(opts),
  },
});
mock.module(new URL('./jobs/index.js', import.meta.url).href, {
  exports: {
    startJob: async (opts) => {
      started.push(opts);
      return { jobId: `job-${started.length}`, kind: opts.kind, title: opts.title, subject: null };
    },
    titleForCertificateIssue: (domain) => `Certificate for ${domain}`,
    whenJobEnds: () => new Promise(() => {}),
  },
});

const { createAppError, errorStatus } = await import('./appErrors.js');
const certificate = await import('./hostCertificate.js');

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLog; } };

const ISSUED = {
  chain: '-----BEGIN CERTIFICATE-----\nstand-in\n-----END CERTIFICATE-----\n',
  key: '-----BEGIN PRIVATE KEY-----\nstand-in\n-----END PRIVATE KEY-----\n',
  validFrom: '2026-11-25T10:00:00.000Z',
  validUntil: '2027-02-23T10:00:00.000Z',
  serial: '01',
};

/** Run the job the last save or renew started, as the job starter would. */
async function runStartedJob() {
  const steps = [];
  const result = await started.at(-1).run((event) => steps.push(event.step), new AbortController().signal);
  return { result, steps };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Cloudflare with the zone `example.com`, the token TOKEN accepted. */
function zoneHolder(url, init) {
  if (init.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(400, { success: false, errors: [{ code: 6003, message: 'Invalid request headers' }] });
  }
  const name = new URL(url).searchParams.get('name');
  return json(200, { success: true, result: name === 'example.com' ? [{ id: 'z1', name, name_servers: ['ns.cf.test'] }] : [] });
}

const storedConfig = () => JSON.parse(readFileSync(configFile, 'utf8'));

beforeEach(async () => {
  writeFileSync(configFile, '{}\n', { mode: 0o600 });
  await certificate.removeCertificateSetting(silentLog);
  rmSync(storeFile, { force: true });
  started.length = 0;
  cloudflare = zoneHolder;
});

async function refused(body, code) {
  const before = readFileSync(configFile, 'utf8');
  await assert.rejects(certificate.saveCertificateSetting(body, silentLog), (err) => err.code === code);
  assert.equal(readFileSync(configFile, 'utf8'), before, 'nothing stored');
  assert.equal(started.length, 0, 'no job');
}

test('a malformed domain is refused before Cloudflare is asked (422 INVALID_SETTINGS)', async () => {
  cloudflare = () => assert.fail('Cloudflare is not asked');
  for (const domain of ['https://example.com', '*.example.com', 'example.com.', 'example', 'exa mple.com', '-a.example.com', '']) {
    await refused({ domain, cloudflareApiToken: TOKEN }, 'INVALID_SETTINGS');
  }
  await refused({ domain: 'example.com' }, 'INVALID_SETTINGS'); // no token, none stored
  assert.equal(errorStatus('INVALID_SETTINGS'), 422);
});

test('a token Cloudflare refuses (422 CERTIFICATE_TOKEN_REJECTED), one that sees no zone (422 CERTIFICATE_ZONE_NOT_FOUND), Cloudflare unreachable (502 CERTIFICATE_DNS_UNAVAILABLE)', async () => {
  await refused({ domain: 'example.com', cloudflareApiToken: 'wrong' }, 'CERTIFICATE_TOKEN_REJECTED');
  assert.equal(errorStatus('CERTIFICATE_TOKEN_REJECTED'), 422);

  await refused({ domain: 'example.org', cloudflareApiToken: TOKEN }, 'CERTIFICATE_ZONE_NOT_FOUND');
  assert.equal(errorStatus('CERTIFICATE_ZONE_NOT_FOUND'), 422);

  cloudflare = () => { throw new TypeError('fetch failed'); };
  await refused({ domain: 'example.com', cloudflareApiToken: TOKEN }, 'CERTIFICATE_DNS_UNAVAILABLE');
  cloudflare = () => json(503, { success: false, errors: [] });
  await refused({ domain: 'example.com', cloudflareApiToken: TOKEN }, 'CERTIFICATE_DNS_UNAVAILABLE');
  assert.equal(errorStatus('CERTIFICATE_DNS_UNAVAILABLE'), 502);
});

test('a domain inside a zone is saved, 0600, and the first save starts the job; the record never shows the token', async () => {
  await certificate.saveCertificateSetting({ domain: ' Home.Example.com ', cloudflareApiToken: TOKEN }, silentLog);
  assert.deepEqual(storedConfig().certificate, { domain: 'home.example.com', cloudflareApiToken: TOKEN });
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(started.length, 1);
  assert.equal(started[0].shared, true);
  assert.equal(started[0].interruptible, true);
  assert.equal(started[0].title, 'Certificate for home.example.com');

  const record = await certificate.getCertificateRecord();
  assert.deepEqual(record, { domain: 'home.example.com', tokenSet: true, certificate: null, lastAttempt: null });
  assert.ok(!JSON.stringify(record).includes(TOKEN));
});

test('a save starts the job while Wisp holds no certificate for the domain, a token-only one included; with it, a token-only save starts nothing', async () => {
  await certificate.saveCertificateSetting({ domain: 'example.com', cloudflareApiToken: TOKEN }, silentLog);
  assert.equal(started.length, 1, 'the first save');
  await certificate.saveCertificateSetting({ domain: 'example.com', cloudflareApiToken: '' }, silentLog);
  assert.equal(storedConfig().certificate.cloudflareApiToken, TOKEN, 'an empty token keeps the stored one');
  assert.equal(started.length, 2, 'a token corrected after a failed attempt: no certificate yet');

  issue = async () => ISSUED;
  await runStartedJob();
  started.length = 0;
  await certificate.saveCertificateSetting({ domain: 'example.com' }, silentLog);
  assert.equal(started.length, 0, 'Wisp holds the domain\'s certificate');
  await certificate.saveCertificateSetting({ domain: 'home.example.com' }, silentLog);
  assert.equal(started.length, 1, 'a changed domain');
});

test('renew now with no setting is 404 CERTIFICATE_NOT_FOUND', async () => {
  await assert.rejects(certificate.startCertificateIssueJob(silentLog), { code: 'CERTIFICATE_NOT_FOUND' });
  assert.equal(errorStatus('CERTIFICATE_NOT_FOUND'), 404);
});

test('a job that gets the certificate stores it 0600 with its dates and clears the failure', async () => {
  await certificate.saveCertificateSetting({ domain: 'example.com', cloudflareApiToken: TOKEN }, silentLog);
  issue = async () => { throw createAppError('CERTIFICATE_ISSUE_FAILED', 'The certificate could not be got, at the step "dns"', 'Authentication error'); };
  await assert.rejects(runStartedJob(), { code: 'CERTIFICATE_ISSUE_FAILED' });
  assert.equal(await certificate.isCertificateFailed(), true);
  let record = await certificate.getCertificateRecord();
  assert.equal(record.lastAttempt.error.error, 'CERTIFICATE_ISSUE_FAILED');
  assert.match(record.lastAttempt.error.detail, /step "dns".*Authentication error/);

  issue = async ({ domain, token, onStep }) => {
    assert.equal(domain, 'example.com');
    assert.equal(token, TOKEN);
    for (const step of ['account', 'order', 'dns', 'validate', 'finalize']) onStep(step);
    return ISSUED;
  };
  const { result, steps } = await runStartedJob();
  assert.deepEqual(result, { domain: 'example.com', validUntil: ISSUED.validUntil });
  assert.deepEqual(steps, ['account', 'order', 'dns', 'validate', 'finalize', 'deliver']);
  assert.equal(await certificate.isCertificateFailed(), false);
  record = await certificate.getCertificateRecord();
  assert.deepEqual(record.certificate, {
    domain: 'example.com', validFrom: ISSUED.validFrom, validUntil: ISSUED.validUntil, renewAt: '2027-01-24T10:00:00.000Z',
  });
  assert.equal(record.lastAttempt.error, null);
  assert.equal(statSync(storeFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).certificate.key, ISSUED.key);
  assert.ok(!JSON.stringify(record).includes('PRIVATE KEY'));
});

test('a removal leaves no domain, no certificate and no key, and keeps the account', async () => {
  await certificate.saveCertificateSetting({ domain: 'example.com', cloudflareApiToken: TOKEN }, silentLog);
  const account = { directory: 'https://acme.test/directory', url: 'https://acme.test/acct/1', key: { kty: 'EC' } };
  issue = async ({ onAccount }) => {
    await onAccount(account);
    return ISSUED;
  };
  await runStartedJob();
  assert.ok(readFileSync(storeFile, 'utf8').includes('BEGIN PRIVATE KEY'));

  await certificate.removeCertificateSetting(silentLog);
  assert.equal(storedConfig().certificate, null);
  const left = JSON.parse(readFileSync(storeFile, 'utf8'));
  assert.equal(left.certificate, null);
  assert.deepEqual(left.account, account);
  assert.ok(!JSON.stringify(left).includes('BEGIN CERTIFICATE') && !JSON.stringify(left).includes('BEGIN PRIVATE KEY'));
  assert.equal(statSync(storeFile).mode & 0o777, 0o600);
  assert.deepEqual(await certificate.getCertificateRecord(), { domain: null, tokenSet: false, certificate: null, lastAttempt: null });
  assert.equal(await certificate.isCertificateFailed(), false);
});

test('a job whose setting was removed while it ran stores nothing', async () => {
  await certificate.saveCertificateSetting({ domain: 'example.com', cloudflareApiToken: TOKEN }, silentLog);
  issue = async () => {
    await certificate.removeCertificateSetting(silentLog);
    return ISSUED;
  };
  await assert.rejects(runStartedJob(), { code: 'CERTIFICATE_NOT_FOUND' });
  assert.equal((await certificate.getCertificateRecord()).certificate, null);
  assert.ok(!readFileSync(storeFile, 'utf8').includes('PRIVATE KEY'));
});
