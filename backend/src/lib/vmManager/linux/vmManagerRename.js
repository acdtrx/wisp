/**
 * VM rename mechanics: relocate the on-disk directory and rewrite every
 * absolute path that referenced the old directory.
 *
 * Used by renameVM (vmManagerConfig).
 *
 * State touched:
 *   - libvirt domain XML: `<disk><source file>`, `<os><nvram>`, `<os><loader>`,
 *     and any other `@_file` attribute under devices that points at the per-VM
 *     directory.
 *
 * Out of scope:
 *   - Image library / shared images (those live under getImagePath, not the
 *     per-VM dir, so rewriting wouldn't apply).
 *   - Backups (they reference vmBasePath in the manifest at backup time;
 *     a rename happens after a backup was taken, so the backup keeps the old
 *     path — that's expected, restore re-creates the per-VM dir under the
 *     current name).
 */
import { rename as fsRename } from 'node:fs/promises';
import { basename } from 'node:path';

import { wrapVmError } from '../vmManagerShared.js';

function startsWithDir(filePath, dir) {
  if (typeof filePath !== 'string') return false;
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

function rewriteAbs(filePath, oldDir, newDir) {
  if (!startsWithDir(filePath, oldDir)) return filePath;
  if (filePath === oldDir) return newDir;
  return `${newDir}${filePath.slice(oldDir.length)}`;
}

/**
 * Mutates the parsed domain object in place. Returns count of paths rewritten.
 */
export function rewriteDomainPaths(dom, oldDir, newDir) {
  if (!dom) return 0;
  let n = 0;

  // Disks: <disk><source file=".."/></disk>
  const disks = dom.devices?.disk;
  const diskList = Array.isArray(disks) ? disks : (disks ? [disks] : []);
  for (const d of diskList) {
    const src = d?.source;
    if (src && typeof src === 'object' && typeof src['@_file'] === 'string') {
      const next = rewriteAbs(src['@_file'], oldDir, newDir);
      if (next !== src['@_file']) {
        src['@_file'] = next;
        n += 1;
      }
    }
  }

  // OS: <os><nvram>...</nvram><loader readonly='no'>...</loader></os>
  const os = dom.os;
  if (os) {
    if (typeof os.nvram === 'string') {
      const next = rewriteAbs(os.nvram, oldDir, newDir);
      if (next !== os.nvram) { os.nvram = next; n += 1; }
    } else if (os.nvram && typeof os.nvram === 'object' && typeof os.nvram['#text'] === 'string') {
      const next = rewriteAbs(os.nvram['#text'], oldDir, newDir);
      if (next !== os.nvram['#text']) { os.nvram['#text'] = next; n += 1; }
    }
    // Writable loader (UEFI VARS template path) — we don't usually write
    // here, but rewrite defensively if it points into the per-VM dir.
    if (os.loader && typeof os.loader === 'object' && typeof os.loader['#text'] === 'string') {
      const next = rewriteAbs(os.loader['#text'], oldDir, newDir);
      if (next !== os.loader['#text']) { os.loader['#text'] = next; n += 1; }
    }
  }

  return n;
}

/**
 * Move a per-VM directory atomically. Same-filesystem rename(2). Returns
 * `true` on success, `false` only when `oldDir` does not exist (caller decides
 * whether that's acceptable). Any other failure throws a structured vmError
 * so the caller can roll back the libvirt rename.
 */
export async function moveVmDirectory(oldDir, newDir) {
  try {
    await fsRename(oldDir, newDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw wrapVmError('CONFIG_ERROR', `Failed to move the directory of VM "${basename(oldDir)}" to "${basename(newDir)}"`, err);
  }
  return true;
}
