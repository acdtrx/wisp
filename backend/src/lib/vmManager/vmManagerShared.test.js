import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vmError, wrapVmError } from './vmManagerShared.js';

test("a wrapped Wisp error's message joins the outer one, its raw the raw", () => {
  const err = wrapVmError('BACKUP_INVALID', "Backup disk vda can't be restored", vmError('DISK_IMAGE_UNSAFE', 'Disk image x has a backing file', 'flatten it'));
  assert.equal(err.code, 'BACKUP_INVALID');
  assert.equal(err.message, "Backup disk vda can't be restored: Disk image x has a backing file");
  assert.equal(err.raw, 'flatten it');
});

test('an error another Wisp factory built counts as Wisp\'s: it carries the same mark', () => {
  const fromStorage = Object.defineProperty(Object.assign(new Error('Disk image x is unsafe'), { code: 'DISK_IMAGE_UNSAFE' }),
    Symbol.for('wisp.error'), { value: true });
  assert.equal(wrapVmError('BACKUP_INVALID', 'Restore failed', fromStorage).message, 'Restore failed: Disk image x is unsafe');
});

test('a wrapped error that is not Wisp\'s is all raw', () => {
  const errno = Object.assign(new Error("EACCES: permission denied, rename '/a' -> '/b'"), { code: 'EACCES' });
  const err = wrapVmError('CONFIG_ERROR', 'Failed to move the directory of VM "a" to "b"', errno);
  assert.equal(err.message, 'Failed to move the directory of VM "a" to "b"');
  assert.equal(err.raw, "EACCES: permission denied, rename '/a' -> '/b'");
});
