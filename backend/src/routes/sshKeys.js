import { addSshKey, importSshKeys, removeSshKey, updateSshKey } from '../lib/settings.js';
import { fetchGithubKeys } from '../lib/githubKeys.js';
import { createAppError } from '../lib/appErrors.js';
import { MAX_SSH_KEY_LENGTH, MAX_SSH_KEY_NAME } from '../lib/sshKeys.js';
import { createdIdSchema, idParamsSchema, noContentSchema } from './schemas.js';

/** A key's name as sent: the page's rule, its checks in lib/sshKeys.js. */
const nameSchema = { type: 'string', maxLength: MAX_SSH_KEY_NAME };

/*
 * Wisp's SSH keys (docs/specs/SETTINGS.md, SSH keys): in the settings record, read
 * with `GET /api/settings`, written here. Every write is announced as a settings
 * change.
 */
export default async function sshKeysRoutes(fastify) {
  fastify.post('/settings/ssh-keys', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['key'],
        properties: {
          // Room for the surrounding blanks a paste brings; the key itself is checked.
          key: { type: 'string', maxLength: MAX_SSH_KEY_LENGTH * 2 },
          name: nameSchema,
        },
        additionalProperties: false,
      },
      response: { 201: createdIdSchema },
    },
    handler: async (request, reply) => {
      const created = await addSshKey(request.body);
      return reply.code(201).send(created);
    },
  });

  // Per-IP rate limit (10 a minute) so this import can't be used to spray GitHub
  // on the operator's behalf.
  const GITHUB_KEYS_RATE_WINDOW_MS = 60 * 1000;
  const GITHUB_KEYS_RATE_MAX = 10;
  const GITHUB_KEYS_RATE_MAX_ENTRIES = 10_000;
  const githubKeysAttempts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of githubKeysAttempts) {
      if (now > entry.resetAt) githubKeysAttempts.delete(ip);
    }
  }, GITHUB_KEYS_RATE_WINDOW_MS).unref();

  function recordGithubKeysHit(ip) {
    const now = Date.now();
    let entry = githubKeysAttempts.get(ip);
    if (!entry || now > entry.resetAt) {
      if (githubKeysAttempts.size >= GITHUB_KEYS_RATE_MAX_ENTRIES) return false;
      entry = { count: 0, resetAt: now + GITHUB_KEYS_RATE_WINDOW_MS };
      githubKeysAttempts.set(ip, entry);
    }
    entry.count += 1;
    return entry.count <= GITHUB_KEYS_RATE_MAX;
  }

  fastify.post('/settings/ssh-keys/github', {
    config: { auth: 'admin' },
    schema: {
      body: {
        type: 'object',
        required: ['user'],
        properties: {
          user: { type: 'string', maxLength: 39, pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$' },
        },
        additionalProperties: false,
      },
      response: {
        201: {
          type: 'object',
          required: ['added', 'alreadyListed'],
          properties: {
            added: { type: 'array', items: { type: 'string' } },
            alreadyListed: { type: 'integer' },
          },
          additionalProperties: false,
        },
      },
    },
    handler: async (request, reply) => {
      if (!recordGithubKeysHit(request.ip || 'unknown')) {
        throw createAppError(
          'RATE_LIMITED',
          `Too many GitHub key lookups: try again after ${Math.ceil(GITHUB_KEYS_RATE_WINDOW_MS / 1000)} seconds`,
        );
      }
      const { user } = request.body;
      const keys = await fetchGithubKeys(user);
      return reply.code(201).send(await importSshKeys(user, keys));
    },
  });

  fastify.patch('/settings/ssh-keys/:id', {
    config: { auth: 'admin' },
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        minProperties: 1,
        properties: { name: nameSchema, default: { type: 'boolean' } },
        additionalProperties: false,
      },
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await updateSshKey(request.params.id, request.body);
      reply.code(204).send();
    },
  });

  fastify.delete('/settings/ssh-keys/:id', {
    config: { auth: 'admin' },
    schema: {
      params: idParamsSchema,
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await removeSshKey(request.params.id);
      reply.code(204).send();
    },
  });
}
