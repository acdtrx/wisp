import { after, test } from 'node:test';

import assert from 'node:assert/strict';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-os-update refuses each wrong argument before it runs anything', () => {
  for (const args of [[], ['check'], ['list', 'now'], ['upgrade', '-y'], ['LIST'], ['']]) {
    bench.assertRefused('wisp-os-update', args);
  }
});

test('a list whose simulated upgrade hits its limit fails, printing no list', () => {
  const r = bench.run('wisp-os-update', ['list'], {
    standIns: {
      'apt-get': 'echo "Reading package lists..."',
      timeout: '[ "$3" = env ] && exit 124; shift 2; exec "$@"',
    },
  });
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.stderr.split('\n').filter(Boolean), [
    'Reading package lists...',
    'wisp-os-update: apt-get -s dist-upgrade did not finish within 60 s',
  ]);
});

test('a list answers the packages and the total', () => {
  const r = bench.run('wisp-os-update', ['list'], {
    standIns: {
      'apt-get': '[ "$1" = -s ] && { echo "Inst bash [5.2-1] (5.2-2 Ubuntu:26.04)"; echo "Inst newpkg (1.0 Ubuntu:26.04)"; }; exit 0',
    },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'PKG\tbash\t5.2-1\t5.2-2\nPKG\tnewpkg\t\t1.0\nTOTAL 0\n');
});

test('a held package-manager lock is exit 75', () => {
  const r = bench.run('wisp-os-update', ['list'], {
    standIns: { 'apt-get': 'echo "E: Could not get lock /var/lib/apt/lists/lock" >&2; exit 100' },
  });
  assert.equal(r.code, 75, r.stderr);
  assert.match(r.stderr, /wisp-os-update: another package manager holds the lock; try again later\n$/);
});
