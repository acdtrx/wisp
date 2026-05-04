import {
  getCachedStatus,
  checkForUpdate,
  downloadAndStage,
  applyUpdate,
} from '../lib/wispUpdate.js';
import { listBackgroundJobs } from '../lib/jobs/index.js';
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
    schema: {
      querystring: {
        type: 'object',
        properties: { force: { type: 'string' } },
      },
      response: {
        202: {
          type: 'object',
          properties: {
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

      let stagingPath;
      try {
        /* Phase 1: download + verify + extract — blocks here for ~5–15s.
         * Errors are reported as HTTP errors before we hand off to the helper. */
        stagingPath = await downloadAndStage();
      } catch (err) {
        return handleRouteError(err, reply, request);
      }

      try {
        /* Phase 2: fire-and-forget the privileged helper. applyUpdate spawns
         * detached + ignores stdio and returns immediately. The helper kills
         * this backend as its first real step. */
        await applyUpdate(stagingPath);
      } catch (err) {
        return handleRouteError(err, reply, request);
      }

      return reply.code(202).send({ targetVersion: status.latest });
    },
  });
}
