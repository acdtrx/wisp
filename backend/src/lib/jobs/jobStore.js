/**
 * The one in-memory job store and its starter (docs/specs/API.md, Background
 * jobs). Every job, whatever starts it, goes through `startJob`; nothing else
 * creates one.
 *
 * Replay history: every event goes live to the connected streams, but the
 * store keeps only what a late subscriber needs — consecutive events with the
 * same `step` are progress updates of that step, so each replaces the
 * previous one. A reconnecting stream gets one event per step transition (the
 * latest progress of each), not one per progress tick.
 *
 * Stream end: the terminal event (`done` / `error` / `cancelled`) is the last thing a
 * stream receives — the store ends every connected stream right after it, and
 * a stream registering on a finished job gets the replay and is ended without
 * joining the fan-out list. Keepalives are the SSE layer's (lib/sse.js).
 *
 * Expiry: a finished job stays fetchable for JOB_TTL_MS measured from its
 * end, then the sweep removes it.
 *
 * List changes: `subscribeJobsChange` handlers run when the list `listJobs`
 * answers changes — a job created, a job ended, finished jobs expired —
 * never on a progress event (progress stays on each job's stream).
 */
import { randomUUID } from 'node:crypto';

import { createAppError, errorBody, isExpectedAppError } from '../appErrors.js';
import { acquireVmOperationLock } from '../vmOperationLock.js';
import { acquireContainerOperationLock } from '../containerOperationLock.js';
import { JOB_KIND } from '../../../../shared/wireNames.js';
import { SUBJECT_KINDS } from './jobSubjectKinds.js';
import { createEmitter } from '../base/index.js';
import { log } from '../log.js';

const JOB_TTL_MS = 5 * 60 * 1000;
const KNOWN_KINDS = new Set(Object.values(JOB_KIND));

/**
 * @typedef {{ type: 'vm' | 'container', name: string }} JobSubject
 * @typedef {'running' | 'done' | 'error' | 'cancelled'} JobStatus
 * @typedef {{ jobId: string, kind: string, title: string, subject: JobSubject | null }} JobAck
 */

/** Insertion order is creation order: the listing reads it backwards. */
const jobs = new Map();

const jobsChange = createEmitter('Job list change', log);

/** Run `handler()` after every change of the job list (header). Returns its unsubscribe. */
export const subscribeJobsChange = jobsChange.subscribe;


function sameSubject(a, b) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.name === b.name;
}

/** A running job a shared start joins: same kind and subject, and a scope covering the start's (null covers every scope). */
function runningJobCovering(kind, subject, scope) {
  for (const [jobId, job] of jobs) {
    if (job.status === 'running' && job.kind === kind && sameSubject(job.subject, subject)
      && (job.scope === null || job.scope === scope)) return { jobId, job };
  }
  return null;
}

/** True while a job of `kind` (on `subject`, when given) runs. */
export function isJobRunning(kind, subject) {
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.kind === kind && (subject === undefined || sameSubject(job.subject, subject))) return true;
  }
  return false;
}

/** Set once shutdown begins: from then on the starter refuses every start. */
let refusingJobs = false;

/**
 * Shutdown has begun: every later start is refused with SHUTTING_DOWN, so a
 * request still reaching the listener or `/mcp` cannot start a job the exit
 * would cut. Running jobs are left as they are.
 */
export function refuseNewJobs() {
  refusingJobs = true;
}

function shuttingDownError() {
  return createAppError('SHUTTING_DOWN', 'Wisp is shutting down: start this again once it is back');
}

/** Running jobs that must finish: every running job but the interruptible ones. */
export function countJobsThatMustFinish() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running' && !job.abort) count += 1;
  }
  return count;
}

/**
 * Cut every running interruptible job (shutdown): its run's signal aborts,
 * and a run that then rejects ends the job `cancelled`. Settles once every
 * job cut has ended: its terminal event written to its streams, and those
 * ended.
 * @returns {Promise<number>} jobs cut
 */
