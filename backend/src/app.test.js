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
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import { JOB_KIND } from '../../shared/wireNames.js';

const READ_TOKEN = 'wisp_read_test-read-token';
const PASSWORD = 'test-login-password';
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
  // wisp-password beside the config file, where lib/auth.js reads it.
  const { setPassword } = await import('./lib/auth.js');
  setPassword(PASSWORD);
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

test('an unknown token answers 401 AUTH_INVALID', async () => {
  const token = await app.inject({
    method: 'GET', url: '/api/settings', headers: bearer('wisp_read_unknown'), remoteAddress: '10.0.0.1',
  });
  assert.equal(token.statusCode, 401);
  assert.equal(token.json().error, 'AUTH_INVALID');
});

/** A browser session: the token and CSRF value a password login sets, and their cookie header. */
async function login(remoteAddress) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD }, remoteAddress });
  assert.equal(res.statusCode, 200);
  const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  assert.ok(cookies.wisp_session && cookies.wisp_csrf);
  return {
    token: cookies.wisp_session,
    csrf: cookies.wisp_csrf,
    cookie: `wisp_session=${cookies.wisp_session}; wisp_csrf=${cookies.wisp_csrf}`,
  };
}

test('a garbage session cookie answers 401 AUTH_INVALID', async () => {
  const [header, payload] = (await login('10.0.0.4')).token.split('.');
  // Not a token at all, and one shaped like a token whose signature is not the secret's.
  for (const value of ['garbage', `${header}.${payload}.${Buffer.from('forged').toString('base64url')}`]) {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: `wisp_session=${value}` } });
    assert.equal(res.statusCode, 401, value);
    assert.equal(res.json().error, 'AUTH_INVALID', value);
  }
});

// The PATCH body fails its schema, so the request that passes the auth hook changes nothing.
test('a session write without the right X-CSRF-Token answers 403 CSRF_FAILED; with it, it passes', async () => {
  const session = await login('10.0.0.5');
  const patch = (headers) => app.inject({
    method: 'PATCH', url: '/api/settings', headers: { cookie: session.cookie, ...headers }, payload: { updateChannel: 'nightly' },
  });
  for (const headers of [{}, { 'x-csrf-token': 'wrong' }]) {
    const res = await patch(headers);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'CSRF_FAILED');
  }
  const res = await patch({ 'x-csrf-token': session.csrf });
  assert.notEqual(res.statusCode, 403);
  assert.equal(res.json().error, 'VALIDATION_FAILED');
});

test('a container name with surrounding whitespace is refused by its schema, never trimmed', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/containers', headers: bearer(ADMIN_TOKEN), payload: { name: ' web ', image: 'nginx:1.27' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'VALIDATION_FAILED');
  assert.match(res.json().detail, /^body\/name must match pattern/);
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

test('a data path in the install folder is refused at save, naming the folder', async () => {
  const installRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  for (const vmsPath of [installRoot, `${installRoot}/vms`]) {
    const res = await app.inject({ method: 'PATCH', url: '/api/settings', headers: bearer(ADMIN_TOKEN), payload: { vmsPath } });
    assert.equal(res.statusCode, 422, vmsPath);
    assert.equal(res.json().error, 'INVALID_SETTINGS');
    assert.match(res.json().detail, /is in Wisp's install folder .*, and an install replaces what that folder holds/);
  }
});

test('a container PATCH refuses eject, a bridge that is no interface name, and appConfig sent with other keys, naming them', async () => {
  const patch = (payload) => app.inject({
    method: 'PATCH', url: '/api/containers/web', headers: bearer(ADMIN_TOKEN), payload,
  });
  const eject = await patch({ eject: true });
  assert.equal(eject.statusCode, 400);
  assert.deepEqual(eject.json(), { error: 'VALIDATION_FAILED', detail: 'body: unknown key "eject"' });

  for (const bad of ['../../../sys/class/net/br0', '-br0', 'br0 x', 'a-name-of-16-chr']) {
    const res = await patch({ network: { interface: bad } });
    assert.equal(res.statusCode, 400, bad);
    assert.equal(res.json().error, 'VALIDATION_FAILED');
    assert.match(res.json().detail, /^body\/network\/interface /);
  }

  const mixed = await patch({ appConfig: { hosts: [] }, iconId: 'box', name: 'web2' });
  assert.equal(mixed.statusCode, 400);
  assert.equal(mixed.json().error, 'VALIDATION_FAILED');
  assert.match(mixed.json().detail, /^body\/iconId, body\/name cannot be sent with body\/appConfig/);
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
  assert.deepEqual(start.json(), { jobId, kind: JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK, title, subject: null });
  const res = await app.inject({ method: 'GET', url: '/api/jobs', headers: bearer(READ_TOKEN) });
  assert.equal(res.statusCode, 200);
  const row = res.json().jobs.find((j) => j.jobId === jobId);
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'jobId', 'kind', 'status', 'subject', 'title']);
  assert.equal(row.kind, JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK);
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

/* ── OIDC: browser navigations ───────────────────────────────────────── */

// SSO is not configured in this app: a request that passes lands on `?sso=disabled`.
test('the OIDC login answers a refused querystring with the login page redirect, never JSON', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/oidc/login?x=1' });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login?sso=error');
  assert.equal(res.body, '');
  const plain = await app.inject({ method: 'GET', url: '/api/auth/oidc/login' });
  assert.equal(plain.statusCode, 302);
  assert.equal(plain.headers.location, '/login?sso=disabled');
});

