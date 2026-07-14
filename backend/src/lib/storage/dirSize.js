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
 * @returns {Promise<{ sizeBytes: number, partial: boolean }>}
 */
export async function measurePathSize(absPath) {
  let sizeBytes = 0;
  let partial = false;

  async function walk(path) {
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

  await walk(absPath);
  return { sizeBytes, partial };
}
