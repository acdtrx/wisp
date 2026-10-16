/**
 * Per-container operation lock (Wisp glue — containerManager stays policy-free,
 * CODING-RULES §7). The container counterpart of `vmOperationLock.js`.
 *
 * Start, stop, kill, restart, delete, rename, backup, restore and every edit
 * that writes container.json each read, move or replace the container's task,
 * netns, snapshot, directory or config, so at most one of them runs per
 * container at a time. A second one is refused with 409 `CONTAINER_BUSY`
 * naming the running operation instead of queueing: the caller retries once
 * it finishes (backup and restore are visible as background jobs).
 *
 * The restart policy and the backend-start autostart pass live inside
 * containerManager, which can't import this module; they take the same lock
 * through `tryAcquireContainerOperationLock`, injected via
 * `containerManager.configure({ tryAcquireOperationLock })`
 * (lib/managerBootstrap.js).
 *
 * In-memory only: a backend restart ends every operation that held a lock.
 * Acquire is synchronous, so a caller that acquires before its first `await`
 * after the check cannot race another request for the same container.
 */
import { createAppError } from './routeErrors.js';

/** @type {Map<string, string>} container name → operation label holding the lock */
const held = new Map();

/**
 * Take the lock for `name`, or return null when another operation holds it.
 * @param {string} name - container name
 * @param {string} operation - label naming the operation in a 409 (e.g. 'start', 'backup')
 * @returns {(() => void) | null} release — idempotent; null when busy
 */
export function tryAcquireContainerOperationLock(name, operation) {
  if (held.has(name)) return null;
  held.set(name, operation);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(name);
  };
}

/**
 * Take the lock for `name`, or throw `CONTAINER_BUSY` naming the operation
 * that holds it.
 * @param {string} name - container name
 * @param {string} operation - label naming the operation in a 409
 * @returns {() => void} release — idempotent
 */
export function acquireContainerOperationLock(name, operation) {
  const release = tryAcquireContainerOperationLock(name, operation);
  if (release) return release;
  const current = held.get(name);
  throw createAppError(
    'CONTAINER_BUSY',
    `Container "${name}" is busy (${current} in progress)`,
    `Another operation (${current}) is running on this container — retry when it finishes`,
  );
}

/**
 * Run `fn` while holding the lock for `name`; released when `fn` settles.
 * @template T
 * @param {string} name
 * @param {string} operation
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withContainerOperationLock(name, operation, fn) {
  const release = acquireContainerOperationLock(name, operation);
  try {
    return await fn();
  } finally {
    release();
  }
}
