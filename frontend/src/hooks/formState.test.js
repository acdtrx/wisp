import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginSave, changedFields, editForm, endSave, failSave, followRecord, initialFormState, isDirty, resetForm, sameValues,
} from './formState.js';

const toForm = (data) => ({ name: data.name });
const record = (name) => ({ name });

test('a form starts from its record, clean; an edit makes it dirty, by value; editing back makes it clean', () => {
  let s = initialFormState(record('a'), toForm);
  assert.deepEqual(s.form, { name: 'a' });
  assert.equal(isDirty(s), false);
  s = editForm(s, (f) => ({ ...f, name: 'b' }));
  assert.equal(isDirty(s), true);
  s = editForm(s, (f) => ({ ...f, name: 'a' }));
  assert.equal(isDirty(s), false);
});

test('a clean form follows its record; an edited one ignores it', () => {
  let s = initialFormState(record('a'), toForm);
  s = followRecord(s, record('b'), toForm);
  assert.deepEqual(s.form, { name: 'b' });
  s = editForm(s, (f) => ({ ...f, name: 'typed' }));
  s = followRecord(s, record('c'), toForm);
  assert.deepEqual(s.form, { name: 'typed' });
  assert.deepEqual(s.start, { name: 'b' });
});

test('an edit undone shows the record as it is now, a change made while it was edited included', () => {
  let s = initialFormState(record('a'), toForm);
  s = editForm(s, (f) => ({ ...f, name: 'typed' }));
  s = followRecord(s, record('c'), toForm);
  s = editForm(s, (f) => ({ ...f, name: 'a' }));
  s = followRecord(s, s.data, toForm);
  assert.deepEqual(s.form, { name: 'c' });
  assert.equal(isDirty(s), false);
});

test('the same record data is no change; no record yet is no form', () => {
  const data = record('a');
  const s = initialFormState(data, toForm);
  assert.equal(followRecord(s, data, toForm), s);
  const none = initialFormState(null, toForm);
  assert.equal(none.form, null);
  assert.equal(editForm(none, () => ({ name: 'x' })), none);
  assert.deepEqual(followRecord(none, data, toForm).form, { name: 'a' });
});

test('a successful save makes the saved values the start: clean, and following again', () => {
  const data = record('a');
  let s = editForm(initialFormState(data, toForm), () => ({ name: 'b' }));
  s = beginSave(s);
  s = endSave(s, toForm);
  assert.deepEqual(s.start, { name: 'b' });
  assert.equal(isDirty(s), false);
  s = followRecord(s, record('b2'), toForm);
  assert.deepEqual(s.form, { name: 'b2' });
});

test('a record that changed while the save ran is taken when it succeeds', () => {
  let s = editForm(initialFormState(record('a'), toForm), () => ({ name: ' b ' }));
  s = beginSave(s);
  s = followRecord(s, record('b'), toForm);
  assert.deepEqual(s.form, { name: ' b ' });
  s = endSave(s, toForm);
  assert.deepEqual(s.form, { name: 'b' });
  assert.equal(isDirty(s), false);
});

test('a failed save leaves the form as typed, dirty; undo takes the record as it is now', () => {
  let s = editForm(initialFormState(record('a'), toForm), () => ({ name: 'b' }));
  s = failSave(followRecord(beginSave(s), record('c'), toForm));
  assert.deepEqual(s.form, { name: 'b' });
  assert.equal(isDirty(s), true);
  s = resetForm(s, toForm);
  assert.deepEqual(s.form, { name: 'c' });
  assert.equal(isDirty(s), false);
});

test('changedFields and sameValues compare by value', () => {
  assert.deepEqual(changedFields({ a: 1, b: [1] }, { a: 1, b: [2] }), { b: [1] });
  assert.equal(sameValues({ a: [1] }, { a: [1] }), true);
});
