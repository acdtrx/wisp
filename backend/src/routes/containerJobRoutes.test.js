/*
 * The REST routes that start a container job an MCP tool starts too: each is
 * the same operation, given the same input, answering the same ack. With
 * lib/containerOperations.js mocked (node --test --experimental-test-module-mocks),
 * each operation records what it was given and answers a job's ack.
 */
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';

import { JOB_KIND } from '../../../shared/wireNames.js';

const AGENT_TOKEN = 'wisp_agent_job-routes-test-agent-token';

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-job-routes-test-'));
writeFileSync(path.join(dir, 'wisp-config.json'), JSON.stringify({
  apiTokens: [{
    id: 'agent', label: 'agent', scope: 'agent', tokenHash: createHash('sha256').update(AGENT_TOKEN).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z',
  }],
}));
// config.js reads the path when it loads: set it before the app is imported.
process.env.WISP_CONFIG_PATH = path.join(dir, 'wisp-config.json');

const calls = [];
const ack = (kind, name) => ({ jobId: 'job-1', kind, title: `Job ${name}`, subject: { type: 'container', name } });
const OPERATIONS = {
  startContainerDeployJob: ({ spec }) => ack(JOB_KIND.CONTAINER_DEPLOY, spec.name),
  startContainerImageUpdateJob: ({ name }) => ack(JOB_KIND.CONTAINER_IMAGE_UPDATE, name),
};
const OTHERS = [
  'startContainerCreateJob', 'startContainerStartJob', 'startContainerStopJob', 'startContainerRestartJob', 'killContainerNow',
  'startContainerDeleteJob', 'editContainerConfig', 'saveContainerAppConfig', 'saveAgentAppConfig', 'deliverHostCertificate',
  'ejectContainerApp', 'addContainerMountRow', 'editContainerMountRow', 'startContainerMountDeleteJob', 'addContainerServiceRow',
  'editContainerServiceRow', 'removeContainerServiceRow', 'writeContainerMountFile', 'startContainerZipExtractJob',
  'putContainerMountContent', 'initContainerMountContent', 'startContainerMountDataDeleteJob', 'startContainerBackupJob',
  'startContainerRestoreJob', 'startContainerRestoreAsNewJob',
];
mock.module(new URL('../lib/containerOperations.js', import.meta.url).href, {
  exports: {
    ...Object.fromEntries(OTHERS.map((name) => [name, async () => {}])),
    ...Object.fromEntries(Object.entries(OPERATIONS).map(([name, answer]) => [name, async (args) => {
      calls.push([name, args]);
      return answer(args);
    }])),
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

const headers = { authorization: `Bearer ${AGENT_TOKEN}` };

/** The operation's input and the answer, through the route and through the tool. */
async function throughBoth({ method, url, payload }, tool, args) {
  calls.length = 0;
  const rest = await app.inject({ method, url, payload, headers });
  const mcp = await app.inject({
    method: 'POST', url: '/mcp', headers,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } },
  });
  assert.equal(rest.statusCode, 202, rest.body);
  assert.equal(mcp.json().result.isError, undefined, mcp.body);
  assert.equal(calls.length, 2);
  return { rest: rest.json(), mcp: mcp.json().result.structuredContent, given: calls.map(([, given]) => given) };
}

test('POST /api/containers/deploy starts the job deploy_container starts, from the same input', async () => {
  const input = {
    name: 'web', image: 'nginx:1.27', env: { A: '1' }, secretEnv: { S: 'hush' }, command: ['nginx', '-g', 'daemon off;'],
    restartPolicy: 'always', autostart: true, autoBackup: false, localDns: true, cpuLimit: 0.5, memoryLimitMiB: 128, start: false,
  };
  const { rest, mcp, given } = await throughBoth({ method: 'POST', url: '/api/containers/deploy', payload: input }, 'deploy_container', input);
  assert.deepEqual(rest, mcp);
  assert.equal(rest.kind, JOB_KIND.CONTAINER_DEPLOY);
  assert.deepEqual(given[0].spec, input);
  assert.deepEqual(given[1].spec, input);
});

test('a deploy body with a key the route does not take is 400, and nothing starts', async () => {
  calls.length = 0;
  for (const payload of [{ name: 'web', image: 'nginx', app: 'caddy-reverse-proxy' }, { name: 'web' }, { name: 'web', image: ' ' }]) {
    const res = await app.inject({ method: 'POST', url: '/api/containers/deploy', payload, headers });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, 'VALIDATION_FAILED');
  }
  assert.equal(calls.length, 0);
});

test('POST /api/containers/:name/image-update starts the job update_container_image starts, with or without an image', async () => {
  for (const image of ['ghcr.io/me/app:v2', undefined]) {
    const payload = image === undefined ? {} : { image };
    const { rest, mcp, given } = await throughBoth(
      { method: 'POST', url: '/api/containers/web/image-update', payload },
      'update_container_image',
      { name: 'web', ...payload },
    );
    assert.deepEqual(rest, mcp);
    assert.equal(rest.kind, JOB_KIND.CONTAINER_IMAGE_UPDATE);
    for (const args of given) {
      assert.equal(args.name, 'web');
      assert.equal(args.image, image);
    }
  }
  calls.length = 0;
  const res = await app.inject({ method: 'POST', url: '/api/containers/web/image-update', headers });
  assert.equal(res.statusCode, 202, 'no body pulls the current image');
  assert.equal(calls[0][1].image, undefined);
});
