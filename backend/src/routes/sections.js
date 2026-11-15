import {
  listSections,
  createSection,
  renameSection,
  deleteSection,
  assignWorkload,
  reorderSections,
  getAssignments,
} from '../lib/sections.js';
import { handleRouteError } from '../lib/routeErrors.js';

const sectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    order: { type: 'number' },
    builtin: { type: 'boolean' },
  },
};

const responseSchema = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: sectionSchema },
    /* `assignments` is a freeform `{ "vm:foo": "section-id", ... }` map; we
     * leave the value type loose because Fastify's response serializer would
     * otherwise drop entries it doesn't recognise. */
    assignments: { type: 'object', additionalProperties: { type: 'string' } },
  },
};

/** `{ sections, assignments }` — the envelope `GET /sections` returns, and the
 *  payload of the `sections` topic on /api/events (which imports it from here). */
export async function buildSectionsEnvelope() {
  const [sections, assignments] = await Promise.all([listSections(), getAssignments()]);
  return { sections, assignments };
}

/** The ack of a create: the new record's id. The record itself arrives on the topic. */
const createdSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
};

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
      response: { 201: createdSchema },
    },
    handler: async (request, reply) => {
      try {
        const id = await createSection(request.body.name);
        reply.code(201).send({ id });
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.patch('/sections/:id', {
    config: { auth: 'admin' },
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      try {
        await renameSection(request.params.id, request.body.name);
        reply.code(204).send();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/sections/:id', {
    config: { auth: 'admin' },
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      try {
        await deleteSection(request.params.id);
        reply.code(204).send();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
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
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      try {
        await reorderSections(request.body.ids);
        reply.code(204).send();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.put('/sections/assign', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['type', 'name'],
        properties: {
          type: { type: 'string', enum: ['vm', 'container'] },
          name: { type: 'string', minLength: 1, maxLength: 64 },
          sectionId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      try {
        const { type, name, sectionId } = request.body;
        await assignWorkload({ type, name, sectionId: sectionId ?? null });
        reply.code(204).send();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });
}
