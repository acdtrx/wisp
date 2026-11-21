import { useEffect, useRef } from 'react';

import { runningJobs, useBackgroundJobsStore } from '../store/backgroundJobsStore.js';

/**
 * The id of a running job that `match` picks (its kind, its subject), or null: a job
 * started elsewhere — another tab, the scheduler, this view before it was left.
 * @param {(job: import('../store/backgroundJobsStore.js').BackgroundJobRow) => boolean} match
 */
export function useRunningJob(match) {
  return useBackgroundJobsStore((s) => runningJobs(s.jobs).find(match)?.jobId ?? null);
}

/**
 * Follow a job already running as the view's own command (`command`, a `useCommand`):
 * the one way a view takes up a job it did not start, to its end — its busy state, its
 * progress (`onAck` gets the id), its result (`onDone`) or its error, as if the view had
 * started it. Each job is taken up once.
 *
 * @param {ReturnType<import('./useCommand.js').useCommand>} command
 * @param {string | null} jobId
 * @param {{ key?: unknown, rereads?: Array<[string, unknown?]>, onAck?: Function, onDone?: Function }} options
 */
export function useFollowJob(command, jobId, options) {
  const followed = useRef(null);
  const latest = useRef(options);
  latest.current = options;
  const { run } = command;
  useEffect(() => {
    if (!jobId || followed.current === jobId) return;
    followed.current = jobId;
    run(async () => ({ jobId }), { ...latest.current, job: true });
  }, [jobId, run]);
}
