import { getSettings, updateSettings } from '../lib/settings.js';
import { sendError, handleRouteError } from '../lib/routeErrors.js';
import { refreshWispAnnouncement } from '../lib/wispDiscovery.js';

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
  backupLocalPath: { type: 'string' },
  containersPath: { type: 'string' },
  mounts: { type: 'array', items: mountResponseSchema },
  backupMountId: { type: ['string', 'null'] },
  discoveryEnabled: { type: 'boolean' },
  advertisedUrl: { type: ['string', 'null'] },
  oidc: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      issuer: { type: 'string' },
      clientId: { type: 'string' },
      hasClientSecret: { type: 'boolean' },
    },
  },
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
          vmsPath: { type: 'string' },
          imagePath: { type: 'string' },
          backupLocalPath: { type: 'string' },
          containersPath: { type: 'string' },
          backupMountId: { type: ['string', 'null'] },
          discoveryEnabled: { type: 'boolean' },
          advertisedUrl: { type: ['string', 'null'] },
          oidc: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              issuer: { type: 'string' },
              clientId: { type: 'string' },
              // Write-only: empty/omitted keeps the saved secret. Never returned by GET.
              clientSecret: { type: 'string' },
            },
            additionalProperties: false,
          },
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
      const body = request.body || {};
      try {
        const result = await updateSettings(body);
        // Re-announce on the LAN when a discovery-relevant field changed —
        // not on every save: re-registering is a goodbye+announce on the
        // wire, so peers would see this server flicker in their dropdowns.
        // Fire-and-forget: PATCH latency must not depend on DBus.
        if (
          body.serverName !== undefined ||
          body.discoveryEnabled !== undefined ||
          body.advertisedUrl !== undefined
        ) {
          refreshWispAnnouncement().catch(() => {});
        }
        return result;
      } catch (err) {
        // Only the validation codes take the 422 path — Node fs errors also
        // carry a truthy `code` (EACCES, ENOSPC) and must keep the generic 500.
        if (err?.code === 'INVALID_URL' || err?.code === 'INVALID_OIDC') {
          handleRouteError(err, reply, request);
          return;
        }
        fastify.log.error({ err }, 'Failed to update settings');
        sendError(reply, 500, 'Failed to save settings', err.message);
      }
    },
  });
}
