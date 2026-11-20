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
  const token = await app.inject({ method: 'GET', url: '/api/settings', headers: bearer('wisp_read_unknown') });
  assert.equal(token.statusCode, 401);
  assert.equal(token.json().error, 'AUTH_INVALID');
});

test('/mcp answers both 401s with the bearer challenge', async () => {
  for (const headers of [{}, bearer('wisp_read_unknown')]) {
    const res = await app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
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
  assert.equal(malformed.json().error, 'BAD_REQUEST');
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
