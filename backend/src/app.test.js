/*
 * The boundary of the real app, built without listening and without its
 * managers connected (on macOS the stub managers load, on Linux the real ones,
 * unconnected): only answers that no manager decides are tested here — the
 * framework's refusals, authentication, unknown routes and MCP's error shape.
 * Answers that need a manager are verified on a host (CODING-RULES §14).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

const READ_TOKEN = 'wisp_read_test-read-token';
const ADMIN_TOKEN = 'wisp_admin_test-admin-token';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-app-test-'));
const tokenEntry = (id, scope, token) => ({
  id, label: id, scope, tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: '2026-01-01T00:00:00.000Z',
});
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  apiTokens: [tokenEntry('read', 'read', READ_TOKEN), tokenEntry('admin', 'admin', ADMIN_TOKEN)],
}));
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

let app;

before(async () => {
  const { buildApp } = await import('./app.js');
  ({ app } = await buildApp(Fastify({ logger: { level: 'silent' } }).log));
});

after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (token) => ({ authorization: `Bearer ${token}` });

/*
 * Failed bearer attempts count against one per-address limit (lib/loginRateLimit.js),
 * which then refuses that address's good tokens too. Every test that sends a bad token
 * or a bad password sends it from an address of its own, so no test can push another
 * into 429.
 */

test('an unknown API route answers 404 ROUTE_NOT_FOUND', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/no-such-route' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'ROUTE_NOT_FOUND');
  assert.equal(typeof res.json().detail, 'string');
});

test('a request without credentials answers 401 AUTH_REQUIRED', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'AUTH_REQUIRED');
});

// An invalid session cookie needs the password file (the session secret derives from
// it), which the test does not write: verified on a host.
test('an unknown token answers 401 AUTH_INVALID', async () => {
  const token = await app.inject({
    method: 'GET', url: '/api/settings', headers: bearer('wisp_read_unknown'), remoteAddress: '10.0.0.1',
  });
  assert.equal(token.statusCode, 401);
  assert.equal(token.json().error, 'AUTH_INVALID');
});

test('the sixth bad token from one address answers 429 RATE_LIMITED', async () => {
  const attempt = () => app.inject({
    method: 'GET', url: '/api/settings', headers: bearer('wisp_read_unknown'), remoteAddress: '10.0.0.3',
  });
  for (let i = 1; i <= 5; i += 1) assert.equal((await attempt()).json().error, 'AUTH_INVALID', `attempt ${i}`);
  const res = await attempt();
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, 'RATE_LIMITED');
});

