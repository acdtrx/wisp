/**
 * Container name validator (private to containerManager).
 *
 * Routes do their own validation against `lib/validation.js` before calling
 * the manager — this vendored copy is the manager's defense-in-depth at the
 * containerd boundary, kept here so containerManager has no Wisp-glue imports.
 */
import { containerError } from './containerManagerConnection.js';

const CONTAINER_NAME_MAX_LEN = 63;
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

export function validateContainerName(name) {
  if (name == null || typeof name !== 'string') {
    throw containerError('INVALID_CONTAINER_NAME', 'Container name is required');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw containerError('INVALID_CONTAINER_NAME', 'Container name cannot be empty');
  }
  if (trimmed.length > CONTAINER_NAME_MAX_LEN) {
    throw containerError(
      'INVALID_CONTAINER_NAME',
      `Container name must be at most ${CONTAINER_NAME_MAX_LEN} characters`,
    );
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw containerError(
      'INVALID_CONTAINER_NAME',
      'Container name cannot contain .. or path separators',
    );
  }
  if (!CONTAINER_NAME_REGEX.test(trimmed)) {
    throw containerError('INVALID_CONTAINER_NAME', 'Invalid container name format');
  }
}
