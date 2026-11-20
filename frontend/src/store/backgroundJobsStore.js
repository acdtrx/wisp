import { create } from 'zustand';
import { JOB_KIND, listJobs, streamJobProgress } from '../api/jobs.js';
import { ApiError, CLIENT_CODES } from '../api/errors.js';

/** Same TTL as the server's job store, measured the same way: from completion.
 *  A finished row leaves the tray once it has been finished this long. */
const DONE_UI_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {{ type: 'vm' | 'container', name: string }} JobSubject
 *
 * @typedef {Object} BackgroundJobRow
 * @property {string} jobId
 * @property {string} kind - a JOB_KIND, or a kind this client does not know (shown by its title)
 * @property {string} title
 * @property {JobSubject | null} subject - the workload the job acts on
 * @property {string | null} step
 * @property {number | null} percent
 * @property {string | null} detail
 * @property {Record<string, object>} events - the latest event of each step, with the kind's own fields
 * @property {'running' | 'done' | 'error'} status
 * @property {ApiError | null} error - the job's error event (`code`, `detail`), or why its stream ended
 * @property {unknown} result - the job's result, from its `done` event
 * @property {number} startedAt
 * @property {number | null} finishedAt - set by the terminal event (or the stream's end), never by hydration
 */

function applyEvent(row, ev) {
  const next = {
    ...row,
    step: ev.step ?? row.step,
    percent: ev.percent != null ? ev.percent : row.percent,
    detail: ev.detail ?? ev.currentFile ?? row.detail,
  };
  if (ev.step === 'error') {
    next.status = 'error';
    next.error = new ApiError({ code: ev.error, detail: ev.detail });
    next.finishedAt = Date.now();
  } else if (ev.step === 'done') {
    next.status = 'done';
    next.result = ev.result;
    next.finishedAt = Date.now();
  } else if (ev.step) {
    next.events = { ...row.events, [ev.step]: ev };
  }
  return next;
}

export const useBackgroundJobsStore = create((set, get) => ({
  /** Loading the server's jobs (after a reload) failed: the tray may miss some. */
  hydrateFailed: false,

  /** Add the server's jobs (after a page load); `hydrateFailed` says whether that worked. */
  hydrate: async () => {
    try {
      const { jobs } = await listJobs();
      for (const j of jobs) {
        get().addJob({
          jobId: j.jobId, kind: j.kind, title: j.title, subject: j.subject, status: j.status, startedAt: j.createdAt,
        });
      }
      set({ hydrateFailed: false });
    } catch {
      set({ hydrateFailed: true });
    }
  },
  /** @type {Record<string, BackgroundJobRow>} */
  jobs: {},
  /** @type {Record<string, () => void>} */
  closeFns: {},
  /** @type {ReturnType<typeof setTimeout> | null} */
  pruneTimer: null,

  /**
   * Arm one timer for the earliest finished row's expiry; when it fires, drop
   * every expired row and re-arm for the next one, so rows that finished later
   * than the first still leave on time. Rows only finish later than the armed
   * one, so an armed timer is never late and a new finish needn't re-arm it.
   */
  schedulePrune: () => {
    const { pruneTimer, jobs } = get();
    if (pruneTimer) return;
    let earliest = Infinity;
    for (const row of Object.values(jobs)) {
      if (row.status === 'running') continue;
      earliest = Math.min(earliest, row.finishedAt ?? row.startedAt);
    }
    if (earliest === Infinity) return;
    const id = setTimeout(() => {
      const now = Date.now();
      const next = { ...get().jobs };
      for (const [jid, row] of Object.entries(next)) {
        if (row.status === 'running') continue;
        const t = row.finishedAt ?? row.startedAt;
        if (now - t >= DONE_UI_TTL_MS) delete next[jid];
      }
      set({ jobs: next, pruneTimer: null });
      get().schedulePrune();
    }, Math.max(0, earliest + DONE_UI_TTL_MS - Date.now()));
    set({ pruneTimer: id });
  },

  /**
   * Add a job's row and follow its progress stream, with what the caller knows
   * of it. Idempotent per jobId: a job already followed keeps its row.
   * Returns the jobId, for `awaitJob`.
   * @param {{ jobId: string, kind: string, title: string, subject?: JobSubject | null, status?: 'running' | 'done' | 'error', startedAt?: number }} job
   * @returns {string}
   */
  addJob: ({ jobId, kind, title, subject = null, status = 'running', startedAt }) => {
    if (!jobId || get().jobs[jobId]) return jobId;

    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: {
          jobId,
          kind,
          title,
          subject,
          step: null,
          percent: null,
          detail: null,
          events: {},
          status,
          error: null,
          result: null,
          startedAt: startedAt ?? Date.now(),
          finishedAt: null,
        },
      },
    }));

    const forgetStream = () => set((s) => {
      const { [jobId]: _c, ...rest } = s.closeFns;
      return { closeFns: rest };
    });

    const close = streamJobProgress(
      jobId,
      (ev) => {
        set((s) => {
          const cur = s.jobs[jobId];
          if (!cur) return s;
          return { jobs: { ...s.jobs, [jobId]: applyEvent(cur, ev) } };
        });

        if (ev.step === 'done' || ev.step === 'error') {
          close();
          forgetStream();
          get().schedulePrune();
        }
      },
      (reason) => {
        if (reason === 'not_found') {
          get().dismissJob(jobId);
          return;
        }
        set((s) => {
          const cur = s.jobs[jobId];
          if (!cur || cur.status !== 'running') return s;
          return {
            jobs: {
              ...s.jobs,
              [jobId]: {
                ...cur,
                status: 'error',
                error: new ApiError({ code: CLIENT_CODES.CONNECTION_LOST, detail: 'Connection lost' }),
                step: 'error',
                finishedAt: Date.now(),
              },
            },
          };
        });
        forgetStream();
        get().schedulePrune();
      },
    );

    set((s) => ({ closeFns: { ...s.closeFns, [jobId]: close } }));
    return jobId;
  },

  dismissJob: (jobId) => {
    const close = get().closeFns[jobId];
    if (close) close();
    set((s) => {
      const { [jobId]: _j, ...jobs } = s.jobs;
      const { [jobId]: _c, ...closeFns } = s.closeFns;
      return { jobs, closeFns };
    });
  },

  runningCount: () =>
    Object.values(get().jobs).filter((j) => j.status === 'running').length,
}));

/**
 * Wait for a job whose row was added (`addJob`): resolve with its result, or
 * reject with its error, an ApiError as `api()` throws (`code` is
 * CONNECTION_LOST or JOB_GONE when the stream, not the job, ended it, or the
 * row is not in the store). The job runs on the server whether or not anyone
 * waits for it.
 * @param {string} jobId
 * @returns {Promise<unknown>}
 */
export function awaitJob(jobId) {
  const store = useBackgroundJobsStore;
  return new Promise((resolve, reject) => {
    const settle = (row) => {
      if (!row) {
        // Never added, dismissed, or unknown to the server (it restarted, or the job expired).
        reject(new ApiError({ code: CLIENT_CODES.JOB_GONE, detail: 'The job is no longer followed' }));
        return true;
      }
      // A finished row hydrated after a reload settles once its replay brings the terminal event.
      if (row.finishedAt == null) return false;
      if (row.status === 'done') {
        resolve(row.result);
        return true;
      }
      if (row.status === 'error') {
        reject(row.error);
        return true;
      }
      return false;
    };
    if (settle(store.getState().jobs[jobId])) return;
    const unsubscribe = store.subscribe((state) => {
      if (settle(state.jobs[jobId])) unsubscribe();
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
