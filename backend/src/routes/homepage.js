import {
  createHomeGroup,
  renameHomeGroup,
  deleteHomeGroup,
  reorderHomeGroups,
  assignTileToGroup,
  setTileOverride,
  addManualTile,
  updateManualTile,
  removeManualTile,
} from '../lib/homepage.js';
import { buildHomeEnvelope } from '../lib/homeTiles.js';
import { createdIdSchema, idParamsSchema, noContentSchema } from './schemas.js';

const tileSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    source: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    host: { type: 'string' },
    iconId: { type: 'string' },
    hidden: { type: 'boolean' },
    workload: {
      type: ['object', 'null'],
      properties: {
        type: { type: 'string' },
        name: { type: 'string' },
        state: { type: 'string' },
        updateAvailable: { type: 'boolean' },
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          publisher: { type: 'string' },
          manualTileId: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const groupSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    builtin: { type: 'boolean' },
    tileIds: { type: 'array', items: { type: 'string' } },
  },
};

const responseSchema = {
  type: 'object',
  properties: {
    tiles: { type: 'array', items: tileSchema },
    groups: { type: 'array', items: groupSchema },
  },
};

const nameProperty = { type: 'string', minLength: 1, maxLength: 64 };

/**
 * Home page routes. A write answers with an ack (204, or `201 { id }` for a
 * create); the new `{ tiles, groups }` envelope reaches every client on the
 * `home` topic. Mirrors the sections routes.
 *
 * Tile ids are URLs for derived tiles, so they travel in the body rather than
 * the path (`PUT /homepage/tiles/assign`, `PUT /homepage/tiles/override`).
 */
export default async function homepageRoutes(fastify) {
  fastify.get('/homepage', {
    config: { auth: 'read' },
    schema: { response: { 200: responseSchema } },
    handler: async () => buildHomeEnvelope(),
  });

  fastify.post('/homepage/groups', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: nameProperty },
        additionalProperties: false,
      },
      response: { 201: createdIdSchema },
    },
    handler: async (request, reply) => {
      const id = await createHomeGroup(request.body.name);
      reply.code(201).send({ id });
    },
  });

  fastify.patch('/homepage/groups/:id', {
    config: { auth: 'admin' },
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: nameProperty },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await renameHomeGroup(request.params.id, request.body.name);
      reply.code(204).send();
    },
  });

  fastify.delete('/homepage/groups/:id', {
    config: { auth: 'admin' },
    schema: { params: idParamsSchema, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await deleteHomeGroup(request.params.id);
      reply.code(204).send();
    },
  });

  fastify.post('/homepage/groups/reorder', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['ids'],
        properties: { ids: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await reorderHomeGroups(request.body.ids);
      reply.code(204).send();
    },
  });

  fastify.put('/homepage/tiles/assign', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['tileId'],
        properties: {
          tileId: { type: 'string', minLength: 1 },
          groupId: { type: ['string', 'null'] },
          index: { type: ['integer', 'null'], minimum: 0 },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      const { tileId, groupId, index } = request.body;
      await assignTileToGroup({ tileId, groupId: groupId ?? null, index: index ?? null });
      reply.code(204).send();
    },
  });

  fastify.put('/homepage/tiles/override', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['tileId'],
        properties: {
          tileId: { type: 'string', minLength: 1 },
          hidden: { type: ['boolean', 'null'] },
          name: { type: ['string', 'null'], maxLength: 64 },
          iconId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await setTileOverride(request.body);
      reply.code(204).send();
    },
  });

  fastify.post('/homepage/manual-tiles', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: nameProperty,
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          iconId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: { 201: createdIdSchema },
    },
    handler: async (request, reply) => {
      const id = await addManualTile(request.body);
      reply.code(201).send({ id });
    },
  });

  fastify.patch('/homepage/manual-tiles/:id', {
    config: { auth: 'admin' },
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        properties: {
          name: nameProperty,
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          iconId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await updateManualTile(request.params.id, request.body);
      reply.code(204).send();
    },
  });

  fastify.delete('/homepage/manual-tiles/:id', {
    config: { auth: 'admin' },
    schema: { params: idParamsSchema, response: { 204: noContentSchema } },
    handler: async (request, reply) => {
      await removeManualTile(request.params.id);
      reply.code(204).send();
    },
  });
}