test('/mcp answers both 401s with the bearer challenge', async () => {
  for (const headers of [{}, bearer('wisp_read_unknown')]) {
    const res = await app.inject({
      method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'ping' }, remoteAddress: '10.0.0.2',
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'], /^Bearer /);
    assert.ok(['AUTH_REQUIRED', 'AUTH_INVALID'].includes(res.json().error));
  }
});

test('a read token on an admin route answers 403 SCOPE_INSUFFICIENT', async () => {
  const res = await app.inject({ method: 'PATCH', url: '/api/settings', headers: bearer(READ_TOKEN), payload: {} });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SCOPE_INSUFFICIENT');
});

test('a read token cannot start the OS package check: 403 SCOPE_INSUFFICIENT, and no job', async () => {
  const jobs = async () => (await app.inject({ method: 'GET', url: '/api/jobs', headers: bearer(READ_TOKEN) })).json().jobs.map((j) => j.jobId);
  const before = await jobs();
  const res = await app.inject({ method: 'POST', url: '/api/host/updates/check', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SCOPE_INSUFFICIENT');
  assert.deepEqual(await jobs(), before);
});

test('a token on a session route answers 403 SESSION_REQUIRED', async () => {
  const res = await app.inject({ method: 'PATCH', url: '/api/settings/oidc', headers: bearer(ADMIN_TOKEN), payload: {} });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'SESSION_REQUIRED');
});

test('a body that fails its schema answers 400 VALIDATION_FAILED naming the field', async () => {
  const res = await app.inject({
    method: 'PATCH', url: '/api/settings', headers: bearer(ADMIN_TOKEN), payload: { updateChannel: 'nightly' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'VALIDATION_FAILED');
  assert.match(res.json().detail, /^body\/updateChannel /);
});

test('malformed JSON, a body too large and an unsupported type answer their codes', async () => {
  const json = { ...bearer(ADMIN_TOKEN), 'content-type': 'application/json' };
  const malformed = await app.inject({ method: 'PATCH', url: '/api/settings', headers: json, payload: '{"serverName":' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error, 'MALFORMED_JSON');
  const large = await app.inject({
    method: 'PATCH', url: '/api/settings', headers: json, payload: JSON.stringify({ serverName: 'x'.repeat(1024 * 1024 + 1) }),
  });
  assert.equal(large.statusCode, 413);
  assert.equal(large.json().error, 'PAYLOAD_TOO_LARGE');
  const type = await app.inject({
    method: 'PATCH', url: '/api/settings', headers: { ...bearer(ADMIN_TOKEN), 'content-type': 'application/xml' }, payload: '<x/>',
  });
  assert.equal(type.statusCode, 415);
  assert.equal(type.json().error, 'UNSUPPORTED_MEDIA_TYPE');
});

// Both are refused by the router before any handler or hook runs; the valid token
// keeps an auth refusal from answering in their place.
test('bad percent-encoding in the URL answers 400 MALFORMED_URL', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/vms/%zz', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'MALFORMED_URL');
  assert.equal(typeof res.json().detail, 'string');
});

test('a route parameter over 100 characters answers 414 URI_TOO_LONG', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/vms/${'a'.repeat(101)}`, headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 414);
  assert.equal(res.json().error, 'URI_TOO_LONG');
  assert.equal(typeof res.json().detail, 'string');
});

test('GET /mcp answers 405 METHOD_NOT_ALLOWED', async () => {
  const res = await app.inject({ method: 'GET', url: '/mcp', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 405);
  assert.equal(res.json().error, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.allow, 'POST');
});

test('a failed MCP tool call carries the error body, as text and structured', async () => {
  const res = await app.inject({
    method: 'POST', url: '/mcp', headers: bearer(READ_TOKEN),
    payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_job', arguments: { jobId: 'no-such-job' } } },
  });
  assert.equal(res.statusCode, 200);
  const { result } = res.json();
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, 'JOB_NOT_FOUND');
  assert.equal(typeof result.structuredContent.detail, 'string');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('an admin tool called with a read token answers SCOPE_INSUFFICIENT', async () => {
  const res = await app.inject({
    method: 'POST', url: '/mcp', headers: bearer(READ_TOKEN),
    payload: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'start_container', arguments: { name: 'x' } } },
  });
  assert.equal(res.json().result.structuredContent.error, 'SCOPE_INSUFFICIENT');
});

// The image update check runs on either platform's stub or unconnected manager:
// it ends done (macOS) or failed (Linux, no containerd), a job on no workload.
test('GET /api/jobs lists a started job with its row', async () => {
  const start = await app.inject({ method: 'POST', url: '/api/containers/images/check-updates', headers: bearer(ADMIN_TOKEN), payload: {} });
  assert.equal(start.statusCode, 202);
  const { jobId, title } = start.json();
  assert.deepEqual(start.json(), { jobId, kind: 'container-image-update-check', title, subject: null });
  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 200);
  const row = res.json().jobs.find((j) => j.jobId === jobId);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'jobId', 'kind', 'status', 'subject', 'title']);
  assert.equal(row.kind, 'container-image-update-check');
  assert.equal(row.title, title);
  assert.equal(row.subject, null);
  assert.ok(['running', 'done', 'error'].includes(row.status));
  assert.equal(typeof row.createdAt, 'number');
});

test('the progress stream of an unknown job answers 404 JOB_NOT_FOUND', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/jobs/no-such-job/progress', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'JOB_NOT_FOUND');
});

test('the old job list and per-feature progress routes are gone', async () => {
  for (const url of [
    '/api/background-jobs',
    '/api/vms/create-progress/x',
    '/api/vms/backup-progress/x',
    '/api/containers/create-progress/x',
    '/api/containers/backup-progress/x',
    '/api/library/download-progress/x',
    '/api/containers/images/check-updates/x',
  ]) {
    const res = await app.inject({ method: 'GET', url, headers: bearer(READ_TOKEN) });
    assert.equal(res.statusCode, 404, url);
    assert.equal(res.json().error, 'ROUTE_NOT_FOUND', url);
  }
});

// No check has run in this process, on either platform: the list is the empty one.
test('GET /api/host/updates/packages with a read token reads the last check and starts no job', async () => {
  const jobs = async () => (await app.inject({ method: 'GET', url: '/api/jobs', headers: bearer(READ_TOKEN) })).json().jobs.map((j) => j.jobId);
  const before = await jobs();
  const res = await app.inject({ method: 'GET', url: '/api/host/updates/packages', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { packages: [], downloadBytes: 0, checkedAt: null });
  assert.deepEqual(await jobs(), before);
});
