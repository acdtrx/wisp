/**
 * `cloud-init.json` holds the guest user's password hash and sits in the
 * group-readable per-VM directory; it is written 0600 since 2026-10-16. This
 * tightens every older copy under `vmsPath` — including the directories of
 * VMs deleted with "keep disks" — to 0600. Wisp's own file (lib/cloudInit.js),
 * not a manager's, so it is chmodded here directly.
 *
 * Backward-compatible: the previous release reads it as the same deploy user.
 * Idempotent: a file with no group/other bits is left alone.
 */
import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const id = '0003-cloud-init-json-mode';
export const description = 'cloud-init.json files (password hash) are mode 0600';

const MODE = 0o600;

export async function run(ctx) {
  const { vmsPath } = ctx.getConfig();
  let entries;
  try {
    entries = await readdir(vmsPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // no VM directory yet
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(vmsPath, entry.name, 'cloud-init.json');
    let st;
    try {
      st = await lstat(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isFile()) continue;
    const mode = st.mode & 0o7777;
    if ((mode & 0o077) === 0) continue;
    ctx.recordChange(`${entry.name}/cloud-init.json: mode ${octal(mode)} → ${octal(MODE)}`);
    if (!ctx.dryRun) await chmod(file, MODE);
  }
}

function octal(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
