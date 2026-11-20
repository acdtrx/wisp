import { streamJobProgress } from '../api/jobs.js';
import { ApiError, CLIENT_CODES } from '../api/errors.js';
import { JOB_KIND, TOPIC } from '../../../shared/wireNames.js';
import { createStreamStore, topicSource } from './streamStore.js';

/**
 * The server's jobs, as the `jobs` topic lists them, each with what its progress
 * stream brought. The topic is the only source of rows: it lists every job,
 * whoever started it, and drops a finished one when the server expires it. A
 * job's progress, result and error come from its own stream
 * (`GET /api/jobs/:jobId/progress`), never from the topic.
 *
 * @typedef {{ type: 'vm' | 'container', name: string }} JobSubject
 *
 * @typedef {Object} JobProgress - what a job's progress stream brought
 * @property {string | null} step
 * @property {number | null} percent
 * @property {string | null} detail
 * @property {Record<string, object>} events - the latest event of each step, with the kind's own fields
 * @property {'done' | 'error' | 'cancelled' | 'gone' | null} end - the terminal event's step;
 *   `gone`: the server no longer knows the job (404); null while the stream runs
 * @property {ApiError | null} error - the job's error event
 * @property {unknown} result - the job's result, from its `done` event
 *
 * @typedef {Object} BackgroundJobRow - a topic row with its job's progress
 * @property {string} jobId
 * @property {string} kind - a kind of the server's, known to this client or not (shown by its title)
 * @property {string} title
 * @property {JobSubject | null} subject - the workload the job acts on
 * @property {'running' | 'done' | 'error' | 'cancelled'} status - the terminal event's once it came, else the topic's
 * @property {number} createdAt
 * @property {string | null} step
 * @property {number | null} percent
 * @property {string | null} detail
 * @property {Record<string, object>} events
 * @property {ApiError | null} error
 * @property {unknown} result
 */

/** @type {JobProgress} */
const NO_PROGRESS = Object.freeze({
  step: null, percent: null, detail: null, events: {}, end: null, error: null, result: null,
});

/** @returns {JobProgress} */
function applyEvent(progress, ev) {
  const next = {
    ...progress,
    step: ev.step ?? progress.step,
    percent: ev.percent != null ? ev.percent : progress.percent,
    detail: ev.detail ?? ev.currentFile ?? progress.detail,
  };
  if (ev.step === 'error') {
    next.end = 'error';
    next.error = new ApiError({ code: ev.error, detail: ev.detail });
  } else if (ev.step === 'done') {
    next.end = 'done';
    next.result = ev.result;
  } else if (ev.step === 'cancelled') {
    next.end = 'cancelled';
  } else if (ev.step) {
    next.events = { ...progress.events, [ev.step]: ev };
  }
  return next;
}

/** @returns {BackgroundJobRow} */
function mergeRow(row, progress = NO_PROGRESS) {
  // A terminal event can arrive before the frame that lists the job as ended: it
  // decides, and an ended job never shows running again.
  const ended = progress.end && progress.end !== 'gone';
  return {
    jobId: row.jobId,
    kind: row.kind,
    title: row.title,
    subject: row.subject ?? null,
    status: ended ? progress.end : row.status,
    createdAt: row.createdAt,
    step: progress.step,
    percent: progress.percent,
    detail: progress.detail,
    events: progress.events,
    error: progress.error,
    result: progress.result,
  };
}

function mergedJobs(rows, progress, dismissed) {
  const jobs = {};
  for (const [jobId, row] of Object.entries(rows)) {
    if (!dismissed.has(jobId)) jobs[jobId] = mergeRow(row, progress[jobId]);
  }
  return jobs;
}

/** The topic's rows by jobId; `undefined` for a frame that is not the list. */
function rowsOf(frame) {
  if (!Array.isArray(frame?.jobs)) return undefined;
  const rows = {};
  for (const row of frame.jobs) rows[row.jobId] = row;
  return rows;
}

/** `data`: the topic's rows, by jobId (each frame is the whole list). */
export const useBackgroundJobsStore = createStreamStore({
  source: topicSource(TOPIC.JOBS),
  toData: rowsOf,
  empty: {},
  onData: (rows, set) => {
    set((s) => {
      // A stream still open stays: an awaited job may be listed only in a later frame.
      const progress = {};
      for (const [jobId, p] of Object.entries(s.progress)) {
        if (rows[jobId] || !p.end) progress[jobId] = p;
      }
      const dismissed = new Set([...s.dismissed].filter((jobId) => rows[jobId]));
      return { progress, dismissed, jobs: mergedJobs(rows, progress, dismissed) };
    });
    // A finished row is followed too: its stream replays the result or the error.
    for (const jobId of Object.keys(rows)) followJob(jobId);
  },
  extend: (set) => ({
    /** Each followed job's progress, by jobId: a job is followed while it is listed or awaited. @type {Record<string, JobProgress>} */
    progress: {},
    /** Finished rows this page hid from its tray, until the server drops them. @type {Set<string>} */
    dismissed: new Set(),
    /** What the tray and busy state read: the listed rows not dismissed, with their progress. @type {Record<string, BackgroundJobRow>} */
    jobs: {},

    /** Hide a finished row from this page's tray. */
    dismissJob: (jobId) => set((s) => {
      const dismissed = new Set(s.dismissed).add(jobId);
      const { [jobId]: _gone, ...jobs } = s.jobs;
      return { dismissed, jobs };
    }),
  }),
});

