/**
 * Persisted last-backup-attempt status per workload (app-glue).
 *
 * The on-disk backup tree only records successes — a failed backup removes
 * its partial directory, so "did last night's scheduled backup work?" is
 * unanswerable from disk alone. This module keeps one small record per
 * workload of the most recent attempt in `config/backup-status.json`,
 * written on every manual/scheduled backup completion. It is a cache of
 * the last outcome, not history: self-healing and safe to delete (the
 * self-updater preserves it via RSYNC_EXCLUDES). A record follows its
 * workload: a rename moves it, a delete drops it.
 *
 * This module also carries the change signal for everything backup-shaped:
 * every write and notifyBackupsChanged() poke subscribers, and the `backups`
 * topic on /api/events re-broadcasts the status snapshot so open tabs know to
 * refresh their backup lists.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomicJson.js';
import { errorBody } from './appErrors.js';
import { subscribeVMBackupDeleted } from './vmManager/index.js';
import { subscribeContainerBackupDeleted } from './containerManager/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo-root config/ (beside wisp-config.json), the directory the updater's swap
// preserves — not backend/config/, which the swap's rsync --delete removes.
const STATUS_PATH = resolve(__dirname, '../../../config/backup-status.json');

let cache = null;
let writeChain = Promise.resolve();
const changeHandlers = new Set();

/** @typedef {'vm' | 'container'} WorkloadType */

function bucketOf(type) {
  return type === 'vm' ? 'vms' : 'containers';
}

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
 * Apply `change` (a pure `status → status`) to the current map, write it and
 * announce it; a change that answers the map itself writes nothing. The
 * change runs on the map as it is once loaded, in the same step that installs
 * its result, so two writers never build on the same old map. A failed write
 * is swallowed: the file is best-effort, and must never fail the backup,
 * rename or delete that wrote it.
 */
async function changeStatus(change) {
  await loadStatus();
  const next = change(cache);
  if (next === cache) return;
  cache = next;
  writeChain = writeChain
    .then(() => writeJsonAtomic(STATUS_PATH, next))
    .catch(() => { /* best-effort cache, see above */ });
  await writeChain;
  notifyBackupsChanged();
}

/**
 * @returns {Promise<{ vms: Record<string, object>, containers: Record<string, object> }>}
 * Entry shape: backupAttemptRecord's.
 */
export async function getBackupStatus() {
  return loadStatus();
}

/**
 * One attempt's record: `{ at, ok, origin, destinationIds }`, plus the backup
 * folder name (`timestamp`) of a success, or the failure's error body
 * (`error`, its code; `detail`, its text — lib/appErrors.js) — the key
 * `error` always holds a code.
 *
 * @param {{ ok: boolean, origin: 'manual' | 'scheduled', destinationIds: string[],
 *           timestamp?: string | null, error?: unknown, at: string }} attempt
 */
export function backupAttemptRecord({ ok, origin, destinationIds, timestamp = null, error, at }) {
  const record = { at, ok, origin, destinationIds: [...destinationIds] };
  if (ok) {
    if (timestamp) record.timestamp = timestamp;
    return record;
  }
  return { ...record, ...errorBody(error) };
}

/**
 * Record the outcome of one backup attempt and notify subscribers.
 * @param {{ type: WorkloadType, name: string, ok: boolean, origin: 'manual' | 'scheduled',
 *           destinationIds: string[], timestamp?: string | null, error?: unknown }} attempt
 */
export async function recordBackupAttempt({ type, name, ...attempt }) {
  const record = backupAttemptRecord({ ...attempt, at: new Date().toISOString() });
  const bucket = bucketOf(type);
  await changeStatus((status) => ({ ...status, [bucket]: { ...status[bucket], [name]: record } }));
}

/**
 * `status` with `from`'s record under `to` (a rename): the renamed workload's
 * last attempt, never a record `to` kept from an earlier workload of that name.
 * Pure: answers a new map, or `status` itself when nothing changes.
 */
export function statusMoved(status, type, from, to) {
  const bucket = bucketOf(type);
  const records = { ...status[bucket] };
  if (!(from in records) && !(to in records)) return status;
  const moved = records[from];
  delete records[from];
  if (moved) records[to] = moved;
  else delete records[to];
  return { ...status, [bucket]: records };
}

/** `status` without `name`'s record (a delete). Pure: `status` itself when it has none. */
export function statusForgotten(status, type, name) {
  const bucket = bucketOf(type);
  if (!(name in status[bucket])) return status;
  const records = { ...status[bucket] };
  delete records[name];
  return { ...status, [bucket]: records };
}

/** Move a renamed workload's last-attempt record to its new name. */
export async function moveBackupStatus({ type, from, to }) {
  await changeStatus((status) => statusMoved(status, type, from, to));
}

/** Drop a deleted workload's last-attempt record, so its row doesn't linger in the backups panel. */
export async function forgetBackupStatus({ type, name }) {
  await changeStatus((status) => statusForgotten(status, type, name));
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

/* A backup deleted by any caller (the routes, the scheduler's retention) changes
 * the backup lists: the managers announce it, and this module passes it on. */
subscribeVMBackupDeleted(() => notifyBackupsChanged());
subscribeContainerBackupDeleted(() => notifyBackupsChanged());

export function subscribeBackupEvents(handler) {
  changeHandlers.add(handler);
  return () => changeHandlers.delete(handler);
}
