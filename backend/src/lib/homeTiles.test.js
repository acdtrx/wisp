/*
 * The Home tile join, with the app registry, the deployment gather and the
 * overlay store mocked (node --test --experimental-test-module-mocks): one
 * app container publishes a link per target, and each link's tile says which
 * workload, if any, it joined to.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const TARGETS = ['web:80', 'webhost:81', 'webhost.local:82', '192.0.2.10:83', 'web.local:84', 'proxy:85'];

const mockModule = (path, namedExports) => mock.module(new URL(path, import.meta.url).href, { namedExports });
mockModule('./containerApps/index.js', {
  getAppModule: () => ({
    getPublishedLinks: () => TARGETS.map((target, i) => ({ url: `https://t${i}.example.test`, target })),
  }),
});
mockModule('./deploymentOverview.js', { gatherDeployment: async () => { throw new Error('not gathered in this test'); } });
mockModule('./homepage.js', { getHomepage: async () => { throw new Error('not read in this test'); }, UNGROUPED_GROUP_ID: 'ungrouped' });

const { deriveHomeEnvelope } = await import('./homeTiles.js');

const deployment = {
  containers: [
    { summary: { name: 'caddy', state: 'running' }, config: { metadata: { app: 'caddy', appConfig: {} } } },
  ],
  vms: [
    { vm: { name: 'web', state: 'running', iconId: null }, net: { ip: '192.0.2.10', hostname: 'webhost' } },
  ],
};
const homepage = { groups: [], overrides: {}, manualTiles: [] };

/** target → the name of the workload its tile joined to, or null. */
function joins(dep) {
  const { tiles } = deriveHomeEnvelope(dep, homepage);
  return Object.fromEntries(tiles.map((t) => [TARGETS[Number(new URL(t.url).hostname.slice(1, 2))], t.workload?.name ?? null]));
}

test('a VM joins on its name, its guest hostname, the .local name its guest announces and its IP', () => {
  assert.deepEqual(joins(deployment), {
    'web:80': 'web',
    'webhost:81': 'web',
    'webhost.local:82': 'web',
    '192.0.2.10:83': 'web',
    'web.local:84': null,
    'proxy:85': null,
  });
});

test('without a guest hostname a VM joins on its name and nothing names .local', () => {
  const silent = { ...deployment, vms: [{ vm: deployment.vms[0].vm, net: { ip: null, hostname: null } }] };
  assert.deepEqual(joins(silent), {
    'web:80': 'web',
    'webhost:81': null,
    'webhost.local:82': null,
    '192.0.2.10:83': null,
    'web.local:84': null,
    'proxy:85': null,
  });
});
