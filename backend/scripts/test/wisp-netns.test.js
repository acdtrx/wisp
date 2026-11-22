import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-netns refuses each wrong argument before it runs anything', () => {
  const wrong = [
    [],
    ['add'],
    ['ipv4', 'web'],
    ['add', 'web', 'extra'],
    ['add', '../1'],
    ['add', '-n'],
    ['add', 'a..b'],
    ['add', '/proc/1/ns/net'],
    ['delete', ''],
    ['add', 'a'.repeat(64)],
    ['route-add', 'web', 'eth0'],
    ['route-add', 'web', '-eth0', '169.254.53.53'],
    ['route-add', 'web', 'eth0', '169.254.53.256'],
    ['route-add', 'web', 'eth0', '169.254.53.53/32'],
    ['route-add', 'web', 'eth0', '1.2.3'],
    ['route-add', 'web', 'a-very-long-ifname0', '169.254.53.53'],
  ];
  for (const args of wrong) bench.assertRefused('wisp-netns', args);
});

test('a namespace that is not there is exit 2 for delete and route-add', () => {
  for (const args of [['delete', 'wisp-test-none'], ['route-add', 'wisp-test-none', 'eth0', '169.254.53.53']]) {
    const r = bench.run('wisp-netns', args);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stderr, 'wisp-netns: no network namespace wisp-test-none\n');
    assert.deepEqual(r.calls, []);
  }
});
