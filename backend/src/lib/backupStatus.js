/**
 * Persisted last-backup-attempt status per workload (app-glue).
 *
 * The on-disk backup tree only records successes — a failed backup removes
 * its partial directory, so "did last night's scheduled backup work?" is
 * unanswerable from disk alone. This module keeps one small record per
 * workload of the most recent attempt in `config/backup-status.json`,
 * written on every manual/scheduled backup completion. It is a cache of
 * the last outcome, not history: self-healing and safe to delete (the
 * self-updater preserves it via RSYNC_EXCLUDES).
 *
 * This module also carries the change signal for everything backup-shaped:
 * recordBackupAttempt() and notifyBackupsChanged() both poke subscribers,
 * and the `backups` topic on /api/events re-broadcasts the status snapshot
 * so open tabs know to refresh their backup lists.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomicJson.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_PATH = resolve(__dirname, '../../config/backup-status.json');

let cache = null;
let writeChain = Promise.resolve();
const changeHandlers = new Set();

async function loadStatus() {
  if (cache) return cache;
  try {
    const data = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
    cache = {
      vms: data?.vms && typeof data.vms === 'object' ? data.vms : {},
      containers: data?.containers && typeof data.containers === 'object' ? data.containers : {},
    };
  } catch {
    /* missing or unparsable — start fresh; the file is a last-outcome cache */
    cache = { vms: {}, containers: {} };
  }
  return cache;
}

/**
 * @returns {Promise<{ vms: Record<string, object>, containers: Record<string, object> }>}
 * Entry shape: { at, ok, origin, destinationIds, timestamp?, error? }
 */
export async function getBackupStatus() {
  return loadStatus();
}

/**
 * Record the outcome of one backup attempt and notify subscribers.
 *
 * @param {{ kind: 'vm' | 'container', name: string, ok: boolean,
 *           origin?: 'manual' | 'scheduled', destinationIds?: string[],
 *           timestamp?: string | null, error?: string | null }} attempt
 */
export async function recordBackupAttempt({ kind, name, ok, origin = 'manual', destinationIds = [], timestamp = null, error = null }) {
  const bucket = kind === 'vm' ? 'vms' : 'containers';
  const status = await loadStatus();
  const entry = {
    at: new Date().toISOString(),
    ok: !!ok,
    origin: origin === 'scheduled' ? 'scheduled' : 'manual',
    destinationIds: Array.isArray(destinationIds) ? destinationIds : [],
  };
  if (ok && timestamp) entry.timestamp = timestamp;
  if (!ok && error) entry.error = String(error);
  status[bucket][name] = entry;
  writeChain = writeChain
    .then(() => writeJsonAtomic(STATUS_PATH, status))
    .catch(() => {
      /* status file is best-effort — a failed write must never fail the backup job */
    });
  await writeChain;
  notifyBackupsChanged();
  return entry;
}

/** Poke subscribers that backup state changed (new/pruned/deleted backups, attempt status). */
export function notifyBackupsChanged() {
  for (const handler of changeHandlers) {
    try {
      handler();
    } catch {
      /* a broken subscriber must not break the backup flow that notified */
    }
  }
}

export function subscribeBackupEvents(handler) {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}
