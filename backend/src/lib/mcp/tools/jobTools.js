/**
 * Job status — read scope. The mutating tools that start a job return its id;
 * this reads the job: running with its latest progress, or its result or
 * error. A finished job stays readable for 5 minutes, like on the REST API.
 */
import { operationJobStore } from '../../jobs/index.js';
import { createAppError } from '../../routeErrors.js';

export const jobTools = [
  {
    name: 'get_job',
    title: 'Read a job',
    description:
      'Read a job a tool started (deploy_container, update_container_image, start/stop/restart_container, ' +
      'check_image_updates) — or any Wisp operation job by id. Returns status "running" with the latest ' +
      'progress, or "done" with the result, or "error" with the error and its code. Poll it until the ' +
      'status is no longer "running"; a finished job stays readable for 5 minutes.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'The jobId a tool returned' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    scope: 'read',
    handler: async ({ jobId }) => {
      if (typeof jobId !== 'string' || !jobId) throw createAppError('INVALID_REQUEST', 'jobId is required');
      const job = operationJobStore.getJob(jobId);
      if (!job) {
        throw createAppError('JOB_NOT_FOUND', `No job with id "${jobId}"`, 'Unknown, or finished more than 5 minutes ago');
      }
      const last = job.events[job.events.length - 1] ?? null;
      const base = { jobId, kind: job.kind, title: job.title, startedAt: new Date(job.createdAt).toISOString() };
      if (!job.done) return { ...base, status: 'running', progress: last };
      if (last?.step === 'error') {
        return { ...base, status: 'error', error: { message: last.error, detail: last.detail, ...(last.code ? { code: last.code } : {}) } };
      }
      const { step: _step, ...result } = last ?? {};
      return { ...base, status: 'done', result };
    },
  },
];
