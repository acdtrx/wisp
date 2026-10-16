/**
 * containerManager-internal slot for the embedder's per-container operation
 * lock. The manager's own background starts — the restart policy and the
 * backend-start autostart pass — must not run while the embedder has another
 * operation in flight on the same container (two starts tear each other's
 * netns and snapshot down; a start under a backup or restore races the files).
 *
 * The lock itself is policy and lives with the embedder (Wisp:
 * lib/containerOperationLock.js); it is pushed in via
 * `containerManager.configure({ tryAcquireOperationLock })`. Contract: a sync
 * `(name, operation) => release | null` — null when the container is busy,
 * otherwise an idempotent release function.
 */
let tryAcquireFn = null;

export function setOperationLockAcquirer(fn) {
  if (typeof fn !== 'function') {
    throw new Error('containerManager.configure: tryAcquireOperationLock must be a function (name, operation) => release | null');
  }
  tryAcquireFn = fn;
}

/**
 * Take the embedder's lock for `name`, or return null when another operation
 * holds it.
 * @param {string} name
 * @param {string} operation - label the embedder reports to a refused caller
 * @returns {(() => void) | null}
 */
export function tryAcquireOperationLock(name, operation) {
  if (tryAcquireFn === null) {
    throw new Error('containerManager not configured — call containerManager.configure() during boot');
  }
  return tryAcquireFn(name, operation);
}
