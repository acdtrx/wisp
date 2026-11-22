import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

const VM = '/var/lib/wisp/vms/vm1/VARS.fd';
const BACKUP = '/var/lib/wisp/backups/vm1/2026-11-22T10-00-00-000Z/VARS.fd';

test('wisp-nvram refuses each wrong argument before it runs anything', () => {
  const wrong = [
    [],
    ['copy', VM],
    ['copy', VM, BACKUP, 'extra'],
    ['move', VM, BACKUP],
    ['copy', 'vms/vm1/VARS.fd', BACKUP],
    ['copy', VM, '/etc/VARS.fd'],
    ['copy', '/var/lib/wisp/../../etc/VARS.fd', BACKUP],
    ['copy', '/var/lib/wisp/vms//vm1/VARS.fd', BACKUP],
    ['copy', '/var/lib/wisp/vms/./vm1/VARS.fd', BACKUP],
    ['copy', VM, '/var/lib/wisp/backups/vm1/'],
    ['copy', '/var/lib/wisp/vms/vm1/disk0.qcow2', BACKUP],
    ['copy', VM, '/var/lib/wisp/backups/vm1/shadow'],
    ['copy', '/var/lib/wispx/VARS.fd', BACKUP],
    ['copy', VM, '/mnt/wisp'],
    ['copy', `${VM}\n`, BACKUP],
  ];
  for (const args of wrong) bench.assertRefused('wisp-nvram', args);
});

test('a src that is not there is exit 2, before anything runs', () => {
  const r = bench.run('wisp-nvram', ['copy', VM, BACKUP]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, `wisp-nvram: src is not there: ${VM}\n`);
  assert.deepEqual(r.calls, []);
});

test('it must be run through sudo', () => {
  const r = bench.run('wisp-nvram', ['copy', VM, BACKUP], { env: { SUDO_UID: '' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^wisp-nvram: run it through sudo/);
});
