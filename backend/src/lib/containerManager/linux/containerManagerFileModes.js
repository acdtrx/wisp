/**
 * Owner-only modes for containerManager state that holds secrets: each
 * container directory (0700) and its `container.json` (0600), and every
 * container backup (timestamp directory 0700, its files 0600). New state gets
 * these modes when written (containerManagerCreate / ConfigIo / Backup); these
 * functions tighten state an earlier release left at the umask default, for
 * the state migration that runs on update.
 *
 * Pure filesystem work — no containerd — so the macOS dev stub exports them
 * too. Each returns one record per entry it changed (or, under `dryRun`, would
 * change); see `restrictToOwner` for the record shape.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { restrictToOwner } from '../../storage/index.js';
import { CONTAINERS_BACKUP_DIRNAME, getContainersPath } from './containerPaths.js';

/** Directory entries of `dir`, or [] when it does not exist. */
async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Every directory under the containers root — containers, and directories
 * kept by a delete with "keep files" (their mount data is as private) — and
 * each one's container.json. Dot-entries (restore staging, the image-meta
 * cache) are not container directories.
 *
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function tightenContainerFileModes({ dryRun = false } = {}) {
  const root = getContainersPath();
  const changes = [];
  for (const entry of await listDir(root)) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const dirChange = await restrictToOwner(dir, { type: 'dir', dryRun });
    if (dirChange) changes.push(dirChange);
    const fileChange = await restrictToOwner(join(dir, 'container.json'), { type: 'file', dryRun });
    if (fileChange) changes.push(fileChange);
  }
  return changes;
}

/**
 * Every container backup under the given backup roots
 * (`<root>/containers/<name>/<timestamp>/`): the timestamp directory and each
 * regular file directly in it. A root that does not exist is skipped.
 *
 * @param {string[]} roots - absolute backup destination roots
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function tightenContainerBackupFileModes(roots, { dryRun = false } = {}) {
  const changes = [];
  for (const root of roots) {
    const containersRoot = join(root, CONTAINERS_BACKUP_DIRNAME);
    for (const nameEntry of await listDir(containersRoot)) {
      if (!nameEntry.isDirectory()) continue;
      const nameDir = join(containersRoot, nameEntry.name);
      for (const tsEntry of await listDir(nameDir)) {
        if (!tsEntry.isDirectory()) continue;
        const backupDir = join(nameDir, tsEntry.name);
        const dirChange = await restrictToOwner(backupDir, { type: 'dir', dryRun });
        if (dirChange) changes.push(dirChange);
        for (const fileEntry of await listDir(backupDir)) {
          if (!fileEntry.isFile()) continue;
          const fileChange = await restrictToOwner(join(backupDir, fileEntry.name), { type: 'file', dryRun });
          if (fileChange) changes.push(fileChange);
        }
      }
    }
  }
  return changes;
}
