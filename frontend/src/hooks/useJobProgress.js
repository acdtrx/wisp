import { useBackgroundJobsStore } from '../store/backgroundJobsStore.js';

/**
 * What a job's progress stream brought (`step`, `percent`, `detail`, `events`, `end`,
 * `error`, `result`; store/backgroundJobsStore.js, JobProgress), to show it beside
 * the control that started it, or null before its stream answered. The one reader of
 * a job's progress outside the tray; to act on a job's end, await it (`awaitJob`, or
 * the command hook's `job`).
 *
 * @param {string | null} jobId
 */
export function useJobProgress(jobId) {
  return useBackgroundJobsStore((s) => (jobId ? s.progress[jobId] ?? null : null));
}
