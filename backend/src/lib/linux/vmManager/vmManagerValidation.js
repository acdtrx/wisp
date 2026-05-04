/**
 * VM and snapshot name validators (private to vmManager).
 *
 * Routes do their own validation against `lib/validation.js` before calling
 * the manager — these vendored copies are the manager's defense-in-depth at
 * the libvirt boundary, kept here so vmManager has no Wisp-glue imports.
 */
import { vmError } from '../../vmManagerShared.js';

const VM_NAME_MAX_LEN = 128;
const VM_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export function validateVMName(name) {
  if (name == null || typeof name !== 'string') {
    throw vmError('INVALID_VM_NAME', 'VM name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw vmError('INVALID_VM_NAME', 'VM name cannot be empty');
  }
  if (trimmed.length > VM_NAME_MAX_LEN) {
    throw vmError('INVALID_VM_NAME', `VM name must be at most ${VM_NAME_MAX_LEN} characters`);
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw vmError('INVALID_VM_NAME', 'VM name cannot contain .. or path separators');
  }
  if (!VM_NAME_REGEX.test(trimmed)) {
    throw vmError(
      'INVALID_VM_NAME',
      'VM name may only contain letters, numbers, dots, hyphens and underscores',
    );
  }
}

const SNAPSHOT_NAME_MAX_LEN = 64;
const SNAPSHOT_NAME_REGEX = /^[a-zA-Z0-9 ._-]+$/;

export function validateSnapshotName(name) {
  if (name == null || typeof name !== 'string') {
    throw vmError('INVALID_SNAPSHOT_NAME', 'Snapshot name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw vmError('INVALID_SNAPSHOT_NAME', 'Snapshot name cannot be empty');
  }
  if (trimmed.length > SNAPSHOT_NAME_MAX_LEN) {
    throw vmError(
      'INVALID_SNAPSHOT_NAME',
      `Snapshot name must be at most ${SNAPSHOT_NAME_MAX_LEN} characters`,
    );
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw vmError('INVALID_SNAPSHOT_NAME', 'Snapshot name cannot contain .. or path separators');
  }
  if (!SNAPSHOT_NAME_REGEX.test(trimmed)) {
    throw vmError(
      'INVALID_SNAPSHOT_NAME',
      'Snapshot name may only contain letters, numbers, spaces, dots, hyphens and underscores',
    );
  }
}
