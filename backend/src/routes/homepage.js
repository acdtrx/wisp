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
import { handleRouteError } from '../lib/routeErrors.js';

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
const idParams = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

/**
 * Home page routes. Every one returns the same `{ tiles, groups }` envelope the
 * `home` topic pushes, so a client stays in sync from one response — no
 * follow-up fetch after a mutation. Mirrors the sections routes.
 *
 * Tile ids are URLs for derived tiles, so they travel in the body rather than
 * the path (`PUT /homepage/tiles/assign`, `PUT /homepage/tiles/override`).
 */
export default async function homepageRoutes(fastify) {
  fastify.get('/homepage', {
    schema: { response: { 200: responseSchema } },
    handler: async () => buildHomeEnvelope(),
  });

  fastify.post('/homepage/groups', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: nameProperty },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await createHomeGroup(request.body.name);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.patch('/homepage/groups/:id', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: nameProperty },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await renameHomeGroup(request.params.id, request.body.name);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/homepage/groups/:id', {
    schema: { params: idParams, response: { 200: responseSchema } },
    handler: async (request, reply) => {
      try {
        await deleteHomeGroup(request.params.id);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.post('/homepage/groups/reorder', {
    schema: {
      body: {
        type: 'object',
        required: ['ids'],
        properties: { ids: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await reorderHomeGroups(request.body.ids);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.put('/homepage/tiles/assign', {
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
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        const { tileId, groupId, index } = request.body;
        await assignTileToGroup({ tileId, groupId: groupId ?? null, index: index ?? null });
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.put('/homepage/tiles/override', {
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
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await setTileOverride(request.body);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.post('/homepage/manual-tiles', {
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
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await addManualTile(request.body);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.patch('/homepage/manual-tiles/:id', {
    schema: {
      params: idParams,
      body: {
        type: 'object',
        properties: {
          name: nameProperty,
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          iconId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: { 200: responseSchema },
    },
    handler: async (request, reply) => {
      try {
        await updateManualTile(request.params.id, request.body);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/homepage/manual-tiles/:id', {
    schema: { params: idParams, response: { 200: responseSchema } },
    handler: async (request, reply) => {
      try {
        await removeManualTile(request.params.id);
        return await buildHomeEnvelope();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });
}
