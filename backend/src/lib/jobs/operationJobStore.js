/**
 * In-memory store for operation jobs: the commands that can outlast a short
 * request (a VM start or delete, an OS upgrade, a self-update install, …). The
 * POST starts the job and answers with its id; progress and the result arrive
 * over SSE (GET /api/jobs/:jobId/progress). The client may go away: the job
 * runs to completion regardless (FRONTEND-RULES, Data: the client is an
 * observer).
 *
 * The result object is sent as the `done` event's payload; it must hold only
 * what the client may see.
 */
import { randomUUID } from 'node:crypto';

import { createJobStore as createJobStoreFactory } from './jobStore.js';

const store = createJobStoreFactory((result) => (result && typeof result === 'object' ? result : {}));

export const getJob = store.getJob;
export const listJobs = store.listJobs;
export const registerStream = store.registerStream;
export const unregisterStream = store.unregisterStream;

/**
 * Start `run` as a job and return `{ jobId, title }` at once. `run(report)` may
 * call `report({ step, percent?, detail? })` for progress; its resolved value is
 * the `done` payload, its rejection the `error` event.
 * @param {{ kind: string, title: string, log?: import('fastify').FastifyBaseLogger, run: (report: (ev: object) => void) => Promise<object | void> }} opts
 */
export function startOperationJob({ kind, title, log, run }) {
  const jobId = randomUUID();
  store.createJob(jobId, { kind, title, log });
  log?.info({ jobId, kind, title }, 'Background job started');
  Promise.resolve()
    .then(() => run((ev) => store.pushEvent(jobId, ev)))
    .then((result) => store.completeJob(jobId, result ?? {}), (err) => store.failJob(jobId, err));
  return { jobId, title };
}

/** The running job of `kind` with `title`, if any — for operations that share one run. */
export function findRunningJob(kind, title) {
  return store.listJobs().find((j) => j.kind === kind && j.title === title && !j.done) ?? null;
}
