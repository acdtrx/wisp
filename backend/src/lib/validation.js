/**
 * Shared validation helpers for route parameters.
 */

const VM_NAME_MAX_LEN = 128;
const VM_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate VM name for path safety. Throws { code: 'INVALID_VM_NAME', message } if invalid.
 * Allowed: alphanumeric, hyphens, underscores, dots. Rejects empty, '..', '/', length > 128.
 */
export function validateVMName(name) {
  if (name == null || typeof name !== 'string') {
    throw Object.assign(new Error('VM name is required'), { code: 'INVALID_VM_NAME' });
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error('VM name cannot be empty'), { code: 'INVALID_VM_NAME' });
  }
  if (trimmed.length > VM_NAME_MAX_LEN) {
    throw Object.assign(new Error(`VM name must be at most ${VM_NAME_MAX_LEN} characters`), { code: 'INVALID_VM_NAME' });
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw Object.assign(new Error('VM name cannot contain .. or path separators'), { code: 'INVALID_VM_NAME' });
  }
  if (!VM_NAME_REGEX.test(trimmed)) {
    throw Object.assign(new Error('VM name may only contain letters, numbers, dots, hyphens and underscores'), { code: 'INVALID_VM_NAME' });
  }
}

const CONTAINER_NAME_MAX_LEN = 63;
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

/**
 * Validate container name (matches container create rules). Throws { code: 'INVALID_CONTAINER_NAME', message } if invalid.
 */
export function validateContainerName(name) {
  if (name == null || typeof name !== 'string') {
    throw Object.assign(new Error('Container name is required'), { code: 'INVALID_CONTAINER_NAME' });
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error('Container name cannot be empty'), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (trimmed.length > CONTAINER_NAME_MAX_LEN) {
    throw Object.assign(new Error(`Container name must be at most ${CONTAINER_NAME_MAX_LEN} characters`), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw Object.assign(new Error('Container name cannot contain .. or path separators'), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (!CONTAINER_NAME_REGEX.test(trimmed)) {
    throw Object.assign(new Error('Invalid container name format'), { code: 'INVALID_CONTAINER_NAME' });
  }
}
