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

/** The first of these names that is a block device of this machine (the check needs one; the read is stood in). */
function blockDevice(names) {
  return names.find((name) => {
    try {
      return statSync(`/dev/${name}`).isBlockDevice();
    } catch {
      return false; // a name this machine does not have is not its disk
    }
  });
}
const disk = blockDevice(['sda', 'vda', 'nvme0n1', 'disk0', 'loop0']);
/** One the helper asks about standby: it never asks an NVMe disk. */
const spinning = blockDevice(['sda', 'vda', 'disk0', 'loop0']);
const nvme = blockDevice(['nvme0n1']);

const STANDBY_ANSWER = 'echo \'{"smartctl":{"exit_status":130}}\'; exit 130';

test('a disk in standby answers {"standby":true}', { skip: !spinning && 'no block device but NVMe here' }, () => {
  const r = bench.run('wisp-smartctl', [spinning], { standIns: { smartctl: STANDBY_ANSWER } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '{"standby":true}\n');
});

test('an NVMe disk is not asked about standby: smartctl\'s answer passes as it is', { skip: !nvme && 'no NVMe disk here' }, () => {
  const r = bench.run('wisp-smartctl', [nvme], { standIns: { smartctl: STANDBY_ANSWER } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '{"smartctl":{"exit_status":130}}\n');
});

test('smartctl past its limit, or not installed, is exit 1 and its line', { skip: !disk && 'no block device here' }, () => {
  const slow = bench.run('wisp-smartctl', [disk], { standIns: { timeout: 'exit 124' } });
  assert.deepEqual([slow.code, slow.stdout, slow.stderr], [1, '', 'wisp-smartctl: smartctl did not finish within 20 s\n']);
  const none = bench.run('wisp-smartctl', [disk], { standIns: { smartctl: null } });
  assert.deepEqual([none.code, none.stdout, none.stderr], [1, '', 'wisp-smartctl: smartctl is not installed: run setup\n']);
});
