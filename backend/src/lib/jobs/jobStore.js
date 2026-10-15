/**
 * @typedef {object} BackgroundJobMeta
 * @property {string} kind
 * @property {string} title
 * @property {import('fastify').FastifyBaseLogger} [log]
 */

/**
 * Generic in-memory store for jobs with SSE progress. Progress is pushed to registered streams.
 *
 * Replay history: every event goes live to the connected streams, but the
 * store keeps only what a late subscriber needs — consecutive events with the
 * same `step` are progress updates of that step, so each replaces the
 * previous one. A reconnecting stream gets one event per step transition (the
 * latest progress of each), not one per progress tick.
 *
 * Expiry: a finished job stays fetchable for JOB_TTL_MS measured from its
 * completion (`finishedAt`), then the sweep removes it.
 *
 * @param {(result: unknown) => object} formatResult - Called on completeJob(result); return value is sent as { step: 'done', ...payload }
 * @returns Store with getJob, createJob, pushEvent, completeJob, failJob, registerStream, unregisterStream, listJobs, sweepExpired
 */
export function createJobStore(formatResult) {
  const jobs = new Map();
  /** @type {Map<string, ReturnType<typeof setInterval>>} */
  const keepaliveByJob = new Map();
  const JOB_TTL_MS = 5 * 60 * 1000;
  const KEEPALIVE_MS = 20000;

  function clearKeepalive(jobId) {
    const id = keepaliveByJob.get(jobId);
    if (id) {
      clearInterval(id);
      keepaliveByJob.delete(jobId);
    }
  }

  /** SSE comment lines keep proxies from treating idle streams as stalled (undici bodyTimeout). */
  function startKeepaliveIfNeeded(jobId) {
    if (keepaliveByJob.has(jobId)) return;
    const job = jobs.get(jobId);
    if (!job || job.done || job.streams.length === 0) return;
    const id = setInterval(() => {
      const j = jobs.get(jobId);
      if (!j || j.done || j.streams.length === 0) {
        clearKeepalive(jobId);
        return;
      }
      for (const stream of j.streams) {
        try {
          stream.write(': keepalive\n\n');
        } catch {
          /* client disconnected */
        }
      }
    }, KEEPALIVE_MS);
    keepaliveByJob.set(jobId, id);
  }

  function getJob(jobId) {
    return jobs.get(jobId);
  }

  /**
   * @param {string} jobId
   * @param {BackgroundJobMeta} [meta]
   */
  function createJob(jobId, meta = {}) {
    const job = {
      events: [],
      streams: [],
      done: false,
      result: null,
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      kind: meta.kind ?? null,
      title: meta.title ?? '',
      log: meta.log ?? null,
    };
    jobs.set(jobId, job);
    return job;
  }

  function listJobs() {
    const out = [];
    for (const [jobId, job] of jobs.entries()) {
      out.push({
        jobId,
        kind: job.kind ?? '',
        title: job.title ?? '',
        done: job.done,
        createdAt: job.createdAt,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  function pushEvent(jobId, event) {
    const job = jobs.get(jobId);
    if (!job) return;
    const last = job.events[job.events.length - 1];
    if (last && last.step === event.step) {
      job.events[job.events.length - 1] = event;
    } else {
      job.events.push(event);
    }
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of job.streams) {
      try {
        stream.write(payload);
      } catch (err) {
        /* client may have disconnected */
      }
    }
  }

  function completeJob(jobId, result) {
    const job = jobs.get(jobId);
    if (!job) return;
    clearKeepalive(jobId);
    job.done = true;
    job.finishedAt = Date.now();
    job.result = result;
    if (job.log) {
      job.log.info(
        { jobId, kind: job.kind, title: job.title },
        'Background job completed',
      );
    }
    pushEvent(jobId, { step: 'done', ...formatResult(result) });
    job.streams = [];
    scheduleSweep();
  }

  function failJob(jobId, err) {
    const job = jobs.get(jobId);
    if (!job) return;
    clearKeepalive(jobId);
    job.done = true;
    job.finishedAt = Date.now();
    job.error = err;
    const errMessage =
      err && typeof err === 'object' && 'message' in err ? err.message : String(err);
    const errRaw = err && typeof err === 'object' && 'raw' in err ? err.raw : errMessage;
    if (job.log) {
      job.log.warn(
        { jobId, kind: job.kind, title: job.title, err: errMessage },
        'Background job failed',
      );
    }
    pushEvent(jobId, {
      step: 'error',
      error: errMessage,
      detail: errRaw || errMessage,
    });
    job.streams = [];
    scheduleSweep();
  }

  /** Pending sweep; armed for the earliest finished job's expiry while any finished job remains. */
  let sweepTimer = null;

  /**
   * Remove every finished job whose TTL (from completion) has elapsed, then
   * re-arm for the next one. Invocable directly (manual / test trigger); the
   * timer is just one trigger.
   * @param {string} [trigger]
   * @returns {number} jobs removed
   */
  function sweepExpired(trigger = 'manual') {
    const now = Date.now();
    let removed = 0;
    for (const [id, job] of jobs.entries()) {
      if (job.done && now - job.finishedAt >= JOB_TTL_MS) {
        jobs.delete(id);
        removed += 1;
        job.log?.debug({ jobId: id, kind: job.kind, title: job.title, trigger }, 'Background job expired');
      }
    }
    scheduleSweep({ reschedule: true });
    return removed;
  }

  /**
   * Arm the sweep timer for the earliest finished job's expiry. A pending
   * timer already targets an expiry no later than a just-finished job's, and
   * the sweep re-arms after it runs, so completion only arms when idle.
   */
  function scheduleSweep({ reschedule = false } = {}) {
    if (sweepTimer) {
      if (!reschedule) return;
      clearTimeout(sweepTimer);
      sweepTimer = null;
    }
    let earliest = Infinity;
    for (const job of jobs.values()) {
      if (job.done && job.finishedAt < earliest) earliest = job.finishedAt;
    }
    if (earliest === Infinity) return;
    const delay = Math.max(0, earliest + JOB_TTL_MS - Date.now());
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      sweepExpired('ttl');
    }, delay);
  }

  function registerStream(jobId, stream) {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.streams.push(stream);
    if (!job.done) startKeepaliveIfNeeded(jobId);
    for (const event of job.events) {
      try {
        stream.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        /* broken stream — drop from fan-out list */
        job.streams = job.streams.filter(s => s !== stream);
        return true;
      }
    }
    return true;
  }

  function unregisterStream(jobId, stream) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.streams = job.streams.filter(s => s !== stream);
    if (job.streams.length === 0) clearKeepalive(jobId);
  }

  return {
    getJob,
    createJob,
    listJobs,
    pushEvent,
    completeJob,
    failJob,
    registerStream,
    unregisterStream,
    sweepExpired,
  };
}
