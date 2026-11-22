import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-smartctl refuses each wrong argument before it runs anything', () => {
  for (const args of [[], ['sda', 'sdb'], ['../sda'], ['disk/by-id/x'], ['-a'], [''], ['a'.repeat(33)]]) {
    bench.assertRefused('wisp-smartctl', args);
  }
});

test('a disk that is not there is exit 2', () => {
  const r = bench.run('wisp-smartctl', ['wisp-no-such-disk0']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'wisp-smartctl: /dev/wisp-no-such-disk0 is not a block device\n');
});

/** A block device of this machine (the check needs one; the read is stood in). */
const disk = ['sda', 'vda', 'nvme0n1', 'disk0', 'loop0'].find((name) => {
  try {
    return statSync(`/dev/${name}`).isBlockDevice();
  } catch {
    return false;
  }
});

test('a disk in standby answers {"standby":true}', { skip: !disk && 'no block device here' }, () => {
  const r = bench.run('wisp-smartctl', [disk], { standIns: { smartctl: 'echo \'{"smartctl":{"exit_status":130}}\'; exit 130' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '{"standby":true}\n');
});

test('smartctl past its limit, or not installed, is exit 1 and its line', { skip: !disk && 'no block device here' }, () => {
  const slow = bench.run('wisp-smartctl', [disk], { standIns: { timeout: 'exit 124' } });
  assert.deepEqual([slow.code, slow.stdout, slow.stderr], [1, '', 'wisp-smartctl: smartctl did not finish within 20 s\n']);
  const none = bench.run('wisp-smartctl', [disk], { standIns: { smartctl: null } });
  assert.deepEqual([none.code, none.stdout, none.stderr], [1, '', 'wisp-smartctl: smartctl is not installed: run setup\n']);
});
