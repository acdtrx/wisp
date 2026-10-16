/**
 * Owner-only modes for existing VM backups: every
 * `<root>/vms/<vmName>/<timestamp>/` directory 0700 and each regular file in
 * it 0600 — the modes createBackup gives a new backup (it holds the guest's
 * disks and cloud-init.json's password hash). Tightens backups an earlier
 * release left at the umask default, for the state migration that runs on
 * update.
 *
 * Pure filesystem work — no libvirt — so the macOS dev stub exports it too.
 * Returns one record per entry it changed (or, under `dryRun`, would change);
 * see `restrictToOwner` for the record shape.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { restrictToOwner } from '../../storage/index.js';
import { VMS_BACKUP_DIRNAME } from './vmManagerPaths.js';

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
 * @param {string[]} roots - absolute backup destination roots; one that does not exist is skipped
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function tightenVMBackupFileModes(roots, { dryRun = false } = {}) {
  const changes = [];
  for (const root of roots) {
    const vmsRoot = join(root, VMS_BACKUP_DIRNAME);
    for (const nameEntry of await listDir(vmsRoot)) {
      if (!nameEntry.isDirectory()) continue;
      const nameDir = join(vmsRoot, nameEntry.name);
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
