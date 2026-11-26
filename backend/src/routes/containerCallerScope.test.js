/*
 * The container routes whose operation refuses part of an agent token's request
 * by what is stored (a mount backed by a storage mount, an app's agent-writable
 * keys) hand the operation the caller's scope: with lib/containerOperations.js
 * mocked (node --test --experimental-test-module-mocks), each records what it
 * was given. A route that stopped passing it would make the operation treat an
 * agent token as a session.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

const AGENT_TOKEN = 'wisp_agent_scope-test-agent-token';
const ADMIN_TOKEN = 'wisp_admin_scope-test-admin-token';
const PASSWORD = 'scope-test-password';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-caller-scope-test-'));
const tokenEntry = (id, scope, token) => ({
  id, label: id, scope, tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: '2026-01-01T00:00:00.000Z',
});
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  apiTokens: [tokenEntry('agent', 'agent', AGENT_TOKEN), tokenEntry('admin', 'admin', ADMIN_TOKEN)],
}));
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

const calls = [];
const OPERATIONS = [
  'startContainerCreateJob', 'startContainerDeployJob', 'startContainerImageUpdateJob', 'startContainerStartJob',
  'startContainerStopJob', 'startContainerRestartJob', 'killContainerNow', 'startContainerDeleteJob', 'editContainerConfig',
  'saveContainerAppConfig', 'saveAgentAppConfig', 'deliverHostCertificate', 'ejectContainerApp', 'addContainerMountRow',
  'editContainerMountRow', 'startContainerMountDeleteJob', 'addContainerServiceRow', 'editContainerServiceRow',
  'removeContainerServiceRow', 'writeContainerMountFile', 'startContainerZipExtractJob', 'putContainerMountContent',
  'initContainerMountContent', 'startContainerMountDataDeleteJob', 'startContainerBackupJob', 'startContainerRestoreJob',
  'startContainerRestoreAsNewJob',
];
mock.module(new URL('../lib/containerOperations.js', import.meta.url).href, {
  exports: Object.fromEntries(OPERATIONS.map((name) => [name, async (...args) => { calls.push([name, ...args]); }])),
});

let app;

before(async () => {
  const { setPassword } = await import('../lib/auth.js');
  await setPassword(PASSWORD);
  const { buildApp } = await import('../app.js');
  ({ app } = await buildApp(Fastify({ logger: { level: 'silent' } }).log));
});

after(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

const ROUTES = [
  ['editContainerMountRow', 'PATCH', '/api/containers/web/mounts/media', { readonly: true }, (args) => args[3]],
  ['initContainerMountContent', 'POST', '/api/containers/web/mounts/media/init', undefined, (args) => args[2]],
  ['saveContainerAppConfig', 'PATCH', '/api/containers/web', { appConfig: { hosts: [] } }, (args) => args[0]],
];

test('the mount edit, the mount init and the appConfig save are given the caller\'s scope', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  const session = { cookie: `wisp_session=${cookies.wisp_session}; wisp_csrf=${cookies.wisp_csrf}`, 'x-csrf-token': cookies.wisp_csrf };
  for (const [scope, headers] of [['agent', { authorization: `Bearer ${AGENT_TOKEN}` }], ['admin', { authorization: `Bearer ${ADMIN_TOKEN}` }], [null, session]]) {
    for (const [operation, method, url, payload, options] of ROUTES) {
      calls.length = 0;
      const answer = await app.inject({ method, url, payload, headers });
      assert.equal(answer.statusCode, 204, `${operation} ${scope}`);
      const [call] = calls.filter(([name]) => name === operation);
      assert.ok(call, `${operation} was called (${scope})`);
      assert.equal(options(call.slice(1)).scope, scope, `${operation} given scope ${scope}`);
    }
  }
});
