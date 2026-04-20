import { getSettings, updateSettings } from '../lib/settings.js';
import { sendError } from '../lib/routeErrors.js';

const mountResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    label: { type: 'string' },
    mountPath: { type: 'string' },
    autoMount: { type: 'boolean' },
    share: { type: 'string' },
    username: { type: 'string' },
    password: { type: 'string' },
    uuid: { type: 'string' },
    fsType: { type: 'string' },
    readOnly: { type: 'boolean' },
  },
};

const settingsResponseProps = {
  serverName: { type: 'string' },
  vmsPath: { type: 'string' },
  imagePath: { type: 'string' },
  refreshIntervalSeconds: { type: 'integer' },
  backupLocalPath: { type: 'string' },
  containersPath: { type: 'string' },
  mounts: { type: 'array', items: mountResponseSchema },
  backupMountId: { type: ['string', 'null'] },
};

export default async function settingsRoutes(fastify) {
  fastify.get('/settings', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async () => {
      return getSettings();
    },
  });

  fastify.patch('/settings', {
    schema: {
      body: {
        type: 'object',
        properties: {
          serverName: { type: ['string', 'null'] },
          refreshIntervalSeconds: { type: 'integer', minimum: 1, maximum: 60 },
          vmsPath: { type: 'string' },
          imagePath: { type: 'string' },
          backupLocalPath: { type: 'string' },
          containersPath: { type: 'string' },
          backupMountId: { type: ['string', 'null'] },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: settingsResponseProps,
        },
      },
    },
    handler: async (request, reply) => {
      try {
        return await updateSettings(request.body || {});
      } catch (err) {
        fastify.log.error({ err }, 'Failed to update settings');
        sendError(reply, 500, 'Failed to save settings', err.message);
      }
    },
  });
}