export async function cancelInterruptibleJobs() {
  const ends = [];
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.abort && !job.abort.signal.aborted) {
      job.abort.abort();
      ends.push(job.ended.promise);
    }
  }
  await Promise.all(ends);
  return ends.length;
}

function ackOf(jobId, job) {
  return { jobId, kind: job.kind, title: job.title, subject: job.subject };
}

function writeEvent(stream, event) {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** End a job stream after its last event; the route's close teardown unregisters it. */
function endStream(stream) {
  try {
    stream.end();
  } catch {
    /* client already gone */
  }
}

function pushEvent(job, event) {
  const last = job.events[job.events.length - 1];
  if (last && last.step === event.step) {
    job.events[job.events.length - 1] = event;
  } else {
    job.events.push(event);
  }
  for (const stream of job.streams) {
    try {
      writeEvent(stream, event);
    } catch {
      /* client may have disconnected */
    }
  }
}

/** Mark the job ended, push its terminal event and end its streams. */
function finishJob(job, status, event) {
  job.status = status;
  job.finishedAt = Date.now();
  job.ended.resolve(status);
  pushEvent(job, event);
  const streams = job.streams;
  job.streams = [];
  for (const stream of streams) endStream(stream);
  scheduleSweep();
  jobsChange.emit();
}

/** Pending sweep; armed for the earliest finished job's expiry while any finished job remains. */
let sweepTimer = null;

/**
 * Remove every finished job whose TTL (from its end) has elapsed, then re-arm
 * for the next one. Invocable directly (manual / test trigger); the timer is
 * just one trigger.
 * @param {string} [trigger]
 * @returns {number} jobs removed
 */
export function sweepExpiredJobs(trigger = 'manual') {
  const now = Date.now();
  let lastRemoved = null;
  let removed = 0;
  for (const [jobId, job] of jobs) {
    if (job.status !== 'running' && now - job.finishedAt >= JOB_TTL_MS) {
      jobs.delete(jobId);
      removed += 1;
      lastRemoved = job;
      job.log.debug({ jobId, kind: job.kind, title: job.title, trigger }, 'Background job expired');
    }
  }
  scheduleSweep({ reschedule: true });
  if (lastRemoved) jobsChange.emit();
  return removed;
}

/**
 * Arm the sweep timer for the earliest finished job's expiry. A pending
 * timer already targets an expiry no later than a just-finished job's, and
 * the sweep re-arms after it runs, so a job's end only arms it when idle.
 */
function scheduleSweep({ reschedule = false } = {}) {
  if (sweepTimer) {
    if (!reschedule) return;
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
  let earliest = Infinity;
  for (const job of jobs.values()) {
    if (job.status !== 'running' && job.finishedAt < earliest) earliest = job.finishedAt;
  }
  if (earliest === Infinity) return;
  const delay = Math.max(0, earliest + JOB_TTL_MS - Date.now());
  // A sweeper never holds a process open: with nothing else running there is
  // no one left to read the expired jobs.
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweepExpiredJobs('ttl');
  }, delay);
  sweepTimer.unref();
}

function acquireSubjectLock(subject, label) {
  return subject.type === 'vm'
    ? acquireVmOperationLock(subject.name, label)
    : acquireContainerOperationLock(subject.name, label);
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** Throw on a malformed start, before the starter takes anything. */
function assertStartArgs({ kind, title, subject, scope, check, log, run }) {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`Unknown job kind "${kind}"`);
  const subjectKind = SUBJECT_KINDS[kind];
  if (subjectKind ? subject?.type !== subjectKind.type || !subject.name : subject) {
    throw new Error(`A "${kind}" job ${subjectKind ? `acts on a ${subjectKind.type}` : 'has no subject'}`);
  }
  if (typeof title !== 'string' || !title) throw new Error(`A "${kind}" job needs a title`);
  if (scope !== null && typeof scope !== 'string') throw new Error(`A "${kind}" job's scope is a string`);
  if (check !== undefined && typeof check !== 'function') throw new Error(`A "${kind}" job's check is a function`);
  if (typeof run !== 'function') throw new Error(`A "${kind}" job needs a run`);
  if (!LOG_LEVELS.every((level) => typeof log?.[level] === 'function')) throw new Error(`A "${kind}" job needs a logger`);
}

