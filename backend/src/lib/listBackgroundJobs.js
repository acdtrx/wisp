import * as createJobStore from './createJobStore.js';
import * as backupJobStore from './backupJobStore.js';
import * as downloadJobStore from './downloadJobStore.js';
import { containerJobStore } from './containerJobStore.js';

/**
 * In-memory background jobs across all task types, newest first (each store already sorts).
 */
export function listBackgroundJobs() {
  return [
    ...createJobStore.listJobs(),
    ...backupJobStore.listJobs(),
    ...downloadJobStore.listJobs(),
    ...containerJobStore.listJobs(),
  ].sort((a, b) => b.createdAt - a.createdAt);
}
