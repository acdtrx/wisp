/**
 * A failed backup attempt's record in `config/backup-status.json` carries the
 * error body since 2026-11-20 (docs/specs/BACKUPS.md → Backup attempt status):
 * `error` is the failure's code, `detail` its text, as on every other channel.
 * Records written earlier hold the message in `error`. Each one gets that
 * message as its `detail` and `INTERNAL_ERROR` as its `error`: the code of a
 * failure nothing coded, which is all such a record can say. One with no
 * message gets `INTERNAL_ERROR` too, its `detail` saying the cause was not
 * recorded: the key `error` always holds a code (lib/backupStatus.js). The
 * file is the install's own `config/backup-status.json` (lib/backupStatus.js
 * keeps it there, whatever WISP_CONFIG_PATH says).
 *
 * Left alone: a missing file (no attempt recorded yet), one that is not a JSON
 * object (the backend reads it as empty and replaces it at the next attempt),
 * successful records, and failed records with a `detail` (already this
 * shape). Idempotent for the same reason.
 *
 * Backward-compatible: the previous release passes a record through as it is
 * and its UI shows only that the last attempt failed. A rollback restores the
 * install's config/, this file with it, and the ledger, which an installed
 * Wisp keeps there too (it refuses WISP_CONFIG_PATH), so this runs again at
 * the next start of the newer release.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../src/lib/atomicJson.js';

export const id = '0009-backup-status-error-code';
export const description = 'Failed backup attempt records carry an error code and the message as their detail';

/** The detail of a failed record that held no message. */
const NO_CAUSE = 'The backup failed; its cause was not recorded';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

export async function run(ctx) {
  const path = join(ctx.paths.installDir, 'config', 'backup-status.json');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let status;
  try {
    status = JSON.parse(text);
  } catch {
    ctx.log.warn({ path }, 'backup-status.json is not JSON — left for the backend to replace');
    return;
  }
  if (!isPlainObject(status)) {
    ctx.log.warn({ path }, 'backup-status.json is not an object — left for the backend to replace');
    return;
  }

  let changed = false;
  for (const bucket of ['vms', 'containers']) {
    if (!isPlainObject(status[bucket])) continue;
    for (const [name, record] of Object.entries(status[bucket])) {
      if (!isPlainObject(record) || record.ok !== false || 'detail' in record) continue;
      const message = typeof record.error === 'string' && record.error ? record.error : null;
      status[bucket][name] = { ...record, error: 'INTERNAL_ERROR', detail: message ?? NO_CAUSE };
      ctx.recordChange(message
        ? `backup-status.json ${bucket}.${name}: error message → detail, error INTERNAL_ERROR`
        : `backup-status.json ${bucket}.${name}: no message → error INTERNAL_ERROR, cause not recorded`);
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(path, status);
}
