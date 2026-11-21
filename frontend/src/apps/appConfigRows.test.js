import { test } from 'node:test';
import assert from 'node:assert/strict';

import { APP_CONFIG_COMMAND, appCommandRunning, appRowReason, keyTaken, withRow, withoutRow } from './appConfigRows.js';

const key = (r) => r.k;

test('a row is replaced by its key, added without one, removed by its key', () => {
  const list = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }];
  assert.deepEqual(withRow(list, key, 'b', { k: 'c', v: 3 }), [{ k: 'a', v: 1 }, { k: 'c', v: 3 }]);
  assert.deepEqual(withRow(list, key, null, { k: 'd' }).at(-1), { k: 'd' });
  assert.deepEqual(withoutRow(list, key, 'a'), [{ k: 'b', v: 2 }]);
  assert.equal(keyTaken(list, key, 'a', 'b'), true);
  assert.equal(keyTaken(list, key, 'a', 'a'), false);
});

test('while one whole-config command runs, every row and switch says why it waits', () => {
  const idle = { isBusy: () => false, aboutOf: () => undefined };
  const running = { isBusy: (k) => k === APP_CONFIG_COMMAND, aboutOf: (k) => (k === APP_CONFIG_COMMAND ? 'remove a' : undefined) };
  assert.equal(appRowReason(null, idle), undefined);
  assert.equal(appRowReason(null, running), 'another change to the app is being saved');
  assert.equal(appRowReason('job runs', running), 'job runs');
  assert.equal(appCommandRunning(running, 'remove a'), true);
  assert.equal(appCommandRunning(running, 'remove b'), false);
});
