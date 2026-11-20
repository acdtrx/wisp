/**
 * The login password file lives beside the config file, wherever
 * WISP_CONFIG_PATH puts it, since 2026-11-20 (docs/specs/CONFIGURATION.md →
 * Password Storage); earlier releases kept it in the install's config/ whatever
 * WISP_CONFIG_PATH said. On a host whose WISP_CONFIG_PATH names a file in
 * another directory (a line set by hand: no Wisp tool writes it), the install's
 * config/wisp-password moves there, so the password still signs in.
 *
 * - The same file in both places (no WISP_CONFIG_PATH, one in config/, or a
 *   directory that links to it): nothing to do — checked on the files
 *   themselves, so a symlinked directory never loses its only copy.
 * - No password in the install's config/: nothing to move.
 * - None beside the config file: the install's is copied there (staged,
 *   synced, renamed; mode 0600), then removed.
 * - One beside the config file already: it is the one in use. The install's
 *   is removed when it holds the same hash (a run cut short after its copy) and
 *   otherwise left alone, logged.
 * Idempotent for the same reasons. The hash is never logged.
 *
 * Backward-compatible: the previous release reads the install's
 * config/wisp-password, and a rollback restores config/ from its snapshot,
 * that file included. The copy beside the config file stays (it is outside
 * config/), unread by the previous release; this migration's ledger entry,
 * beside it too, stays as well, so a later update does not run it again and
 * leaves the restored file where it is, unused.
 */
import { readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../src/lib/atomicJson.js';

export const id = '0010-password-beside-config';
export const description = 'The login password file lives beside the config file';

async function statIfExists(path) {
  try {
    return await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function run(ctx) {
  const source = join(ctx.paths.installDir, 'config', 'wisp-password');
  const target = join(ctx.paths.configDir, 'wisp-password');
  const sourceStat = await statIfExists(source);
  if (!sourceStat) return;
  const targetStat = await statIfExists(target);
  if (targetStat && targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino) return;

  const text = await readFile(source, 'utf8');
  if (!targetStat) {
    await writeFileAtomic(target, text, { mode: 0o600 });
    ctx.recordChange(`wisp-password copied from ${source} to ${target}`);
  } else if (await readFile(target, 'utf8') !== text) {
    ctx.log.warn({ source, target }, `${target} already holds a password, the one in use: ${source} is left alone`);
    return;
  }
  await unlink(source);
  ctx.recordChange(`${source} removed: the password is read from ${target}`);
}
