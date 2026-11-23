import { getSettings, updateSettings, updateOidcSettings } from '../lib/settings.js';
import { createAppError } from '../lib/appErrors.js';
import { refreshWispAnnouncement } from '../lib/wispDiscovery.js';
import { openOnPurpose } from '../lib/schemaValidation.js';
import { mountResponseSchema, noContentSchema } from './schemas.js';

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
    additionalProperties: false,
  },
  // Public keys: no secret here. `type` and `fingerprint` are read from `key`.
  sshKeys: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'name', 'key', 'default', 'type', 'fingerprint'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        key: { type: 'string' },
        default: { type: 'boolean' },
        type: { type: 'string' },
        fingerprint: { type: 'string' },
      },
      additionalProperties: false,
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
          additionalProperties: false,
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
          // Declared so the refusal names where OIDC is set (PATCH /settings/oidc,
          // a session only) rather than answering an unknown key.
          oidc: openOnPurpose(),
        },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
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
        refreshWispAnnouncement().catch(() => { /* it logs its own failure and never rejects */ });
      }
      reply.code(204).send();
    },
  });

  // Session-only: whoever controls the issuer controls a
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
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await updateOidcSettings(request.body || {});
      reply.code(204).send();
    },
  });
}
