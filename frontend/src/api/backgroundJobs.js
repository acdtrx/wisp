import { api } from './client.js';

/**
 * Server-owned background jobs (in-memory). Used to restore the jobs tray after refresh.
 * @returns {Promise<{ jobs: Array<{ jobId: string, kind: string, title: string, done: boolean, createdAt: number }> }>}
 */
export function fetchBackgroundJobs() {
  return api('/api/background-jobs');
}
