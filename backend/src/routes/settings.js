import { getSettings, updateSettings, updateOidcSettings } from '../lib/settings.js';
import { createAppError } from '../lib/appErrors.js';
import { refreshWispAnnouncement } from '../lib/wispDiscovery.js';
import { mountResponseSchema } from './mounts.js';

const backupScheduleSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    time: { type: 'string' },
    destinationIds: { type: 'array', items: { type: 'string' } },
    retainDays: { type: 'integer' },
    retainWeeks: { type: 'integer' },
  },
  additionalProperties: false,
};

const settingsResponseProps = {
  serverName: { type: 'string' },
  vmsPath: { type: 'string' },
  imagePath: { type: 'string' },
  backupLocalPath: { type: 'string' },
  containersPath: { type: 'string' },
  mounts: { type: 'array', items: mountResponseSchema },
  backupMountId: { type: ['string', 'null'] },
  backupSchedule: backupScheduleSchema,
  discoveryEnabled: { type: 'boolean' },
  advertisedUrl: { type: ['string', 'null'] },
  updateChannel: { type: 'string' },
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
    config: { auth: 'read' },
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
    config: { auth: 'admin' },
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
          backupSchedule: backupScheduleSchema,
          discoveryEnabled: { type: 'boolean' },
          advertisedUrl: { type: ['string', 'null'] },
          updateChannel: { type: 'string', enum: ['stable', 'beta'] },
          // Declared only so the handler sees it and refuses it: Fastify's ajv
          // strips undeclared keys silently, which would answer 204 to a token
          // that tried to repoint SSO. OIDC goes through PATCH /settings/oidc.
          oidc: {},
        },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      const body = request.body || {};
      if (body.oidc !== undefined) {
        throw createAppError(
          'OIDC_SESSION_ONLY',
          'OIDC settings require a browser session',
          // No paths here: the detail is redacted, and anything path-shaped with it.
          'The oidc key is not accepted here; configure single sign-on from a browser session (Host → App Config → Single sign-on)',
        );
      }
      await updateSettings(body);
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
      reply.code(204).send();
    },
  });

  // Session-only (settled 2026-10-16): whoever controls the issuer controls a
  // full browser login, so an API token must never be able to repoint it —
  // docs/specs/AUTH.md § Denied surfaces.
  fastify.patch('/settings/oidc', {
    config: { auth: 'session' },
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          issuer: { type: 'string' },
          clientId: { type: 'string' },
          // Write-only: empty/omitted keeps the saved secret (only while issuer
          // and clientId stay the same). Never returned by GET.
          clientSecret: { type: 'string' },
        },
        additionalProperties: false,
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      await updateOidcSettings(request.body || {});
      reply.code(204).send();
    },
  });
}
