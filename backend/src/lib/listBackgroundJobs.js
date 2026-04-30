import * as createJobStore from './createJobStore.js';
import * as backupJobStore from './backupJobStore.js';
import * as downloadJobStore from './downloadJobStore.js';
import { containerJobStore } from './containerJobStore.js';
import { wispUpdateJobStore } from './wispUpdateJobStore.js';

/* Each store is independent; if one throws (corrupted in-memory state, future
 * regression, etc.) we still want to surface the others to the UI rather than
 * blanking the entire jobs panel. */
function safeList(fn) {
  try {
    const out = fn();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * In-memory background jobs across all task types, newest first (each store already sorts).
 */
export function listBackgroundJobs() {
  return [
    ...safeList(() => createJobStore.listJobs()),
    ...safeList(() => backupJobStore.listJobs()),
    ...safeList(() => downloadJobStore.listJobs()),
    ...safeList(() => containerJobStore.listJobs()),
    ...safeList(() => wispUpdateJobStore.listJobs()),
  ].sort((a, b) => b.createdAt - a.createdAt);
}
