import { after, test } from 'node:test';

import { helperBench } from './helperHarness.js';

const bench = helperBench();
after(() => bench.cleanup());

test('wisp-os-update refuses each wrong argument before it runs anything', () => {
  for (const args of [[], ['check'], ['list', 'now'], ['upgrade', '-y'], ['LIST'], ['']]) {
    bench.assertRefused('wisp-os-update', args);
  }
});
