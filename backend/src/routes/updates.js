import { randomBytes } from 'node:crypto';
import {
  getCachedStatus,
  checkForUpdate,
  downloadAndStage,
  applyUpdate,
} from '../lib/wispUpdate.js';
import { wispUpdateJobStore } from '../lib/wispUpdateJobStore.js';
import { listBackgroundJobs } from '../lib/listBackgroundJobs.js';
import { BACKGROUND_JOB_KIND } from '../lib/backgroundJobKinds.js';
import { setupSSE } from '../lib/sse.js';
import { handleRouteError } from '../lib/routeErrors.js';

function activeWispUpdateJobId() {
  for (const j of wispUpdateJobStore.listJobs()) {
    if (!j.done) return j.jobId;
  }
  return null;
}

function activeNonUpdateJobs() {
  return listBackgroundJobs().filter((j) => !j.done && j.kind !== BACKGROUND_JOB_KIND.WISP_UPDATE);
}

const STATUS_RESPONSE = {
  type: 'object',
  properties: {
    current: { type: 'string' },
    latest: { type: ['string', 'null'] },
    available: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
    publishedAt: { type: ['string', 'null'] },
    lastChecked: { type: ['string', 'null'] },
    lastError: { type: ['string', 'null'] },
    repo: { type: 'string' },
  },
};

export default async function updatesRoutes(fastify) {
  fastify.get('/updates/status', {
    schema: { response: { 200: STATUS_RESPONSE } },
    handler: async () => getCachedStatus(),
  });

  fastify.post('/updates/check', {
    schema: { response: { 200: STATUS_RESPONSE } },
    handler: async (request, reply) => {
      try {
        return await checkForUpdate();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  /**
   * Start the install pipeline. Soft-guards against concurrent install jobs
   * and against running while other background work is active; pass ?force=1
   * to override the active-jobs guard (UI shows a confirm dialog first).
   */
  fastify.post('/updates/install', {
    schema: {
      querystring: {
        type: 'object',
        properties: { force: { type: 'string' } },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const status = getCachedStatus();
      if (!status.available) {
        return reply.code(409).send({
          error: 'No update available',
          detail: status.latest ? `Already on ${status.current}` : 'Run check first',
        });
      }
      const existing = activeWispUpdateJobId();
      if (existing) {
        return reply.code(409).send({
          error: 'Update already in progress',
          detail: `Job ${existing} is still running`,
        });
      }
      const force = request.query?.force === '1' || request.query?.force === 'true';
      if (!force) {
        const others = activeNonUpdateJobs();
        if (others.length > 0) {
          return reply.code(409).send({
            error: 'Other background jobs are active',
            detail: `${others.length} job(s) running — pass force=1 to override`,
          });
        }
      }

      const jobId = randomBytes(12).toString('hex');
      const title = `Update to v${status.latest}`;
      wispUpdateJobStore.createJob(jobId, {
        kind: BACKGROUND_JOB_KIND.WISP_UPDATE,
        title,
        log: request.log,
      });
      request.log.info(
        { jobId, kind: BACKGROUND_JOB_KIND.WISP_UPDATE, title },
        'Background job started',
      );

      (async () => {
        try {
          wispUpdateJobStore.pushEvent(jobId, { step: 'start', from: status.current, to: status.latest });
          const stagingPath = await downloadAndStage((p) => {
            wispUpdateJobStore.pushEvent(jobId, p);
          });
          wispUpdateJobStore.pushEvent(jobId, { step: 'apply', stagingPath });
          await applyUpdate(stagingPath, (p) => {
            wispUpdateJobStore.pushEvent(jobId, p);
          });
          /* The helper restarts the backend at the end; this completion event
           * may or may not reach the client before our process is killed. Either
           * way the client reconnects to the new backend and notices the version
           * has changed. */
          wispUpdateJobStore.completeJob(jobId, { version: status.latest });
        } catch (err) {
          request.log.error({ err: err.message, jobId }, 'Wisp update job failed');
          try {
            wispUpdateJobStore.failJob(jobId, err);
          } catch (failErr) {
            request.log.error({ err: failErr.message, jobId }, 'failJob failed');
          }
        }
      })();

      return reply.code(201).send({ jobId, title });
    },
  });

  /* SSE: progress for a specific install job */
  fastify.get('/updates/progress/:jobId', {
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      const job = wispUpdateJobStore.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: 'Job not found', detail: jobId });
      }
      setupSSE(reply);
      const ok = wispUpdateJobStore.registerStream(jobId, reply.raw);
      if (!ok) {
        reply.raw.end();
        return;
      }
      request.raw.on('close', () => {
        wispUpdateJobStore.unregisterStream(jobId, reply.raw);
      });
    },
  });
}
