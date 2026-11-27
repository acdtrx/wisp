/**
 * Emptying a folder mount's backing folder in place: pure filesystem work,
 * tested on any platform.
 */
import { join } from 'node:path';
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';

/**
 * Remove everything `dir` holds and keep `dir` itself, so a running task's
 * bind mount of it sees what is put there next: a folder removed and made
 * again would leave the task on the removed one. Each entry is removed as it
 * is, whatever made it (the container included): a folder with all it
 * holds, a symbolic link as the link, never followed. `dir` is made when it
 * is missing; a `dir` that is not a folder (a file, a link) is replaced by one.
 */
export async function emptyMountFolder(dir) {
  const info = await lstat(dir).catch((err) => {
    if (err.code === 'ENOENT') return null; // missing: made below
    throw err;
  });
  if (info && !info.isDirectory()) await rm(dir, { force: true });
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) {
    await rm(join(dir, entry), { recursive: true, force: true });
  }
}
