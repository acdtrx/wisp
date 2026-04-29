/**
 * Atomic JSON write: stage to a sibling temp file, fsync, then rename(2).
 *
 * Why: a crash mid-write of a JSON config file (container.json, wisp-config.json,
 * oci-image-meta.json) leaves a truncated file that can't be parsed on next start.
 * `rename` is atomic on the same filesystem, so readers always see either the
 * old or the new full file — never a half-written one.
 *
 * Tmp suffix: `.tmp.<pid>.<timestamp>.<rand>` so the boot-time cleanup pass
 * (cleanPartialJsonArtifacts) can find and remove leftovers.
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
