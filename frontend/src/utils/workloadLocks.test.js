import { test } from 'node:test';
import assert from 'node:assert/strict';

import { containerLocked, vmLocked } from './workloadLocks.js';

/* Every state name the backend reports (libvirt's, and `unknown` for a code it has no
 * name for; containerd's task states, and `unknown`). */
const VM_STATES = ['nostate', 'running', 'blocked', 'paused', 'shutdown', 'shutoff', 'crashed', 'pmsuspended', 'unknown'];
const CONTAINER_STATES = ['created', 'running', 'paused', 'pausing', 'stopped', 'unknown'];

test('a VM is editable only shut off', () => {
  assert.deepEqual(VM_STATES.filter((s) => !vmLocked(s)), ['shutoff']);
});

test('a container is editable only stopped', () => {
  assert.deepEqual(CONTAINER_STATES.filter((s) => !containerLocked(s)), ['stopped']);
});
