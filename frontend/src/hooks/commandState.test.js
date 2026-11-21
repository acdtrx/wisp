import { test } from 'node:test';
import assert from 'node:assert/strict';

import { begin, dismiss, end, fail, initialCommandState, isRunning } from './commandState.js';

test('different keys run in parallel; a key in flight cannot begin again', () => {
  let s = begin(initialCommandState(), 'a');
  s = begin(s, 'b');
  assert.equal(isRunning(s, 'a'), true);
  assert.equal(isRunning(s, 'b'), true);
  assert.equal(begin(s, 'a'), s);
  s = end(s, 'a');
  assert.equal(isRunning(s, 'a'), false);
  assert.equal(isRunning(s, 'b'), true);
});

test("an error belongs to its key: another key's run leaves it, its own run clears it", () => {
  let s = end(begin(initialCommandState(), 'a'), 'a', new Error('a failed'));
  s = end(begin(s, 'b'), 'b', new Error('b failed'));
  assert.deepEqual([...s.errors.keys()], ['a', 'b']);
  s = end(begin(s, 'b'), 'b');
  assert.equal(s.errors.get('a').message, 'a failed');
  assert.equal(s.errors.has('b'), false);
  s = begin(s, 'a');
  assert.equal(s.errors.has('a'), false);
});

test('a dismiss puts away one key’s error; a validation failure holds like a run’s', () => {
  let s = fail(initialCommandState(), 'a', 'Name is required');
  s = fail(s, 'b', 'other');
  s = dismiss(s, 'a');
  assert.deepEqual([...s.errors.keys()], ['b']);
  assert.equal(dismiss(s, 'zzz'), s);
});

test('what a key stands for is held while it runs and while its error stands, never parsed', () => {
  let s = begin(initialCommandState(), 'k1', { label: 'the backup 1 of p4' });
  assert.deepEqual(s.abouts.get('k1'), { label: 'the backup 1 of p4' });
  // A success lets it go.
  assert.equal(end(s, 'k1').abouts.has('k1'), false);
  // A failure keeps it with the error, until the error is dismissed.
  s = end(s, 'k1', new Error('down'));
  assert.deepEqual(s.abouts.get('k1'), { label: 'the backup 1 of p4' });
  assert.equal(dismiss(s, 'k1').abouts.has('k1'), false);
  // Run again: what it is about now replaces the old.
  assert.equal(begin(s, 'k1', 'again').abouts.get('k1'), 'again');
  assert.equal(fail(initialCommandState(), 'k2', 'bad', 'row 2').abouts.get('k2'), 'row 2');
});
