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
 * Stream end: the terminal event (`done` / `error`) is the last thing a
 * stream receives — the store ends every connected stream right after it, and
 * a stream registering on a finished job gets the replay and is ended without
 * joining the fan-out list. Keepalives are the SSE layer's (lib/sse.js).
 *
 * Expiry: a finished job stays fetchable for JOB_TTL_MS measured from its
 * end, then the sweep removes it.
 */
import { randomUUID } from 'node:crypto';

import { errorBody, isExpectedAppError } from '../appErrors.js';
import { acquireVmOperationLock } from '../vmOperationLock.js';
import { acquireContainerOperationLock } from '../containerOperationLock.js';
import { BACKGROUND_JOB_KIND, SUBJECT_KINDS } from './backgroundJobKinds.js';

const JOB_TTL_MS = 5 * 60 * 1000;
const KNOWN_KINDS = new Set(Object.values(BACKGROUND_JOB_KIND));

/**
 * @typedef {{ type: 'vm' | 'container', name: string }} JobSubject
 * @typedef {'running' | 'done' | 'error'} JobStatus
 */

/** Insertion order is creation order: the listing reads it backwards. */
const jobs = new Map();

function sameSubject(a, b) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.name === b.name;
}

function runningJobOf(kind, subject) {
  for (const [jobId, job] of jobs) {
    if (job.status === 'running' && job.kind === kind && sameSubject(job.subject, subject)) return { jobId, job };
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
  pushEvent(job, event);
  const streams = job.streams;
  job.streams = [];
  for (const stream of streams) endStream(stream);
  scheduleSweep();
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
  let removed = 0;
  for (const [jobId, job] of jobs) {
    if (job.status !== 'running' && now - job.finishedAt >= JOB_TTL_MS) {
      jobs.delete(jobId);
      removed += 1;
      job.log.debug({ jobId, kind: job.kind, title: job.title, trigger }, 'Background job expired');
    }
  }
  scheduleSweep({ reschedule: true });
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

/**
 * Start a job and answer its `{ jobId, title }` — the only way a job is created.
 *
 * - `subject`: the workload a job of a subject kind acts on (SUBJECT_KINDS),
 *   absent for any other kind. Its operation lock is taken first, under the
 *   kind's label: held, the busy error (`VM_BUSY` / `CONTAINER_BUSY`) is thrown
 *   and no job is created. The lock is released when `run` settles, before the
 *   terminal event, so an action taken on `done` never meets a stale busy.
 * - `check()`: runs under the lock before the job exists; what it throws is
 *   thrown to the caller (the lock released), never a failed job.
 * - `shared`: while a job of this kind (and subject) runs, answer its ack and
 *   start nothing.
 * - `run(report)`: `report(event)` pushes a progress event; the resolved value
 *   is the job's `result` (`{ step: 'done', result }`) and must hold only what
 *   a client may see — no host paths. A rejection fails the job with its error
 *   body.
 *
 * @param {object} opts
 * @param {string} opts.kind - a BACKGROUND_JOB_KIND value
 * @param {string} opts.title
 * @param {JobSubject} [opts.subject]
 * @param {boolean} [opts.shared]
 * @param {() => Promise<void> | void} [opts.check]
 * @param {import('fastify').FastifyBaseLogger} opts.log
 * @param {(report: (event: object) => void) => Promise<unknown>} opts.run
 * @returns {Promise<{ jobId: string, title: string }>}
 */
export async function startJob({ kind, title, subject = null, shared = false, check, log, run }) {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`Unknown job kind "${kind}"`);
  const subjectKind = SUBJECT_KINDS[kind];
  if (subjectKind ? subject?.type !== subjectKind.type || !subject.name : subject) {
    throw new Error(`A "${kind}" job ${subjectKind ? `acts on a ${subjectKind.type}` : 'has no subject'}`);
  }

  const joinRunning = () => {
    const running = shared ? runningJobOf(kind, subject) : null;
    return running ? { jobId: running.jobId, title: running.job.title } : null;
  };
  const joined = joinRunning();
  if (joined) return joined;

  const release = subject ? acquireSubjectLock(subject, subjectKind.lock) : () => {};
  try {
    await check?.();
  } catch (err) {
    release();
    throw err;
  }
  // Another start of a shared kind may have created its job while `check` ran.
  const overtaken = joinRunning();
  if (overtaken) {
    release();
    return overtaken;
  }

  const jobId = randomUUID();
  const job = {
    kind,
    title,
    subject: subject ? { type: subject.type, name: subject.name } : null,
    status: /** @type {JobStatus} */ ('running'),
    events: [],
    streams: [],
    createdAt: Date.now(),
    finishedAt: null,
    log,
  };
  jobs.set(jobId, job);
  const logFields = { jobId, kind, title, subject: job.subject };
  log.info(logFields, 'Background job started');

  const report = (event) => {
    if (job.status === 'running') pushEvent(job, event);
  };
  Promise.resolve()
    .then(() => run(report))
    .then(
      (result) => {
        release();
        log.info(logFields, 'Background job completed');
        finishJob(job, 'done', { step: 'done', result: result ?? null });
      },
      (err) => {
        release();
        const body = errorBody(err);
        if (isExpectedAppError(err)) {
          log.warn({ ...logFields, code: body.error, err: err.message, raw: err.raw }, 'Background job failed');
        } else {
          log.error({ ...logFields, code: body.error, err }, 'Background job failed');
        }
        finishJob(job, 'error', { step: 'error', ...body });
      },
    );
  return { jobId, title };
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
 * event while it runs, its `result` once done, or its `error` and `detail`.
 * Null for an unknown or expired job.
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
  return { ...row, error: last.error, detail: last.detail };
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
