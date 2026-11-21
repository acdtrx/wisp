import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vmLocked } from './workloadLocks.js';

/* Every state name the backend reports (libvirt's, and `unknown` for a code it has no
 * name for). */
const VM_STATES = ['nostate', 'running', 'blocked', 'paused', 'shutdown', 'shutoff', 'crashed', 'pmsuspended', 'unknown'];

test('a VM is editable only shut off', () => {
  assert.deepEqual(VM_STATES.filter((s) => !vmLocked(s)), ['shutoff']);
});