/**
 * Start a job and answer its ack `{ jobId, kind, title, subject }` — the only
 * way a job is created.
 *
 * Once shutdown has begun (`refuseNewJobs`), every start, a shared one
 * included, is refused with SHUTTING_DOWN: one whose async check was still
 * pending when it began too, once the check settles.
 *
 * The claim is decided in one synchronous step, so two starts in one tick
 * never both pass: a job with a subject claims its workload's operation lock
 * first (held: the busy error, `VM_BUSY` / `CONTAINER_BUSY`, and no job); a
 * job without one is claimed by its registration, right after its check.
 *
 * - `subject`: the workload a job of a subject kind acts on (SUBJECT_KINDS),
 *   absent for any other kind. The lock is taken under the kind's label and
 *   released when `run` settles, before the terminal event, so an action
 *   taken on `done` never meets a stale busy.
 * - `check()`: runs after the claim, before the job exists; what it throws is
 *   thrown to the caller (the lock released), never a failed job. Under a
 *   subject's lock it may be async; without a subject it must be synchronous,
 *   since nothing holds the claim across an await.
 * - `shared`: while a running job of this kind (and subject) covers the
 *   start, answer that job's ack and start nothing. `scope` narrows what a
 *   job covers: a job with no scope covers every start of its kind, one with
 *   a scope only the starts of that scope.
 * - `interruptible`: the job need not finish — `cancelInterruptibleJobs`
 *   (shutdown) aborts its run's `signal`, and a run that then rejects ends
 *   it `cancelled`. Other jobs must finish and get no signal.
 * - `run(report, signal)`: `report(event)` pushes a progress event; the
 *   resolved value is the job's `result` (`{ step: 'done', result }`) and
 *   must hold only what a client may see — no host paths. A rejection fails
 *   the job with its error body.
 *
 * @param {object} opts
 * @param {string} opts.kind - a JOB_KIND value
 * @param {string} opts.title
 * @param {JobSubject} [opts.subject]
 * @param {boolean} [opts.shared]
 * @param {string | null} [opts.scope]
 * @param {boolean} [opts.interruptible]
 * @param {() => Promise<void> | void} [opts.check]
 * @param {import('fastify').FastifyBaseLogger} opts.log
 * @param {(report: (event: object) => void, signal?: AbortSignal) => Promise<unknown>} opts.run
 * @returns {Promise<JobAck>}
 */
