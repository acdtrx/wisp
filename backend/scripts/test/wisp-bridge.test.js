import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-bridge refuses each wrong argument before it runs anything', () => {
  const wrong = [
    [],
    ['create', 'br0'],
    ['create', 'br0', '10', 'extra'],
    ['create-vlan-bridge', 'br0', '10'],
    ['create', '--base', 'br0'],
    ['create', '-br0', '10'],
    ['create', 'br0/x', '10'],
    ['create', 'br__0', '10'],
    ['create', 'br0', '0'],
    ['create', 'br0', '4095'],
    ['create', 'br0', '010'],
    ['create', 'br0', '1x'],
    ['create', 'abcdefghij', '100'],
    ['delete', 'br0;x', '10'],
    ['delete', 'br0', '-1'],
  ];
  for (const args of wrong) bench.assertRefused('wisp-bridge', args);
});

test('a base that is not a bridge, and a VLAN bridge that is not there, are exit 2', () => {
  const create = bench.run('wisp-bridge', ['create', 'wt0', '10']);
  assert.equal(create.code, 2);
  assert.equal(create.stderr, 'wisp-bridge: wt0 is not a bridge on this host\n');
  const del = bench.run('wisp-bridge', ['delete', 'wt0', '10']);
  assert.equal(del.code, 2);
  assert.equal(del.stderr, 'wisp-bridge: no VLAN bridge wt0-vlan10\n');
  assert.deepEqual([...create.calls, ...del.calls], []);
});
