/**
 * Owner-only modes for existing files and directories that hold secrets
 * (container.json, backup archives). New files get their mode at creation;
 * this tightens existing ones left at the umask default.
 *
 * The path is opened without following a symlink and changed through the
 * handle, so a symlink planted in its place never redirects the chmod.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const GROUP_OTHER_BITS = 0o077;

/* chmod refusals that are a property of the filesystem or the owner, not a
 * fault: vfat and a read-only mount answer with these, as does an entry
 * another user owns. CIFS without Unix extensions accepts the call and keeps
 * its mount-wide mode, which the re-stat below reports. */
const MODE_UNSUPPORTED_ERRORS = new Set(['EPERM', 'EROFS', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Clear the group/other permission bits of a regular file or directory.
 *
 * @param {string} path
 * @param {{ type: 'file' | 'dir', dryRun?: boolean }} opts - `type` the entry must be; anything else (symlink, FIFO, the other type) is left alone
 * @returns {Promise<null | { path: string, type: 'file' | 'dir', from: number, to: number, applied: boolean, reason?: string }>}
 *   null when there is nothing to change (absent, wrong type, already owner-only);
 *   `applied: false` under `dryRun`, and with a `reason` when the change was attempted but not made
 *   (the filesystem keeps its own modes, or refused the chmod)
 */
export async function restrictToOwner(path, { type, dryRun = false }) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    // ENOENT: nothing there. ELOOP: a symlink (O_NOFOLLOW) — never ours to change.
    if (err.code === 'ENOENT' || err.code === 'ELOOP') return null;
    throw err;
  }
  try {
    const st = await handle.stat();
    if (type === 'file' ? !st.isFile() : !st.isDirectory()) return null;
    const from = st.mode & 0o7777;
    if ((from & GROUP_OTHER_BITS) === 0) return null;
    const to = from & ~GROUP_OTHER_BITS;
    if (dryRun) return { path, type, from, to, applied: false };
    try {
      await handle.chmod(to);
    } catch (err) {
      if (!MODE_UNSUPPORTED_ERRORS.has(err.code)) throw err;
      return { path, type, from, to, applied: false, reason: `chmod refused (${err.code})` };
    }
    const after = (await handle.stat()).mode & 0o7777;
    if ((after & GROUP_OTHER_BITS) !== 0) {
      return { path, type, from, to, applied: false, reason: 'filesystem keeps its own modes' };
    }
    return { path, type, from, to: after, applied: true };
  } finally {
    await handle.close().catch(() => { /* read-only handle; nothing left to flush */ });
  }
}

function formatMode(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

/**
 * One line per directory for a list of `restrictToOwner` records: the
 * directory's own change first, then its files', e.g.
 * `/var/lib/wisp/containers/caddy: 0755 → 0700; container.json 0644 → 0600`.
 * A change attempted but not made carries its reason.
 *
 * @param {Array<{ path: string, type: 'file' | 'dir', from: number, to: number, applied: boolean, reason?: string }>} changes
 * @returns {string[]}
 */
export function describeModeChanges(changes) {
  const byDir = new Map();
  for (const change of changes) {
    const dir = change.type === 'dir' ? change.path : dirname(change.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(change);
  }
  return [...byDir].map(([dir, list]) => {
    const parts = list.map((c) => {
      const label = c.type === 'dir' ? '' : `${basename(c.path)} `;
      const note = c.reason ? ` (not applied: ${c.reason})` : '';
      return `${label}${formatMode(c.from)} → ${formatMode(c.to)}${note}`;
    });
    return `${dir}: ${parts.join('; ')}`;
  });
}
