import { listBackgroundJobs } from '../lib/jobs/index.js';

export default async function backgroundJobsRoutes(fastify) {
  fastify.get('/background-jobs', {
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
}
