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

async function buildResponse() {
  const [sections, assignments] = await Promise.all([listSections(), getAssignments()]);
  return { sections, assignments };
}

export default async function sectionsRoutes(fastify) {
  fastify.get('/sections', {
    schema: { response: { 200: responseSchema } },
    handler: async () => buildResponse(),
  });

  fastify.post('/sections', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await createSection(request.body.name);
        return await buildResponse();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.patch('/sections/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await renameSection(request.params.id, request.body.name);
        return await buildResponse();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/sections/:id', {
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await deleteSection(request.params.id);
        return await buildResponse();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.post('/sections/reorder', {
    schema: {
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await reorderSections(request.body.ids);
        return await buildResponse();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.put('/sections/assign', {
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
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        const { type, name, sectionId } = request.body;
        await assignWorkload({ type, name, sectionId: sectionId ?? null });
        return await buildResponse();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });
}
