import {
  listSections,
  createSection,
  renameSection,
  deleteSection,
  assignWorkload,
  reorderSections,
  getAssignments,
} from '../lib/sections.js';
import { openOnPurpose } from '../lib/schemaValidation.js';
import { containerNameSchema, vmNameSchema } from '../lib/validation.js';
import { createdIdSchema, idParamsSchema, noContentSchema } from './schemas.js';

const sectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    order: { type: 'number' },
    builtin: { type: 'boolean' },
  },
  additionalProperties: false,
};

const responseSchema = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: sectionSchema },
    /* `assignments` is a `{ "vm:foo": "section-id", ... }` map, whatever the keys. */
    assignments: openOnPurpose({ type: 'object', additionalProperties: { type: 'string' } }),
  },
  additionalProperties: false,
};

/** `{ sections, assignments }` — the envelope `GET /sections` returns, and the
 *  payload of the `sections` topic on /api/events (which imports it from here). */
export async function buildSectionsEnvelope() {
  const [sections, assignments] = await Promise.all([listSections(), getAssignments()]);
  return { sections, assignments };
}

export default async function sectionsRoutes(fastify) {
  fastify.get('/sections', {
    config: { auth: 'read' },
    schema: { response: { 200: responseSchema } },
    handler: async () => buildSectionsEnvelope(),
  });

  fastify.post('/sections', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
      response: { 201: createdIdSchema },
    },
    handler: async (request, reply) => {
      const id = await createSection(request.body.name);
      reply.code(201).send({ id });
    },
  });

  fastify.patch('/sections/:id', {
    config: { auth: 'admin' },
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await renameSection(request.params.id, request.body.name);
      reply.code(204).send();
    },
  });

  fastify.delete('/sections/:id', {
    config: { auth: 'admin' },
    schema: {
      params: idParamsSchema,
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await deleteSection(request.params.id);
      reply.code(204).send();
    },
  });

  fastify.post('/sections/reorder', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await reorderSections(request.body.ids);
      reply.code(204).send();
    },
  });

  fastify.put('/sections/assign', {
    config: { auth: 'admin' },
    schema: {
      // The name is checked by its kind's workload-name schema.
      body: {
        type: 'object',
        required: ['type', 'name'],
        properties: {
          type: { type: 'string', enum: ['vm', 'container'] },
          name: { type: 'string' },
          sectionId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
        if: { type: 'object', properties: { type: { const: 'container' } } },
        then: { type: 'object', properties: { name: containerNameSchema } },
        else: { type: 'object', properties: { name: vmNameSchema } },
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { type, name, sectionId } = request.body;
      await assignWorkload({ type, name, sectionId: sectionId ?? null });
      reply.code(204).send();
    },
  });
}