test('the OIDC callback takes the provider\'s own parameters, and redirects a refused query', async () => {
  const extra = await app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=c&state=s&iss=https%3A%2F%2Fidp&session_state=x' });
  assert.equal(extra.statusCode, 302);
  assert.equal(extra.headers.location, '/login?sso=disabled');
  const twice = await app.inject({ method: 'GET', url: '/api/auth/oidc/callback?code=a&code=b' });
  assert.equal(twice.statusCode, 302);
  assert.equal(twice.headers.location, '/login?sso=error');
});

/* ── Schemas at the boundary ─────────────────────────────────────────── */

const admin = bearer(ADMIN_TOKEN);

test('an unknown body key answers 400 VALIDATION_FAILED naming the key, nested ones with their path', async () => {
  const top = await app.inject({ method: 'PATCH', url: '/api/settings', headers: admin, payload: { serverName: 'x', bogus: 1 } });
  assert.equal(top.statusCode, 400);
  assert.deepEqual(top.json(), { error: 'VALIDATION_FAILED', detail: 'body: unknown key "bogus"' });
  const nested = await app.inject({
    method: 'PATCH', url: '/api/vms/web', headers: admin, payload: { nics: [{ type: 'bridge', vlan: 22 }] },
  });
  assert.deepEqual(nested.json(), { error: 'VALIDATION_FAILED', detail: 'body/nics/0: unknown key "vlan"' });
});

test('a command that declares no body refuses a key in one, and takes none or an empty one', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/containers/web/kill', headers: admin, payload: { force: true } });
  assert.deepEqual(res.json(), { error: 'VALIDATION_FAILED', detail: 'body: unknown key "force"' });
  for (const payload of [undefined, {}]) {
    const ok = await app.inject({ method: 'POST', url: '/api/containers/web/kill', headers: admin, payload });
    assert.notEqual(ok.json().error, 'VALIDATION_FAILED');
  }
});

test('an unknown querystring key answers 400 naming it, on a route with a querystring and on one without', async () => {
  for (const url of ['/api/library?type=iso&bogus=1', '/api/vms?bogus=1']) {
    const res = await app.inject({ method: 'GET', url, headers: bearer(READ_TOKEN) });
    assert.equal(res.statusCode, 400, url);
    assert.deepEqual(res.json(), { error: 'VALIDATION_FAILED', detail: 'querystring: unknown key "bogus"' }, url);
  }
});

test('a JSON body is not coerced: a string where a number is wanted answers 400', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/host/network-bridges', headers: admin, payload: { baseBridge: 'br0', vlanId: '22' },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'VALIDATION_FAILED', detail: 'body/vlanId must be number' });
});

