/*
 * The Home tiles of a Caddy app container's sites, through the real app
 * registry (the deployment gather and the overlay store mocked): under the
 * domain of the certificate Wisp holds, and none while it holds none.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const mockModule = (path, exports) => mock.module(new URL(path, import.meta.url).href, { exports });
mockModule('./deploymentOverview.js', { gatherDeployment: async () => { throw new Error('not gathered in this test'); } });
mockModule('./homepage.js', { getHomepage: async () => { throw new Error('not read in this test'); }, UNGROUPED_GROUP_ID: 'ungrouped' });

const { deriveHomeEnvelope } = await import('./homeTiles.js');

const homepage = { groups: [], overrides: {}, manualTiles: [] };
const caddy = {
  summary: { name: 'caddy', state: 'running' },
  config: { metadata: { app: 'caddy-reverse-proxy', appConfig: { hosts: [{ subdomain: 'ha', target: 'ha-box:8123' }, { subdomain: 'nas', target: '192.0.2.9' }] } } },
};

test("a Caddy container's sites are tiles under the certificate's domain", () => {
  const { tiles } = deriveHomeEnvelope({ containers: [caddy], vms: [], certificate: { domain: 'home.example.com', validUntil: '2027-01-01T00:00:00.000Z' } }, homepage);
  assert.deepEqual(tiles.map((t) => t.url).sort(), ['https://ha.home.example.com', 'https://nas.home.example.com']);
});

test('while Wisp holds no certificate a Caddy container has no tiles', () => {
  const { tiles } = deriveHomeEnvelope({ containers: [caddy], vms: [], certificate: null }, homepage);
  assert.deepEqual(tiles, []);
});
