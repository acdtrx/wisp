import { create } from 'zustand';
import { subscribeJobProgress } from '../api/jobProgress.js';

/** Same TTL as the server's job store, measured the same way: from completion.
 *  A finished row leaves the tray once it has been finished this long. */
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