test('params and querystrings are coerced to the type their schema names', async () => {
  const port = await app.inject({ method: 'DELETE', url: '/api/containers/web/services/80', headers: admin });
  assert.notEqual(port.json().error, 'VALIDATION_FAILED');
  const notPort = await app.inject({ method: 'DELETE', url: '/api/containers/web/services/http', headers: admin });
  assert.deepEqual(notPort.json(), { error: 'VALIDATION_FAILED', detail: 'params/port must be integer' });
  const low = await app.inject({ method: 'GET', url: '/api/containers/web/stats?intervalMs=1000', headers: bearer(READ_TOKEN) });
  assert.deepEqual(low.json(), { error: 'VALIDATION_FAILED', detail: 'querystring/intervalMs must be >= 2000' });
});

test('a workload name is checked by its schema in the URL: no `..`, a leading letter or digit', async () => {
  for (const url of ['/api/vms/a..b', '/api/containers/.hidden']) {
    const res = await app.inject({ method: 'GET', url, headers: bearer(READ_TOKEN) });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error, 'VALIDATION_FAILED', url);
    assert.match(res.json().detail, /^params\/name must match pattern/, url);
  }
});

test('a section assignment takes a name by its kind\'s workload-name schema', async () => {
  const assign = (payload) => app.inject({ method: 'PUT', url: '/api/sections/assign', headers: admin, payload });
  const vm = await assign({ type: 'vm', name: 'v'.repeat(128), sectionId: null });
  assert.equal(vm.statusCode, 204);
  const longVm = await assign({ type: 'vm', name: 'v'.repeat(129), sectionId: null });
  assert.deepEqual(longVm.json(), { error: 'VALIDATION_FAILED', detail: 'body/name must NOT have more than 128 characters' });
  const container = await assign({ type: 'container', name: 'c'.repeat(64), sectionId: null });
  assert.deepEqual(container.json(), { error: 'VALIDATION_FAILED', detail: 'body/name must NOT have more than 63 characters' });
  const dots = await assign({ type: 'vm', name: 'a..b', sectionId: null });
  assert.match(dots.json().detail, /^body\/name must match pattern/);
});

test('a malformed run id answers the same on the run-log download and the logs stream', async () => {
  const download = await app.inject({ method: 'GET', url: '/api/containers/web/runs/not-a-run/log', headers: bearer(READ_TOKEN) });
  const stream = await app.inject({ method: 'GET', url: '/api/containers/web/logs?runId=not-a-run', headers: bearer(READ_TOKEN) });
  for (const [res, part] of [[download, 'params'], [stream, 'querystring']]) {
    assert.equal(res.statusCode, 400, part);
    assert.equal(res.json().error, 'VALIDATION_FAILED', part);
    assert.match(res.json().detail, new RegExp(`^${part}/runId must match pattern`), part);
  }
});

test('a multipart upload passes the boundary: its route declares no JSON body', async () => {
  const boundary = 'wisp-test-boundary';
  const res = await app.inject({
    method: 'POST',
    url: '/api/containers/web/mounts/conf/file',
    headers: { ...admin, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`,
  });
  assert.notEqual(res.json().error, 'VALIDATION_FAILED');
});

/** One MCP tools/call with a read token; its tool result. */
async function callTool(id, name, args) {
  const res = await app.inject({
    method: 'POST', url: '/mcp', headers: bearer(READ_TOKEN),
    payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  return res.json().result;
}

test('an MCP tool called with an unknown or a wrong-typed argument answers VALIDATION_FAILED naming it', async () => {
  const cases = [
    ['get_job', { jobId: 'x', extra: 1 }, 'arguments: unknown key "extra"'],
    ['get_container_logs', { name: 'web', lines: '5' }, 'arguments/lines must be integer'],
    ['get_container_logs', { name: 'web', lines: 5000 }, 'arguments/lines must be <= 1000'],
  ];
  for (const [i, [tool, args, detail]] of cases.entries()) {
    const result = await callTool(20 + i, tool, args);
    assert.equal(result.isError, true, tool);
    assert.deepEqual(result.structuredContent, { error: 'VALIDATION_FAILED', detail }, tool);
  }
  const vm = await callTool(30, 'get_vm', { name: '../etc' });
  assert.equal(vm.structuredContent.error, 'VALIDATION_FAILED');
  assert.match(vm.structuredContent.detail, /^arguments\/name must match pattern/);
});
