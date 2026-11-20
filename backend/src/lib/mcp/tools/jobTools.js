/**
 * Job status — read scope. The mutating tools that start a job return its id;
 * this reads it from the one job store, like `GET /api/jobs`: running with its
 * latest progress, or its result or error. A finished job stays readable for
 * 5 minutes, like on the REST API.
 */
import { readJob } from '../../jobs/index.js';
import { createAppError } from '../../appErrors.js';

export const jobTools = [
  {
    name: 'get_job',
    title: 'Read a job',
    description:
      'Read a job by the jobId a tool returned. Returns its kind, title, subject (the VM or container it acts ' +
      'on, or null), createdAt and status: "running" with the latest progress, "done" with the result, or ' +
      '"error" with the error code (error) and its message (detail). Poll it until the status is no longer ' +
      '"running"; a finished job stays readable for 5 minutes.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'The jobId a tool returned' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    scope: 'read',
    handler: async ({ jobId }) => {
      if (typeof jobId !== 'string' || !jobId) throw createAppError('INVALID_REQUEST', 'jobId is required');
      const job = readJob(jobId);
      if (!job) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}"`, 'Unknown, or finished more than 5 minutes ago');
      }
      return job;
    },
  },
];
