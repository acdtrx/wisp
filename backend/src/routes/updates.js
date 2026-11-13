import {
  getCachedStatus,
  checkForUpdate,
  downloadAndStage,
  applyUpdate,
  claimUpdateInstall,
} from '../lib/wispUpdate.js';
import {
  listBackgroundJobs, operationJobStore, BACKGROUND_JOB_KIND, titleForSelfUpdate,
} from '../lib/jobs/index.js';
import { handleRouteError } from '../lib/routeErrors.js';

function activeOtherJobs() {
  return listBackgroundJobs().filter((j) => !j.done);
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
    config: { auth: 'read' },
    schema: { response: { 200: STATUS_RESPONSE } },
    handler: async () => getCachedStatus(),
  });

  fastify.post('/updates/check', {
    config: { auth: 'admin' },
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
   * Synchronously download + verify + extract the new release tarball, then
   * trigger wisp-updater.service and return 202. The updater is a separate
   * systemd unit — it runs in its own cgroup, with its own stdio, and stops
   * this backend as its first real step. The UI polls GET /api/host
   * wispVersion to detect completion; updater steps are in journald
   * (`journalctl -u wisp-updater.service`).
   *
   * Pass ?force=1 to bypass the active-jobs guard (UI confirms first).
   */
  fastify.post('/updates/install', {
    config: { auth: 'admin' },
    schema: {
      querystring: {
        type: 'object',
        properties: { force: { type: 'string' } },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            title: { type: 'string' },
            targetVersion: { type: 'string' },
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
      const force = request.query?.force === '1' || request.query?.force === 'true';
      if (!force) {
        const others = activeOtherJobs();
        if (others.length > 0) {
          return reply.code(409).send({
            error: 'Other background jobs are active',
            detail: `${others.length} job(s) running — pass force=1 to override`,
          });
        }
      }

      // Claimed before the first await; `force` doesn't bypass it.
      const releaseInstall = claimUpdateInstall();
      if (!releaseInstall) {
        return reply.code(409).send({
          error: 'Update already in progress',
          detail: 'An install was already started — wait for Wisp to restart on the new version',
        });
      }

      /* A job: download, verify and extract, then hand off to the privileged
       * helper, which stops this backend as its first real step. The job's
       * progress (download percent, verify, extract) and its `done` — sent just
       * before the restart — arrive over its stream; the client then waits for
       * Wisp to come back on the new version. */
      const job = operationJobStore.startOperationJob({
        kind: BACKGROUND_JOB_KIND.SELF_UPDATE,
        title: titleForSelfUpdate(status.latest),
        log: request.log,
        run: async (report) => {
          try {
            const stagingPath = await downloadAndStage((p) => {
              const percent = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : undefined;
              report({ step: p.step, ...(percent != null ? { percent } : {}) });
            });
            report({ step: 'restarting' });
            await applyUpdate(stagingPath);
            return { targetVersion: status.latest };
          } catch (err) {
            releaseInstall();
            throw err;
          }
        },
      });
      return reply.code(202).send({ ...job, targetVersion: status.latest });
    },
  });
}
