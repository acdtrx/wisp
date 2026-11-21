import { test } from 'node:test';
import assert from 'node:assert/strict';

import { changedFields, rowId, sameValues } from './editorValues.js';

test('changedFields and sameValues compare by value', () => {
  assert.deepEqual(changedFields({ a: 1, b: [1] }, { a: 1, b: [2] }), { b: [1] });
  assert.deepEqual(changedFields({ a: 1 }, null), { a: 1 });
  assert.equal(sameValues({ a: [1] }, { a: [1] }), true);
  assert.equal(sameValues({ a: 1 }, { a: 2 }), false);
});

test('each row gets an identity of its own', () => {
  assert.notEqual(rowId(), rowId());
});
