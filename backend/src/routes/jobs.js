import { createAppError } from '../lib/appErrors.js';
import { hasJob, listJobs, registerJobStream, unregisterJobStream } from '../lib/jobs/index.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';

const SUBJECT = {
  type: ['object', 'null'],
  required: ['type', 'name'],
  properties: {
    type: { type: 'string', enum: ['vm', 'container'] },
    name: { type: 'string' },
  },
};

export default async function jobsRoutes(fastify) {
  fastify.get('/jobs', {
    config: { auth: 'read' },
    schema: {
      response: {
        200: {
          type: 'object',
          required: ['jobs'],
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                required: ['jobId', 'kind', 'title', 'subject', 'status', 'createdAt'],
                properties: {
                  jobId: { type: 'string' },
                  kind: { type: 'string' },
                  title: { type: 'string' },
                  subject: SUBJECT,
                  status: { type: 'string', enum: ['running', 'done', 'error'] },
                  createdAt: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    handler: async () => ({ jobs: listJobs() }),
  });

  // SSE: every job's progress and its terminal event (replayed to a late subscriber).
  fastify.get('/jobs/:jobId/progress', {
    config: { auth: 'read' },
    schema: { hide: true },
    handler: async (request, reply) => {
      const { jobId } = request.params;
      if (!hasJob(jobId)) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}": it never started, or ended more than 5 minutes ago`);
      }
      setupSSE(reply);
      registerJobStream(jobId, reply.raw);
      onSSEClose(reply, () => unregisterJobStream(jobId, reply.raw));
    },
  });
}
