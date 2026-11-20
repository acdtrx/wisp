/**
 * The schemas more than one route file uses.
 */

/** The workload a job acts on, `null` for a job on none. */
export const jobSubjectSchema = {
  type: ['object', 'null'],
  required: ['type', 'name'],
  properties: {
    type: { type: 'string', enum: ['vm', 'container'] },
    name: { type: 'string' },
  },
};

/** A job route's 202 body: the job it started, or the running one it joined (docs/specs/API.md, Background jobs). */
export const jobAckSchema = {
  type: 'object',
  required: ['jobId', 'kind', 'title', 'subject'],
  properties: {
    jobId: { type: 'string' },
    kind: { type: 'string' },
    title: { type: 'string' },
    subject: jobSubjectSchema,
  },
};
