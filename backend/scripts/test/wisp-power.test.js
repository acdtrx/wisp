import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-power refuses each wrong argument before it runs anything', () => {
  for (const args of [[], ['halt'], ['-h'], ['shutdown', 'now'], ['']]) bench.assertRefused('wisp-power', args);
});

test('wisp-power runs shutdown, bounded', () => {
  const r = bench.run('wisp-power', ['reboot']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, ['timeout --kill-after=2 10 shutdown -r now', 'shutdown -r now']);
});

test('a failed shutdown is one error line and exit 1', () => {
  const r = bench.run('wisp-power', ['shutdown'], { standIns: { shutdown: 'echo "Failed to talk to init daemon." >&2; exit 1' } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'wisp-power: shutdown failed (exit 1): Failed to talk to init daemon.\n');
});
