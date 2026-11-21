import { test } from 'node:test';
import assert from 'node:assert/strict';

import { beginSave, endSave, failSave, followRecord, initialFormState, isDirty } from './formState.js';

const edit = (state, form) => ({ ...state, form });

test('a form starts from its record, not dirty; an edit makes it dirty, by value', () => {
  const s = initialFormState({ a: 1, b: 'x' });
  assert.equal(isDirty(s), false);
  assert.equal(isDirty(edit(s, { a: 2, b: 'x' })), true);
  assert.equal(isDirty(edit(s, { a: 1, b: 'x' })), false);
});

test('a re-read that changes what the form shows resets it; one that leaves those values keeps the edit', () => {
  const s = edit(initialFormState({ a: 1 }), { a: 5 });
  assert.equal(followRecord(s, { a: 1 }), s);
  const reset = followRecord(s, { a: 2 });
  assert.deepEqual(reset.form, { a: 2 });
  assert.equal(isDirty(reset), false);
});

test('a save: no following while it runs; a failure keeps the edit, dirty; a success shows the saved record', () => {
  let s = beginSave(edit(initialFormState({ a: 1 }), { a: 2 }));
  // A record update lands mid-save with the old values, then one with others: neither moves the form.
  s = followRecord(s, { a: 1 });
  s = followRecord(s, { a: 7 });
  assert.deepEqual(s.form, { a: 2 });
  // The save fails: the form keeps what was typed, dirty against the record as it now is.
  s = followRecord(failSave(s), { a: 7 });
  assert.deepEqual(s.form, { a: 2 });
  assert.deepEqual(s.saved, { a: 7 });
  assert.equal(isDirty(s), true);
  // Saved again: the form shows the record as it is when the save ends, normalised.
  s = followRecord(endSave(beginSave(s)), { a: 2.5 });
  assert.deepEqual(s.form, { a: 2.5 });
  assert.equal(isDirty(s), false);
});

test('after the save ends the form follows by value again', () => {
  let s = followRecord(endSave(beginSave(edit(initialFormState({ a: 1 }), { a: 2 }))), { a: 2 });
  s = edit(s, { a: 3 });
  assert.equal(followRecord(s, { a: 2 }), s);
});
