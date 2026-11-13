/**
 * Recursive path sizing (apparent size: sum of file byte lengths via lstat).
 * Cross-platform stdlib walk — no `du` subprocess. Symlinks are counted as
 * their own link size and never followed (no cycles, no double-counting
 * through links). Unreadable or vanished entries are skipped and reported
 * via `partial` so callers can flag an undercount.
 */
import { join } from 'node:path';
import { lstat, readdir } from 'node:fs/promises';

/**
 * @param {string} absPath - absolute path to a file or directory
 * @param {{ deadline?: number }} [opts] - `deadline` (epoch ms): the walk stops
 *   there and reports `partial` (CODING-RULES §6; a huge tree is sized in part)
 * @returns {Promise<{ sizeBytes: number, partial: boolean }>}
 */
export async function measurePathSize(absPath, { deadline } = {}) {
  let sizeBytes = 0;
  let partial = false;

  async function walk(path) {
    if (deadline != null && Date.now() > deadline) {
      partial = true;
      return;
    }
    let st;
    try {
      st = await lstat(path);
    } catch {
      /* entry vanished mid-walk or is unreadable — size what we can */
      partial = true;
      return;
    }
    if (!st.isDirectory()) {
      sizeBytes += st.size;
      return;
    }
    let entries;
    try {
      entries = await readdir(path);
    } catch {
      partial = true;
      return;
    }
    // Sequential on purpose: unbounded fan-out can exhaust fds on huge trees.
    for (const entry of entries) {
      await walk(join(path, entry));
    }
  }

  if (deadline == null) {
    await walk(absPath);
    return { sizeBytes, partial };
  }
  // A call stuck in the kernel (an lstat on a dead SMB source) never reaches
  // the deadline check between entries: race the walk against a timer and
  // answer the sum so far. A stuck walk then stops at its next check.
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
  });
  const late = await Promise.race([walk(absPath).then(() => false), timedOut]);
  clearTimeout(timer);
  return { sizeBytes, partial: partial || late };
}
