/*
 * A task's status as Wisp compares it, and whether a task is on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTaskStatus, isTaskOn } from './containerManagerLifecycle.js';

test('a status is its enum name; anything else, or none, is UNKNOWN', () => {
  for (const name of ['UNKNOWN', 'CREATED', 'RUNNING', 'STOPPED', 'PAUSED', 'PAUSING']) assert.equal(normalizeTaskStatus(name), name);
  for (const other of [undefined, null, '', 'running', 'BOGUS', 2, '2', 2n]) assert.equal(normalizeTaskStatus(other), 'UNKNOWN', String(other));
});

test('a task is on while running or paused', () => {
  assert.equal(isTaskOn(null), false);
  for (const [status, on] of [['RUNNING', true], ['PAUSED', true], ['PAUSING', false], ['CREATED', false], ['STOPPED', false], ['UNKNOWN', false]]) {
    assert.equal(isTaskOn({ status }), on, status);
  }
});
