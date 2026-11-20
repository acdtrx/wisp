/**
 * A failed backup attempt's record in `config/backup-status.json` carries the
 * error body since 2026-11-20 (docs/specs/BACKUPS.md → Backup attempt status):
 * `error` is the failure's code, `detail` its text, as on every other channel.
 * Records written earlier hold the message in `error`. Each one gets that
 * message as its `detail` and `INTERNAL_ERROR` as its `error`: the code of a
 * failure nothing coded, which is all such a record can say. The file is the
 * install's own `config/backup-status.json` (lib/backupStatus.js keeps it
 * there, whatever WISP_CONFIG_PATH says).
 *
 * Left alone: a missing file (no attempt recorded yet), one that is not a JSON
 * object (the backend reads it as empty and replaces it at the next attempt),
 * successful records, and failed records with a `detail` (already this shape)
 * or with no message. Idempotent for the same reason.
 *
 * Backward-compatible: the previous release passes a record through as it is
 * and its UI shows only that the last attempt failed. The file is in config/,
 * so a rollback reverts it with the ledger and this runs again.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../src/lib/atomicJson.js';

export const id = '0009-backup-status-error-code';
export const description = 'Failed backup attempt records carry an error code and the message as their detail';

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
      if (!isPlainObject(record) || record.ok !== false) continue;
      if ('detail' in record || typeof record.error !== 'string') continue;
      status[bucket][name] = { ...record, error: 'INTERNAL_ERROR', detail: record.error };
      ctx.recordChange(`backup-status.json ${bucket}.${name}: error message → detail, error INTERNAL_ERROR`);
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(path, status);
}
