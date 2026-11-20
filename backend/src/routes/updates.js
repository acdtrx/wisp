import {
  getCachedStatus,
  checkForUpdate,
  downloadAndStage,
  applyUpdate,
  claimUpdateInstall,
} from '../lib/wispUpdate.js';
import {
  countJobsThatMustFinish, startJob, BACKGROUND_JOB_KIND, titleForSelfUpdate,
} from '../lib/jobs/index.js';
import { createAppError } from '../lib/appErrors.js';
import { jobAckSchema } from './schemas.js';

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

  // Answers 204; the new status follows on the `wisp-update` cue. A failed
  // check answers its error (503) and is announced too: it records lastError.
  fastify.post('/updates/check', {
    config: { auth: 'admin' },
    schema: { response: { 204: { type: 'null' } } },
    handler: async (request, reply) => {
      await checkForUpdate();
      return reply.code(204).send();
    },
  });

  /**
   * Check the install can start (an update available, no install in flight,
   * no other job that must finish unless forced), claim it and answer 202
   * with a job. The job downloads, verifies and extracts the release, then triggers
   * wisp-updater.service. The updater is a separate systemd unit — it runs in
   * its own cgroup, with its own stdio, and stops this backend as its first
   * real step. The UI polls GET /api/host wispVersion to detect completion;
   * updater steps are in journald (`journalctl -u wisp-updater.service`).
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
        202: jobAckSchema,
      },
    },
    handler: async (request, reply) => {
      const status = getCachedStatus();
      if (!status.available) {
        throw createAppError(
          'UPDATE_NOT_AVAILABLE',
          status.latest ? `No update available: already on ${status.current}` : 'No update available: run a check first',
        );
      }
      const force = request.query?.force === '1' || request.query?.force === 'true';
      let releaseInstall;

      /* A job: download, verify and extract, then hand off to the privileged
       * helper, which stops this backend as its first real step. The job's
       * progress (download percent, verify, extract) and its `done` — sent just
       * before the restart — arrive over its stream; the client then waits for
       * Wisp to come back on the new version. */
      const job = await startJob({
        kind: BACKGROUND_JOB_KIND.SELF_UPDATE,
        title: titleForSelfUpdate(status.latest),
        // Claimed and counted in the starter's synchronous step; `force`
        // skips the count, never the claim. Interruptible jobs (the update
        // checks) are not counted: the restart cuts them.
        check: () => {
          releaseInstall = claimUpdateInstall();
          if (!releaseInstall) {
            throw createAppError(
              'UPDATE_INSTALL_IN_PROGRESS',
              'An update install is already in progress: wait for Wisp to restart on the new version',
            );
          }
          const running = countJobsThatMustFinish();
          if (!force && running > 0) {
            releaseInstall();
            throw createAppError(
              'UPDATE_JOBS_ACTIVE',
              `${running} other background job(s) are running: pass force=1 to install anyway`,
            );
          }
        },
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
      return reply.code(202).send(job);
    },
  });
}
