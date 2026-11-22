/**
 * One mount's size, read in a worker thread for mountSize.js: a statfs on a
 * share that does not answer blocks this thread (on a hard mount, until the
 * kernel call returns), never the backend's.
 */
import { statfsSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

try {
  const st = statfsSync(workerData.mountPath);
  // `df` semantics: used = total − free; available = what an unprivileged
  // writer (the deploy user) can still use, i.e. excluding the root reserve.
  parentPort.postMessage({
    sizes: {
      totalBytes: st.blocks * st.bsize,
      usedBytes: Math.max(0, (st.blocks - st.bfree) * st.bsize),
      availBytes: st.bavail * st.bsize,
    },
  });
} catch (err) {
  parentPort.postMessage({ error: { code: err.code ?? null, message: err.message } });
}
