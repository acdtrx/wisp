/**
 * Atomic JSON write — vendored copy private to containerManager.
 *
 * Why vendored: containerManager is the only consumer outside of Wisp glue
 * (settings.js, bootCleanup.js). Keeping its own copy means containerManager
 * carries no Wisp-glue dependency edge ahead of the eventual library extraction.
 * The tmp-suffix pattern matches `lib/atomicJson.js` so bootCleanup's janitor
 * still finds tmp files in the containers directory.
 *
 * Stage to a sibling temp file, fsync, then rename(2). `rename` is atomic on
 * the same filesystem, so readers always see either the old or the new full
 * file — never a half-written one.
 *
 * Tmp suffix: `.tmp.<pid>.<timestamp>.<rand>`.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ATOMIC_TMP_SUFFIX_RE = /\.tmp\.\d+\.\d+\.[a-f0-9]+$/;

export function atomicTmpName(filePath) {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
}

export async function writeJsonAtomic(filePath, obj, { spaces = 2, mode } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = atomicTmpName(filePath);
  let handle;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.writeFile(JSON.stringify(obj, null, spaces), 'utf8');
    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
