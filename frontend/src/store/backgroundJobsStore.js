import { create } from 'zustand';
import { subscribeJobProgress } from '../api/jobProgress.js';

/** Match server job TTL after completion (~5m) — drop finished rows from UI */
const DONE_UI_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} BackgroundJobRow
 * @property {string} jobId
 * @property {string} kind
 * @property {string} title
 * @property {string | null} step
 * @property {number | null} percent
 * @property {string | null} detail
 * @property {'running' | 'done' | 'error'} status
 * @property {string | null} error
 * @property {number} startedAt
 * @property {number | null} [finishedAt]
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
    next.error = ev.error || ev.detail || 'Failed';
    next.finishedAt = Date.now();
  }
  if (ev.step === 'done') {
    next.status = 'done';
    next.finishedAt = Date.now();
  }
  return next;
}

export const useBackgroundJobsStore = create((set, get) => ({
  /** @type {Record<string, BackgroundJobRow>} */
  jobs: {},
  /** @type {Record<string, () => void>} */
  closeFns: {},
  /** @type {ReturnType<typeof setTimeout> | null} */
  pruneTimer: null,

  schedulePrune: () => {
    const state = get();
    if (state.pruneTimer) return;
    const id = setTimeout(() => {
      set({ pruneTimer: null });
      const now = Date.now();
      const jobs = { ...get().jobs };
      for (const [jid, row] of Object.entries(jobs)) {
        if (row.status === 'running') continue;
        const t = row.finishedAt ?? row.startedAt;
        if (now - t > DONE_UI_TTL_MS) delete jobs[jid];
      }
      set({ jobs });
    }, DONE_UI_TTL_MS + 1000);
    set({ pruneTimer: id });
  },

  /**
   * Start global SSE for this job if not already active. Idempotent per jobId.
   * @param {{ jobId: string, kind: string, title: string, onTerminal?: (ev: object) => void, startedAt?: number }} opts
   */
  registerJob: (opts) => {
    const { jobId, kind, title, onTerminal, startedAt } = opts;
    if (!jobId) return;

    const { closeFns } = get();
    if (closeFns[jobId]) return;

    set((s) => ({
      jobs: {
        ...s.jobs,
        [jobId]: {
          jobId,
          kind,
          title,
          step: null,
          percent: null,
          detail: null,
          status: 'running',
          error: null,
          startedAt: startedAt ?? Date.now(),
          finishedAt: null,
        },
      },
    }));

    const close = subscribeJobProgress(
      kind,
      jobId,
      (ev) => {
        set((s) => {
          const cur = s.jobs[jobId];
          if (!cur) return s;
          return { jobs: { ...s.jobs, [jobId]: applyEvent(cur, ev) } };
        });

        if (ev.step === 'done' || ev.step === 'error') {
          close();
          set((s) => {
            const { [jobId]: _c, ...rest } = s.closeFns;
            return { closeFns: rest };
          });
          onTerminal?.(ev);
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
          if (!cur) return s;
          if (cur.status !== 'running') return s;
          return {
            jobs: {
              ...s.jobs,
              [jobId]: {
                ...cur,
                status: 'error',
                error: 'Connection lost',
                step: 'error',
                finishedAt: Date.now(),
              },
            },
          };
        });
        set((s) => {
          const { [jobId]: _c, ...rest } = s.closeFns;
          return { closeFns: rest };
        });
        onTerminal?.({ step: 'error', error: 'Connection lost' });
        get().schedulePrune();
      },
    );

    set((s) => ({ closeFns: { ...s.closeFns, [jobId]: close } }));
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
