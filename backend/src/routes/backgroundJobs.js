import { createAppError } from '../lib/appErrors.js';
import { listBackgroundJobs, operationJobStore } from '../lib/jobs/index.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';

export default async function backgroundJobsRoutes(fastify) {
  fastify.get('/background-jobs', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                required: ['jobId', 'kind', 'title', 'done', 'createdAt'],
                properties: {
                  jobId: { type: 'string' },
                  kind: { type: 'string' },
                  title: { type: 'string' },
                  done: { type: 'boolean' },
                  createdAt: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    handler: async () => {
      return { jobs: listBackgroundJobs() };
    },
  });

  // SSE: an operation job's progress and result (replayed to a late subscriber).
  fastify.get('/jobs/:jobId/progress', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      if (!operationJobStore.getJob(jobId)) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}": it never started, or ended more than 5 minutes ago`);
      }
      setupSSE(reply);
      if (!operationJobStore.registerStream(jobId, reply.raw)) {
        reply.raw.end();
        return;
      }
      onSSEClose(reply, () => operationJobStore.unregisterStream(jobId, reply.raw));
    },
  });
}