export async function startJob({
  kind, title, subject = null, shared = false, scope = null, interruptible = false, check, log, run,
}) {
  assertStartArgs({ kind, title, subject, scope, check, log, run });
  if (refusingJobs) throw shuttingDownError();

  if (shared) {
    const running = runningJobCovering(kind, subject, scope);
    if (running) return ackOf(running.jobId, running.job);
  }

  const release = subject ? acquireSubjectLock(subject, SUBJECT_KINDS[kind].lock) : () => {};
  if (check) {
    try {
      // Awaited only when pending: an await of nothing would still yield, and
      // open the gap between a subjectless job's check and its registration.
      const pending = check();
      if (pending) {
        if (!subject) {
          Promise.resolve(pending).catch(() => { /* refused below: its outcome has no reader */ });
          throw new Error(`A "${kind}" job without a subject needs a synchronous check`);
        }
        await pending;
        // Shutdown may have begun during the await, after the interruptible
        // jobs were cut: a job registered now would be killed by the exit.
        if (refusingJobs) throw shuttingDownError();
      }
    } catch (err) {
      release();
      throw err;
    }
  }

  const jobId = randomUUID();
  const job = {
    kind,
    title,
    subject: subject ? { type: subject.type, name: subject.name } : null,
    scope,
    status: /** @type {JobStatus} */ ('running'),
    events: [],
    streams: [],
    createdAt: Date.now(),
    finishedAt: null,
    abort: interruptible ? new AbortController() : null,
    ended: Promise.withResolvers(),
    log,
  };
  jobs.set(jobId, job);
  const logFields = { jobId, kind, title, subject: job.subject };
  log.info(logFields, 'Background job started');

  const report = (event) => {
    if (job.status === 'running') pushEvent(job, event);
  };
  Promise.resolve()
    .then(() => run(report, job.abort?.signal))
    .then(
      (result) => {
        release();
        log.info(logFields, 'Background job completed');
        finishJob(job, 'done', { step: 'done', result: result ?? null });
      },
      (err) => {
        release();
        if (job.abort?.signal.aborted) {
          log.info(logFields, 'Background job cancelled');
          finishJob(job, 'cancelled', { step: 'cancelled' });
          return;
        }
        const body = errorBody(err);
        if (isExpectedAppError(err)) {
          log.warn({ ...logFields, code: body.error, err: err.message, raw: err.raw }, 'Background job failed');
        } else {
          log.error({ ...logFields, code: body.error, err }, 'Background job failed');
        }
        finishJob(job, 'error', { step: 'error', ...body });
      },
    );
  jobsChange.emit();
  return ackOf(jobId, job);
}

/**
 * Every job still kept, newest first.
 * @returns {Array<{ jobId: string, kind: string, title: string, subject: JobSubject | null, status: JobStatus, createdAt: number }>}
 */
export function listJobs() {
  return [...jobs].reverse().map(([jobId, job]) => ({
    jobId,
    kind: job.kind,
    title: job.title,
    subject: job.subject,
    status: job.status,
    createdAt: job.createdAt,
  }));
}

/**
 * One job as MCP's `get_job` answers it: its row, plus the latest progress
 * event while it runs, its `result` once done, or its `error` and `detail`
 * once failed; a cancelled job is its row alone. Null for an unknown or
 * expired job.
 */
export function readJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const row = {
    jobId, kind: job.kind, title: job.title, subject: job.subject, status: job.status, createdAt: job.createdAt,
  };
  const last = job.events[job.events.length - 1] ?? null;
  if (job.status === 'running') return { ...row, progress: last };
  if (job.status === 'done') return { ...row, result: last.result };
  if (job.status === 'cancelled') return row;
  return { ...row, error: last.error, detail: last.detail };
}

/**
 * Settles with the job's end status (`done`, `error`, `cancelled`) once it
 * has ended, at once for an ended job; with null for an unknown or expired
 * job. For a caller that runs jobs one after another (the backup scheduler).
 * @returns {Promise<JobStatus | null>}
 */
export function whenJobEnds(jobId) {
  const job = jobs.get(jobId);
  return job ? job.ended.promise : Promise.resolve(null);
}

export function hasJob(jobId) {
  return jobs.has(jobId);
}

/**
 * Replay the job's history to `stream`. A running job adds it to the live
 * fan-out; a finished job's replay ends with the terminal event, so the
 * stream is ended instead of registered. An unknown job ends the stream.
 */
export function registerJobStream(jobId, stream) {
  const job = jobs.get(jobId);
  if (!job) {
    endStream(stream);
    return;
  }
  for (const event of job.events) {
    try {
      writeEvent(stream, event);
    } catch {
      /* broken stream — never joins the fan-out list */
      return;
    }
  }
  if (job.status !== 'running') {
    endStream(stream);
    return;
  }
  job.streams.push(stream);
}

export function unregisterJobStream(jobId, stream) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.streams = job.streams.filter((s) => s !== stream);
}
