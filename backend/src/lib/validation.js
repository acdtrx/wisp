/**
 * The value schemas the routes and the MCP tools both check input against
 * (lib/schemaValidation.js): one rule for a VM name, a container name and a
 * run id, wherever one arrives.
 */

/*
 * A workload name is a path segment under its directory (docs/specs/VM-MANAGEMENT.md,
 * docs/specs/CONTAINERS.md): letters, digits, dots, hyphens and underscores,
 * a leading letter or digit (so never `.` or `..`), no `..` anywhere, used
 * verbatim (never trimmed, so surrounding whitespace is refused).
 */
const WORKLOAD_NAME_PATTERN = '^(?!.*\\.\\.)[a-zA-Z0-9][a-zA-Z0-9._-]*$';

export const vmNameSchema = { type: 'string', maxLength: 128, pattern: WORKLOAD_NAME_PATTERN };

export const containerNameSchema = { type: 'string', maxLength: 63, pattern: WORKLOAD_NAME_PATTERN };

/** A container run's id, as the run log files are named (`2026-10-16T18-34-18-915Z`). */
export const runIdSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z$' };
const VM_NAME_MAX_LEN = 128;
// Leading alphanumeric (mirrors CONTAINER_NAME_REGEX): `.`, `..` and `.foo`
// can never be a VM name, so getVMBasePath(name) is always a child of vmsPath.
const VM_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validate VM name for path safety. Throws { code: 'INVALID_VM_NAME', message } if invalid.
 * Allowed: letters, digits, dots, hyphens, underscores; must start with a letter or digit.
 * Rejects empty, surrounding whitespace (callers use the name verbatim, so it is
 * never silently trimmed), '..', '/', length > 128.
 */
export function validateVMName(name) {
  if (name == null || typeof name !== 'string') {
    throw Object.assign(new Error('VM name is required'), { code: 'INVALID_VM_NAME' });
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error('VM name cannot be empty'), { code: 'INVALID_VM_NAME' });
  }
  if (trimmed !== name) {
    throw Object.assign(new Error('VM name cannot start or end with whitespace'), { code: 'INVALID_VM_NAME' });
  }
  if (name.length > VM_NAME_MAX_LEN) {
    throw Object.assign(new Error(`VM name must be at most ${VM_NAME_MAX_LEN} characters`), { code: 'INVALID_VM_NAME' });
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('VM name cannot contain .. or path separators'), { code: 'INVALID_VM_NAME' });
  }
  if (!VM_NAME_REGEX.test(name)) {
    throw Object.assign(new Error('VM name must start with a letter or number and may only contain letters, numbers, dots, hyphens and underscores'), { code: 'INVALID_VM_NAME' });
  }
}

const CONTAINER_NAME_MAX_LEN = 63;
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

/**
 * Validate container name (matches container create rules; never silently trimmed). Throws { code: 'INVALID_CONTAINER_NAME', message } if invalid.
 */
export function validateContainerName(name) {
  if (name == null || typeof name !== 'string') {
    throw Object.assign(new Error('Container name is required'), { code: 'INVALID_CONTAINER_NAME' });
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw Object.assign(new Error('Container name cannot be empty'), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (trimmed !== name) {
    throw Object.assign(new Error('Container name cannot start or end with whitespace'), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (name.length > CONTAINER_NAME_MAX_LEN) {
    throw Object.assign(new Error(`Container name must be at most ${CONTAINER_NAME_MAX_LEN} characters`), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw Object.assign(new Error('Container name cannot contain .. or path separators'), { code: 'INVALID_CONTAINER_NAME' });
  }
  if (!CONTAINER_NAME_REGEX.test(name)) {
    throw Object.assign(new Error('Invalid container name format'), { code: 'INVALID_CONTAINER_NAME' });
  }
}
