import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAppError } from './appErrors.js';
import { backupAttemptRecord, statusMoved, statusForgotten } from './backupStatus.js';

const AT = '2026-11-20T03:00:00.000Z';

test('a successful attempt records its backup folder name, and no error', () => {
  assert.deepEqual(
    backupAttemptRecord({ ok: true, origin: 'scheduled', destinationIds: ['local'], timestamp: '2026-11-20T03-00-00', at: AT }),
    { at: AT, ok: true, origin: 'scheduled', destinationIds: ['local'], timestamp: '2026-11-20T03-00-00' },
  );
});

test('a failed attempt records the error body: error is the code, detail the text', () => {
  const err = createAppError('BACKUP_MOUNT_FAILED', 'Network mount failed', 'mount error(13): Permission denied');
  assert.deepEqual(
    backupAttemptRecord({ ok: false, origin: 'manual', destinationIds: ['local', 'nas'], error: err, at: AT }),
    {
      at: AT,
      ok: false,
      origin: 'manual',
      destinationIds: ['local', 'nas'],
      error: 'BACKUP_MOUNT_FAILED',
      detail: 'Network mount failed: mount error(13): Permission denied',
    },
  );
});

test('a failure nothing coded records INTERNAL_ERROR, its message the detail', () => {
  const record = backupAttemptRecord({ ok: false, origin: 'manual', destinationIds: ['local'], error: new Error('boom'), at: AT });
  assert.equal(record.error, 'INTERNAL_ERROR');
  assert.equal(record.detail, 'boom');
  assert.equal('timestamp' in record, false);
});

const status = () => ({
  vms: { web: { ok: true, at: AT }, old: { ok: false, at: AT } },
  containers: { web: { ok: false, at: AT } },
});

test('a rename moves the record to the new name, in its own kind only', () => {
  const before = status();
  const after = statusMoved(before, 'vm', 'web', 'site');
  assert.deepEqual(after.vms, { site: { ok: true, at: AT }, old: { ok: false, at: AT } });
  assert.deepEqual(after.containers, before.containers);
  assert.deepEqual(before, status(), 'the map it was given is unchanged');
});

test('a renamed workload with no record drops the one its new name kept', () => {
  assert.deepEqual(statusMoved(status(), 'vm', 'none', 'old').vms, { web: { ok: true, at: AT } });
});

test('a rename that touches no record answers the map itself', () => {
  const before = status();
  assert.equal(statusMoved(before, 'container', 'a', 'b'), before);
});

test('a delete forgets the record, and a workload with none answers the map itself', () => {
  const before = status();
  assert.deepEqual(statusForgotten(before, 'container', 'web').containers, {});
  assert.deepEqual(statusForgotten(before, 'container', 'web').vms, before.vms);
  assert.equal(statusForgotten(before, 'vm', 'nope'), before);
});
