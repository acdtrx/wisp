/**
 * @typedef {object} BackgroundJobMeta
 * @property {string} kind
 * @property {string} title
 * @property {import('fastify').FastifyBaseLogger} [log]
 */

/**
 * Generic in-memory store for jobs with SSE progress. Progress is pushed to registered streams.
 * @param {(result: unknown) => object} formatResult - Called on completeJob(result); return value is sent as { step: 'done', ...payload }
 * @returns Store with getJob, createJob, pushEvent, completeJob, failJob, registerStream, unregisterStream, listJobs
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
    job.events.push(event);
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
    job.result = result;
    if (job.log) {
      job.log.info(
        { jobId, kind: job.kind, title: job.title },
        'Background job completed',
      );
    }
    pushEvent(jobId, { step: 'done', ...formatResult(result) });
    job.streams = [];
    scheduleExpire(jobId);
  }

  function failJob(jobId, err) {
    const job = jobs.get(jobId);
    if (!job) return;
    clearKeepalive(jobId);
    job.done = true;
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
    scheduleExpire(jobId);
  }

  let expireTimer = null;
  function scheduleExpire(jobId) {
    if (expireTimer) return;
    expireTimer = setTimeout(() => {
      expireTimer = null;
      for (const [id, job] of jobs.entries()) {
        if (job.done && Date.now() - job.createdAt > JOB_TTL_MS) {
          jobs.delete(id);
        }
      }
    }, JOB_TTL_MS);
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
  };
}
