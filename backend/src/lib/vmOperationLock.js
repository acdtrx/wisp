/**
 * Per-VM operation lock (Wisp glue — vmManager stays policy-free, CODING-RULES §7).
 *
 * Start, backup, delete and rename each read, move or replace a stopped VM's
 * disks or definition, so at most one of them runs per VM at a time. A second
 * one is refused with 409 `VM_BUSY` instead of queueing: the caller retries
 * once the running operation (visible as a background job for backup)
 * finishes.
 *
 * In-memory only: a backend restart ends every operation that held a lock.
 * Acquire is synchronous, so a route that acquires before its first `await`
 * after the check cannot race another request for the same VM.
 */
import { createAppError } from './routeErrors.js';

/** @type {Map<string, string>} VM name → operation label holding the lock */
const held = new Map();

/**
 * Take the lock for `name`, or throw `VM_BUSY` if another operation holds it.
 * @param {string} name - VM name
 * @param {'start' | 'backup' | 'delete' | 'rename'} operation - label for the 409 message
 * @returns {() => void} release — idempotent
 */
export function acquireVmOperationLock(name, operation) {
  const current = held.get(name);
  if (current) {
    throw createAppError(
      'VM_BUSY',
      `VM "${name}" is busy`,
      `A ${current} of this VM is in progress — retry when it finishes`,
    );
  }
  held.set(name, operation);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(name);
  };
}

/**
 * Run `fn` while holding the lock for `name`; released when `fn` settles.
 * @template T
 * @param {string} name
 * @param {'start' | 'backup' | 'delete' | 'rename'} operation
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withVmOperationLock(name, operation, fn) {
  const release = acquireVmOperationLock(name, operation);
  try {
    return await fn();
  } finally {
    release();
  }
}