function setProgress(jobId, update) {
  useBackgroundJobsStore.setState((s) => {
    const progress = { ...s.progress, [jobId]: update(s.progress[jobId] ?? NO_PROGRESS) };
    const row = s.data[jobId];
    const jobs = row && !s.dismissed.has(jobId)
      ? { ...s.jobs, [jobId]: mergeRow(row, progress[jobId]) }
      : s.jobs;
    return { progress, jobs };
  });
}

/**
 * Open a job's progress stream, once per job: it reconnects and replays until
 * the terminal event or a refusal. A 404 means the job is gone; another
 * refusal ends the wait with its error.
 */
function followJob(jobId) {
  if (useBackgroundJobsStore.getState().progress[jobId]) return;
  setProgress(jobId, () => NO_PROGRESS);
  streamJobProgress(
    jobId,
    (ev) => setProgress(jobId, (p) => applyEvent(p, ev)),
    (err) => setProgress(jobId, (p) => (err.status === 404 ? { ...p, end: 'gone' } : { ...p, end: 'error', error: err })),
  );
}

/**
 * Follow a job by the jobId its ack named, listed by the topic yet or not:
 * resolve with its result, or reject with its error, an ApiError as `api()`
 * throws (`JOB_GONE` when the server no longer knows the job). A cancelled job
 * (an interruptible one, cut at shutdown) resolves with no result. The job runs
 * on the server whether or not anyone waits for it.
 * @param {string} jobId
 * @returns {Promise<unknown>}
 */
export function awaitJob(jobId) {
  const store = useBackgroundJobsStore;
  followJob(jobId);
  return new Promise((resolve, reject) => {
    const settle = (progress) => {
      switch (progress?.end ?? null) {
        case null:
          return false;
        case 'done':
          resolve(progress.result);
          return true;
        case 'cancelled':
          resolve(undefined);
          return true;
        case 'error':
          reject(progress.error);
          return true;
        default:
          reject(new ApiError({ code: CLIENT_CODES.JOB_GONE, detail: 'The server no longer knows this job' }));
          return true;
      }
    };
    if (settle(store.getState().progress[jobId])) return;
    const unsubscribe = store.subscribe((state) => {
      if (settle(state.progress[jobId])) unsubscribe();
    });
  });
}

/**
 * The running job that holds a workload (its subject), or null: while it runs,
 * the server refuses the workload's other operations with its busy error.
 * @param {Record<string, BackgroundJobRow>} jobs
 * @param {JobSubject} subject
 * @returns {BackgroundJobRow | null}
 */
export function workloadBusyJob(jobs, { type, name }) {
  if (!name) return null;
  return Object.values(jobs).find(
    (j) => j.status === 'running' && j.subject?.type === type && j.subject?.name === name,
  ) ?? null;
}

/** `workloadBusyJob` for a component: re-renders when that workload's busy job changes. */
export function useWorkloadBusy({ type, name }) {
  return useBackgroundJobsStore((s) => workloadBusyJob(s.jobs, { type, name }));
}

/** The kinds that back a workload up or restore it in place: what the backup surfaces follow. */
const BACKUP_KINDS = new Set([JOB_KIND.VM_BACKUP, JOB_KIND.CONTAINER_BACKUP, JOB_KIND.CONTAINER_RESTORE]);

/**
 * The running backup or restore-in-place job of a workload, or null. Narrower
 * than busy: a start or a delete holds the workload but is no backup.
 * @param {Record<string, BackgroundJobRow>} jobs
 * @param {JobSubject} subject
 * @returns {BackgroundJobRow | null}
 */
export function workloadBackupJob(jobs, { type, name }) {
  if (!name) return null;
  return Object.values(jobs).find(
    (j) => j.status === 'running' && BACKUP_KINDS.has(j.kind) && j.subject?.type === type && j.subject?.name === name,
  ) ?? null;
}

/** `workloadBackupJob` for a component. */
export function useWorkloadBackup({ type, name }) {
  return useBackgroundJobsStore((s) => workloadBackupJob(s.jobs, { type, name }));
}

/** The reason a busy workload's controls are disabled, naming the job that holds it. */
export function workloadBusyReason(job) {
  return job ? `Unavailable while “${job.title}” runs` : undefined;
}
