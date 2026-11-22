import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

const MAC = '52:54:00:12:34:56';

test('wisp-cni refuses each wrong argument before it runs anything', () => {
  const wrong = [
    [],
    ['add', 'web', 'br0'],
    ['add', 'web', 'br0', MAC, 'extra'],
    ['del', 'web', 'br0', MAC],
    ['ADD', 'web', 'br0', MAC],
    ['check', 'web', 'br0', MAC],
    ['add', '/proc/1/ns/net', 'br0', MAC],
    ['add', '../web', 'br0', MAC],
    ['add', 'a..b', 'br0', MAC],
    ['add', '-web', 'br0', MAC],
    ['add', 'web', '../../../sys/class/net/br0', MAC],
    ['add', 'web', '-br0', MAC],
    ['add', 'web', 'br0"x', MAC],
    ['add', 'web', 'a-name-of-16-chr', MAC],
    ['add', 'web', 'br0', '52:54:00:12:34'],
    ['add', 'web', 'br0', '52:54:00:12:34:5G'],
    ['add', 'web', 'br0', '52:54:00:12:34:56"'],
    ['add', 'web', 'br0', '52:54:00:AB:CD:EF'],
  ];
  for (const args of wrong) bench.assertRefused('wisp-cni', args);
});

test('a missing bridge plugin fails, naming it and setup', { skip: existsSync('/opt/cni/bin/bridge') && 'this host has the plugin' }, () => {
  const r = bench.run('wisp-cni', ['del', 'web', 'br0']);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'wisp-cni: the CNI bridge plugin /opt/cni/bin/bridge is not installed: run setup\n');
  assert.deepEqual(r.calls, []);
});
