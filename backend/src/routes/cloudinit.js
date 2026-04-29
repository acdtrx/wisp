import {
  getCloudInitConfig,
  updateCloudInit,
  detachCloudInitDisk,
} from '../lib/vmManager.js';
import { handleRouteError, sendError } from '../lib/routeErrors.js';
import { validateVMName } from '../lib/validation.js';

export default async function cloudInitRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    const name = request.params?.name;
    if (name !== undefined) {
      try {
        validateVMName(name);
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    }
  });

  // GET /vms/:name/cloudinit — returns sanitized cloud-init config
  fastify.get('/vms/:name/cloudinit', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      try {
        const config = await getCloudInitConfig(request.params.name);
        return config || { enabled: false };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // PUT /vms/:name/cloudinit — save config, generate ISO, attach sde
  fastify.put('/vms/:name/cloudinit', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          // RFC 1123 hostname label (1–63 chars, alphanumerics + hyphen, no leading/trailing hyphen).
          hostname: { type: 'string', maxLength: 63, pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$' },
          username: { type: 'string', maxLength: 32, pattern: '^[a-z][a-z0-9_-]{0,31}$' },
          // Password is opaque to validation (we hash it). Forbid CR/LF so user input cannot extend the cloud-init document mid-scalar (defense in depth — js-yaml escaping already handles it). Empty string allowed; '***' / 'set' are placeholders.
          password: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n]*$' },
          // SSH key may be one or more lines (e.g. several keys joined by \n). Each non-empty line must look like a key entry. Length-cap to keep the user-data ISO bounded.
          sshKey: { type: 'string', maxLength: 16384 },
          sshKeySource: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9:_-]*$' },
          growPartition: { type: 'boolean' },
          packageUpgrade: { type: 'boolean' },
          installQemuGuestAgent: { type: 'boolean' },
          installAvahiDaemon: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    handler: async (request, reply) => {
      try {
        await updateCloudInit(request.params.name, request.body);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // DELETE /vms/:name/cloudinit — detach sde, delete ISO + config
  fastify.delete('/vms/:name/cloudinit', {
    schema: {
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
    handler: async (request, reply) => {
      try {
        await detachCloudInitDisk(request.params.name);
        return { ok: true };
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // GET /github/keys/:username — fetch SSH keys from GitHub.
  //
  // - `redirect: 'manual'` so a hostile/compromised upstream that ever 30x's
  //   into a private IP can't turn this auth-required proxy into an SSRF.
  //   GitHub's `.keys` endpoint does not redirect under normal use — a 3xx
  //   surfaces as 502.
  // - Per-IP rate limit (10 req/min) so this proxy can't be used to spray
  //   GitHub's API on the operator's behalf.
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
    schema: {
      params: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string', pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$' } },
      },
    },
    handler: async (request, reply) => {
      if (!recordGithubKeysHit(request.ip || 'unknown')) {
        return sendError(reply, 429, 'Too many requests', `Try again after ${Math.ceil(GITHUB_KEYS_RATE_WINDOW_MS / 1000)} seconds`);
      }
      const { username } = request.params;
      try {
        const resp = await fetch(`https://github.com/${username}.keys`, { redirect: 'manual' });
        if (resp.status >= 300 && resp.status < 400) {
          return sendError(reply, 502, 'Unexpected redirect from GitHub', 'GitHub returned a redirect for a .keys lookup');
        }
        if (!resp.ok) {
          return sendError(reply, 404, `No keys found for "${username}"`, `No keys found for "${username}"`);
        }
        const text = await resp.text();
        const keys = text.trim().split('\n').filter(Boolean);
        return { keys };
      } catch (err) {
        return sendError(reply, 502, 'Failed to fetch GitHub keys', err.message);
      }
    },
  });
}
