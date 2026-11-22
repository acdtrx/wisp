import { after, test } from 'node:test';
import assert from 'node:assert/strict';

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
