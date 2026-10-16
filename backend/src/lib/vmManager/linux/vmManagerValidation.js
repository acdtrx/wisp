/**
 * VM name validator (private to vmManager).
 *
 * Routes do their own validation against `lib/validation.js` before calling
 * the manager — this vendored copy is the manager's defense-in-depth at
 * the libvirt boundary, kept here so vmManager has no Wisp-glue imports.
 */
import { vmError } from '../vmManagerShared.js';

const VM_NAME_MAX_LEN = 128;
// Leading alphanumeric: `.`, `..` and `.foo` can never be a VM name, so the
// per-VM directory is always a child of vmsPath (never vmsPath itself).
const VM_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateVMName(name) {
  if (name == null || typeof name !== 'string') {
    throw vmError('INVALID_VM_NAME', 'VM name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw vmError('INVALID_VM_NAME', 'VM name cannot be empty');
  }
  if (trimmed !== name) {
    throw vmError('INVALID_VM_NAME', 'VM name cannot start or end with whitespace');
  }
  if (name.length > VM_NAME_MAX_LEN) {
    throw vmError('INVALID_VM_NAME', `VM name must be at most ${VM_NAME_MAX_LEN} characters`);
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw vmError('INVALID_VM_NAME', 'VM name cannot contain .. or path separators');
  }
  if (!VM_NAME_REGEX.test(name)) {
    throw vmError(
      'INVALID_VM_NAME',
      'VM name must start with a letter or number and may only contain letters, numbers, dots, hyphens and underscores',
    );
  }
}
