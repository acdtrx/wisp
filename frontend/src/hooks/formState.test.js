import { test } from 'node:test';
import assert from 'node:assert/strict';

import { afterSave, beginSave, failedSave, followRecord, initialFormState, isDirty } from './formState.js';

const edit = (state, form) => ({ ...state, form });

test('a form starts from its record, not dirty; an edit makes it dirty, by value', () => {
  const s = initialFormState({ a: 1, b: 'x' });
  assert.equal(isDirty(s), false);
  assert.equal(isDirty(edit(s, { a: 2, b: 'x' })), true);
  assert.equal(isDirty(edit(s, { a: 1, b: 'x' })), false);
});

test('a re-read that changes what the form shows resets it; one that leaves those values keeps the edit', () => {
  const s = edit(initialFormState({ a: 1 }), { a: 5 });
  assert.equal(followRecord(s, { a: 1 }, 7), s);
  const reset = followRecord(s, { a: 2 }, 8);
  assert.deepEqual(reset.form, { a: 2 });
  assert.equal(isDirty(reset), false);
});

test('a save that answers before its re-read: what it sent counts as saved until the next read', () => {
  let s = edit(initialFormState({ a: 1 }), { a: 2 });
  s = beginSave(s, 3);
  s = afterSave(s, { a: 2 });
  assert.equal(isDirty(s), false);
  assert.deepEqual(s.form, { a: 2 });
  assert.equal(followRecord(s, { a: 1 }, 3), s); // no read since
  // The next read brings what the server holds, even unchanged: the form shows it.
  const read = followRecord(s, { a: 1 }, 4);
  assert.deepEqual(read.form, { a: 1 });
  assert.equal(isDirty(read), false);
});

test('a save whose re-read landed first: the form shows the record, and the answer changes nothing', () => {
  let s = edit(initialFormState({ a: 1 }), { a: 2.0 });
  s = beginSave(s, 3);
  s = followRecord(s, { a: 2 }, 4);
  assert.deepEqual(s.form, { a: 2 });
  assert.equal(afterSave(s, { a: 2.0 }), s);
});

test('a failed save keeps the edit, and later reads follow by value again', () => {
  let s = edit(initialFormState({ a: 1 }), { a: 2 });
  s = failedSave(beginSave(s, 3));
  assert.deepEqual(s.form, { a: 2 });
  assert.equal(followRecord(s, { a: 1 }, 4), s);
});
