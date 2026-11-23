/**
 * The one atomic file write: stage to a sibling temp file created with `mode`
 * (wx: never reusing one), fsync, close, then rename(2) over the target. A
 * crash mid-write leaves the old file whole, never a truncated one; `rename`
 * is atomic on one filesystem. The temp file is removed when a step fails.
 *
 * Temp suffix: `.tmp.<pid>.<timestamp>.<rand>`. A temp file a crash leaves
 * behind is removed at boot (bootCleanup.js) only where that sweep runs: the
 * config folder, each VM's folder, and each container's folder and its
 * `files/`. Elsewhere (a container's `runs/`, a backup folder) it stays, the
 * listings ignore it, and it goes when its folder does.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const ATOMIC_TMP_SUFFIX_RE = /\.tmp\.\d+\.\d+\.[a-f0-9]+$/;

export function atomicTmpName(filePath) {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
}

export async function writeFileAtomic(filePath, text, { mode } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = atomicTmpName(filePath);
  let handle;
  try {
    handle = await open(tmp, 'wx', mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => { /* the write's own error, thrown below, is the one to report */ });
    await unlink(tmp).catch(() => { /* the write's own error, thrown below, is the one to report */ });
    throw err;
  }
}

export async function writeJsonAtomic(filePath, obj, { spaces = 2, mode } = {}) {
  await writeFileAtomic(filePath, JSON.stringify(obj, null, spaces), { mode });
}
