import { createAppError } from '../lib/appErrors.js';
import { hasJob, listJobs, registerJobStream, unregisterJobStream } from '../lib/jobs/index.js';
import { onSSEClose, setupSSE } from '../lib/sse.js';
import { jobSubjectSchema } from './schemas.js';

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
                  subject: jobSubjectSchema,
                  status: { type: 'string', enum: ['running', 'done', 'error', 'cancelled'] },
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
    config: { auth: 'read', answers: 'sse' },
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: { jobId: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
    },
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
