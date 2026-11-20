import { fetchGithubKeys, getCloudInitConfig } from '../lib/cloudInit.js';
import { saveVmCloudInit, removeVmCloudInit } from '../lib/vmOperations.js';
import { createAppError } from '../lib/appErrors.js';
import { cloudInitSchema, noContentSchema, vmParamsSchema } from './schemas.js';

export default async function cloudInitRoutes(fastify) {
  // GET /vms/:name/cloudinit — returns sanitized cloud-init config
  fastify.get('/vms/:name/cloudinit', {
    config: { auth: 'read' },
    schema: {
      params: vmParamsSchema(),
      response: { 200: cloudInitSchema },
    },
    handler: async (request) => {
      const config = await getCloudInitConfig(request.params.name);
      return config || { enabled: false };
    },
  });

  // PUT /vms/:name/cloudinit — save config, generate ISO, attach sde
  fastify.put('/vms/:name/cloudinit', {
    config: { auth: 'admin' },
    schema: {
      params: vmParamsSchema(),
      body: cloudInitSchema,
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await saveVmCloudInit(request.params.name, request.body, request.log);
      reply.code(204).send();
    },
  });

  // DELETE /vms/:name/cloudinit — detach sde, delete ISO + config
  fastify.delete('/vms/:name/cloudinit', {
    config: { auth: 'admin' },
    schema: {
      params: vmParamsSchema(),
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await removeVmCloudInit(request.params.name);
      reply.code(204).send();
    },
  });

  // GET /github/keys/:username — fetch SSH keys from GitHub. Per-IP rate
  // limit (10 req/min) so this proxy can't be used to spray GitHub on the
  // operator's behalf.
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

  fastify.get('/github/keys/:username', {
    config: { auth: 'admin' },
    schema: {
      params: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$' } },
        additionalProperties: false,
      },
      response: {
        200: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } } },
      },
    },
    handler: async (request) => {
      if (!recordGithubKeysHit(request.ip || 'unknown')) {
        throw createAppError(
          'RATE_LIMITED',
          `Too many GitHub key lookups: try again after ${Math.ceil(GITHUB_KEYS_RATE_WINDOW_MS / 1000)} seconds`,
        );
      }
      const keys = await fetchGithubKeys(request.params.username);
      return { keys };
    },
  });
}
