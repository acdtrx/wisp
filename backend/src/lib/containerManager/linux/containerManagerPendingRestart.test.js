/*
 * The one test of "this change needs a restart": restartSignature before and after.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { restartSignature } from './containerManagerPendingRestart.js';

const base = {
  name: 'c',
  image: 'docker.io/library/busybox:latest',
  command: ['sh'],
  cpuLimit: 1,
  memoryLimitMiB: null,
  env: { A: { value: '1' }, B: { value: '2', secret: true } },
  mounts: [
    { type: 'file', name: 'conf', containerPath: '/etc/c.conf', readonly: true, sourceId: null, subPath: '', containerOwnerUid: 0, containerOwnerGid: 0 },
  ],
  devices: [],
  network: { type: 'bridge', mac: '52:54:00:00:00:01', interface: 'br0', ip: '10.0.0.5/24' },
  iconId: 'debian',
  localDns: true,
};
const sig = (patch) => restartSignature({ ...base, ...patch });

test('fields the task reads at start change the signature', () => {
  for (const patch of [
    { image: 'docker.io/library/alpine:latest' }, { command: ['sh', '-c', 'true'] }, { cpuLimit: 2 }, { memoryLimitMiB: 64 },
    { env: { A: { value: '9' }, B: { value: '2', secret: true } } }, { runAsRoot: true },
    { mounts: [] }, { network: { ...base.network, interface: 'br0-vlan10' } },
  ]) assert.notEqual(sig(patch), sig({}), JSON.stringify(patch));
});

test('what a task does not read, or reads the same, leaves it as it is', () => {
  for (const patch of [
    { iconId: 'ubuntu', localDns: false, restartPolicy: 'always', autostart: true, pendingRestart: { since: 'now' } },
    { cpuLimit: 1 },
    { env: { B: { value: '2', secret: true }, A: { value: '1' } } },
    { network: { ...base.network, ip: '10.0.0.9/24', ip6: 'fd00::9/64' } },
    { mounts: [{ ...base.mounts[0], secret: true }] },
    { mounts: [{ type: 'file', name: 'conf', containerPath: '/etc/c.conf', readonly: true }] },
    { runAsRoot: false },
  ]) assert.equal(sig(patch), sig({}), JSON.stringify(patch));
});
