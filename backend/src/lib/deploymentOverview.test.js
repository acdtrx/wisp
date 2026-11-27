/*
 * The overview's projection, with what it gathers mocked (node --test
 * --experimental-test-module-mocks): a container's address is its address,
 * without the mask container.json keeps it with, running or not.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

const containers = [
  { summary: { name: 'web', state: 'running', image: 'nginx:1.27' }, config: { network: { ip: '192.168.1.20/24', interface: 'br0' } } },
  { summary: { name: 'worker', state: 'stopped', image: 'worker:v3' }, config: { network: { ip: '192.168.1.21/24', interface: 'br0' } } },
  { summary: { name: 'fresh', state: 'stopped', image: 'nginx:1.27' }, config: { network: { interface: 'br0' } } },
];

const mockModule = (path, exports) => mock.module(new URL(path, import.meta.url).href, { exports });
mockModule('./settings.js', { getSettings: async () => ({ serverName: 'Lab', sections: [] }) });
mockModule('./wispUpdate.js', { getCurrentVersion: () => '3.0.0' });
mockModule('./vmManager/index.js', {
  getHostInfo: async () => ({ hostname: 'lab', kernel: '6.8.0', primaryAddress: '192.168.1.5', uptimeSeconds: 1 }),
  listVMs: async () => [],
  getGuestNetwork: async () => ({ ip: null, hostname: null }),
});
mockModule('./containerManager/index.js', {
  listContainers: async () => containers.map((c) => c.summary),
  getContainerConfig: async (name) => containers.find((c) => c.summary.name === name).config,
});
mockModule('./networking/index.js', { listHostBridges: async () => ['br0'] });
mockModule('./hostCertificateStore.js', { getHeldCertificateSummary: async () => null });

const { buildDeploymentOverview } = await import('./deploymentOverview.js');

test("a container's ip and lastKnownIp are bare addresses, without the stored mask", async () => {
  const byName = Object.fromEntries((await buildDeploymentOverview()).containers.map((c) => [c.name, c]));
  assert.equal(byName.web.ip, '192.168.1.20');
  assert.equal('lastKnownIp' in byName.web, false);
  assert.equal(byName.worker.ip, null);
  assert.equal(byName.worker.lastKnownIp, '192.168.1.21');
  assert.equal(byName.fresh.lastKnownIp, null);
});
