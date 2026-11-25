import {
  getCertificateRecord,
  removeCertificateSetting,
  saveCertificateSetting,
  startCertificateIssueJob,
} from '../lib/hostCertificate.js';
import { MAX_CERTIFICATE_DOMAIN } from '../lib/configSchema.js';
import { errorBodySchema, jobAckSchema, noContentSchema } from './schemas.js';

/** A Cloudflare API token is 40 characters; room for any future form, never a document. */
const MAX_TOKEN_LENGTH = 1024;

const isoDate = { type: 'string' };

const recordSchema = {
  type: 'object',
  required: ['domain', 'tokenSet', 'certificate', 'lastAttempt'],
  properties: {
    domain: { type: ['string', 'null'] },
    tokenSet: { type: 'boolean' },
    certificate: {
      type: ['object', 'null'],
      required: ['domain', 'validFrom', 'validUntil', 'renewAt'],
      properties: { domain: { type: 'string' }, validFrom: isoDate, validUntil: isoDate, renewAt: isoDate },
      additionalProperties: false,
    },
    lastAttempt: {
      type: ['object', 'null'],
      required: ['at', 'error'],
      properties: { at: isoDate, error: { ...errorBodySchema, type: ['object', 'null'] } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/*
 * The host's certificate (docs/specs/API-HOST.md, Certificate;
 * docs/specs/CERTIFICATES.md). Every write, and the end of every attempt, is
 * announced as the `certificate` change by lib/hostCertificate.js. The writes
 * are admin: the token edits the operator's DNS.
 */
export default async function certificateRoutes(fastify) {
  fastify.get('/settings/certificate', {
    config: { auth: 'read' },
    schema: { response: { 200: recordSchema } },
    handler: async () => getCertificateRecord(),
  });

  fastify.put('/settings/certificate', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['domain'],
        properties: {
          // Room for the blanks a paste brings; the domain itself is checked.
          domain: { type: 'string', maxLength: MAX_CERTIFICATE_DOMAIN * 2 },
          // Write-only: omitted or empty keeps the stored one.
          cloudflareApiToken: { type: 'string', maxLength: MAX_TOKEN_LENGTH },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await saveCertificateSetting(request.body, request.log);
      reply.code(204).send();
    },
  });

  fastify.delete('/settings/certificate', {
    config: { auth: 'admin' },
    schema: { response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await removeCertificateSetting(request.log);
      reply.code(204).send();
    },
  });

  fastify.post('/settings/certificate/renew', {
    config: { auth: 'admin' },
    schema: { response: { 202: jobAckSchema } },
    handler: async (request, reply) => reply.code(202).send(await startCertificateIssueJob(request.log)),
  });
}
