/*
 * The reads the CLI prints and an MCP tool returns: each is one function on
 * the server, and the route and the tool both answer its value, unchanged.
 * With those functions mocked (node --test --experimental-test-module-mocks),
 * each answers a fixture's body; the route answers it to a `read` token, and
 * refuses a request with none.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

import { createAppError } from '../lib/appErrors.js';

const READ_TOKEN = 'wisp_read_host-reads-test-token';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-host-reads-test-'));
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  apiTokens: [{
    id: 'read', label: 'read', scope: 'read', tokenHash: createHash('sha256').update(READ_TOKEN).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z',
  }],
}));
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

const fixture = (file) => JSON.parse(readFileSync(new URL(`./fixtures/responses/${file}`, import.meta.url), 'utf8')).body;
const OVERVIEW = fixture('hand-overview.json');
const VM = fixture('hand-vm-detail-running.json');

const mockModule = (file, exports) => mock.module(new URL(file, import.meta.url).href, { exports });
mockModule('../lib/deploymentOverview.js', {
  gatherDeployment: async () => { throw new Error('not gathered in this test'); },
  buildDeploymentOverview: async () => structuredClone(OVERVIEW),
});
// The VM manager as it is, but for the VM read.
const vmManager = await import('../lib/vmManager/index.js');
mockModule('../lib/vmManager/index.js', {
  ...vmManager,
  getVMDetail: async (name) => {
    if (name !== VM.name) throw createAppError('VM_NOT_FOUND', `VM "${name}" not found`);
    return structuredClone(VM);
  },
});

let app;

before(async () => {
  const { buildApp } = await import('../app.js');
  ({ app } = await buildApp(Fastify({ logger: { level: 'silent' } }).log));
});

after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const asRead = { authorization: `Bearer ${READ_TOKEN}` };

/** The route's answer to a `read` token, and the MCP tool's, for the same read. */
async function routeAndTool(url, tool, args = {}) {
  const rest = await app.inject({ method: 'GET', url, headers: asRead });
  const mcp = await app.inject({
    method: 'POST', url: '/mcp', headers: asRead,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
  });
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(mcp.json().result.isError, undefined, mcp.body);
  return { rest: rest.json(), mcp: mcp.json().result.structuredContent };
}

test('GET /api/overview answers the overview to a read token, and get_deployment_overview the same body', async () => {
  const { rest, mcp } = await routeAndTool('/api/overview', 'get_deployment_overview');
  assert.deepEqual(rest, OVERVIEW);
  assert.deepEqual(mcp, OVERVIEW);
});

test('GET /api/vms/:name answers the VM read to a read token, and get_vm the same body', async () => {
  const { rest, mcp } = await routeAndTool(`/api/vms/${VM.name}`, 'get_vm', { name: VM.name });
  assert.deepEqual(rest, VM);
  assert.deepEqual(mcp, VM);
  const gone = await app.inject({ method: 'GET', url: '/api/vms/gone', headers: asRead });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error, 'VM_NOT_FOUND');
});

test('GET /api/overview with no token is 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/overview' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'AUTH_REQUIRED');
});
