import { test } from 'node:test';
import assert from 'node:assert/strict';

import { destinationOrder } from './backupDestinations.js';

const mounts = [{ id: 'm-b' }, { id: 'm-a' }];

test('Local first, then the mounts in the settings order, whatever order they were ticked in', () => {
  assert.deepEqual(destinationOrder(['m-a', 'local', 'm-b'], mounts), ['local', 'm-b', 'm-a']);
  assert.deepEqual(destinationOrder(['m-a'], mounts), ['m-a']);
  assert.deepEqual(destinationOrder(['local'], undefined), ['local']);
});

test('an id the settings no longer list keeps its place after them', () => {
  assert.deepEqual(destinationOrder(['old', 'm-a', 'local'], mounts), ['local', 'm-a', 'old']);
});

test('a malformed settings list, or none, never throws', () => {
  assert.deepEqual(destinationOrder(['m-a', 'local'], [null, { id: 'm-a' }, 7]), ['local', 'm-a']);
  assert.deepEqual(destinationOrder(['local'], 'not a list'), ['local']);
  assert.deepEqual(destinationOrder(undefined, mounts), []);
});
