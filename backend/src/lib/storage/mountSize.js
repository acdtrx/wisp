/**
 * A mount's size (statfs), read without ever waiting on a mount that does not
 * answer: the read runs in a worker thread, and its caller waits at most
 * MOUNT_SIZE_BOUND_MS after the read began. A mount has at most one read in
 * flight: while an earlier read has not come back, a caller joins it, past its
 * bound answers at once, and no new read starts. A worker stuck on a dead hard
 * mount cannot be killed; it ends when the kernel call returns, so there is at
 * most one per mount. No cache and no timer of its own.
 */
import { Worker } from 'node:worker_threads';

/** statfs answers in microseconds on a local disk, milliseconds on a healthy share. */
export const MOUNT_SIZE_BOUND_MS = 3000;

/** mountPath -> { done: Promise<outcome>, startedAt } for the read in flight. */
const inFlight = new Map();

/** @returns {Promise<{ sizes } | { error }>} never rejects */
function startRead(mountPath) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const worker = new Worker(new URL('./mountSizeWorker.js', import.meta.url), { workerData: { mountPath } });
    // A worker stuck in statfs must not keep the process alive at shutdown.
    worker.unref();
    worker.once('message', (msg) => settle(msg));
    worker.once('error', (err) => settle({ error: { code: err.code ?? null, message: err.message } }));
    worker.once('exit', (code) => settle({ error: { code: null, message: `size reader exited with code ${code}` } }));
  });
}

/**
 * The size of the filesystem mounted at `mountPath`:
 * `{ sizes: { totalBytes, usedBytes, availBytes } }`, `{ error: { code, message } }`
 * when statfs failed, or `{ timedOut: true }` when the read has not come back
 * within MOUNT_SIZE_BOUND_MS of its start. Never rejects.
 */
export async function readMountSize(mountPath) {
  let read = inFlight.get(mountPath);
  if (!read) {
    read = { done: startRead(mountPath), startedAt: Date.now() };
    inFlight.set(mountPath, read);
    read.done.then(() => { if (inFlight.get(mountPath) === read) inFlight.delete(mountPath); });
  }
  const left = read.startedAt + MOUNT_SIZE_BOUND_MS - Date.now();
  if (left <= 0) return { timedOut: true };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), left);
  });
  return Promise.race([read.done, timeout]).finally(() => clearTimeout(timer));
}

/** How many size reads are in flight (a stuck one stays counted): for the logs and tests. */
export function mountSizeReadsInFlight() {
  return inFlight.size;
}
