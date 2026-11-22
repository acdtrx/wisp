/*
 * The one change emitter's contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEmitter } from './emitter.js';

const logger = () => {
  const lines = [];
  return { lines, get: () => ({ warn: (obj, msg) => lines.push([obj.err, msg]) }) };
};

test('handlers run in subscription order with the emitted arguments; one function is kept once', () => {
  const seen = [];
  const e = createEmitter('[t] x', () => null);
  const a = (...args) => seen.push(['a', ...args]);
  e.subscribe(a);
  e.subscribe(a);
  e.subscribe((...args) => seen.push(['b', ...args]));
  e.emit(1, 'two');
  assert.deepEqual(seen, [['a', 1, 'two'], ['b', 1, 'two']]);
  assert.equal(e.size(), 2);
});

test('a handler that throws is logged and the rest run; emit never throws', () => {
  const log = logger();
  const seen = [];
  const e = createEmitter('[t] change', log.get);
  e.subscribe(() => { throw new Error('boom'); });
  e.subscribe(() => seen.push('after'));
  assert.doesNotThrow(() => e.emit());
  assert.deepEqual(seen, ['after']);
  assert.deepEqual(log.lines, [['boom', '[t] change handler failed']]);
});

test('an async handler is not awaited, and its rejection is logged', async () => {
  const log = logger();
  const e = createEmitter('[t] async', log.get);
  let ran = false;
  e.subscribe(async () => { await null; throw new Error('later'); });
  e.subscribe(() => { ran = true; });
  e.emit();
  assert.equal(ran, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log.lines, [['later', '[t] async handler failed']]);
});

test('an emit runs over the handlers as they were when it started; unsubscribe is idempotent', () => {
  const seen = [];
  const e = createEmitter('[t] copy', () => null);
  let unsubscribeB;
  e.subscribe(() => {
    seen.push('a');
    e.subscribe(() => seen.push('late'));
    unsubscribeB();
  });
  unsubscribeB = e.subscribe(() => seen.push('b'));
  e.emit();
  assert.deepEqual(seen, ['a', 'b']);
  unsubscribeB();
  seen.length = 0;
  e.emit();
  assert.deepEqual(seen, ['a', 'late']);
});
