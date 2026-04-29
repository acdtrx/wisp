import { verifyPassword, signJWT, setPassword } from '../lib/auth.js';

const LOGIN_RATE_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 5;
const LOGIN_ATTEMPTS_MAX_ENTRIES = 10_000;
const LOGIN_SWEEP_INTERVAL_MS = 60 * 1000;
const loginAttempts = new Map();

// Periodic sweep so the map can't grow unbounded (one entry per failing IP).
// `unref()` so the sweep timer doesn't hold the process open during shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, LOGIN_SWEEP_INTERVAL_MS).unref();

function isLoginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= LOGIN_RATE_MAX_ATTEMPTS;
}

function recordFailedLogin(ip) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    // Hard cap on map size in case the sweep falls behind a flood of distinct
    // IPs. Returning early means we just stop counting failures for new IPs
    // until the window rolls — acceptable trade-off vs. unbounded memory.
    if (loginAttempts.size >= LOGIN_ATTEMPTS_MAX_ENTRIES) return;
    entry = { count: 0, resetAt: now + LOGIN_RATE_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }
  entry.count += 1;
}

export default async function authRoutes(fastify) {
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      const ip = request.ip || 'unknown';
      if (isLoginRateLimited(ip)) {
        reply.code(429).send({
          error: 'Too many login attempts',
          detail: `Try again after ${Math.ceil(LOGIN_RATE_WINDOW_MS / 1000)} seconds`,
        });
        return;
      }

      const { password } = request.body;

      if (!verifyPassword(password)) {
        recordFailedLogin(ip);
        reply.code(401).send({ error: 'Invalid password', detail: 'The provided password is incorrect' });
        return;
      }

      const token = signJWT({ role: 'admin' });
      return { token };
    },
  });

  fastify.post('/change-password', {
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1 },
          newPassword: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
      response: {
        204: { type: 'null' },
      },
    },
    handler: async (request, reply) => {
      const { currentPassword, newPassword } = request.body;

      if (!verifyPassword(currentPassword)) {
        reply.code(401).send({
          error: 'Invalid password',
          detail: 'The current password is incorrect',
        });
        return;
      }

      try {
        setPassword(newPassword);
        reply.code(204).send();
      } catch (err) {
        fastify.log.error({ err }, 'Failed to update password');
        reply.code(500).send({
          error: 'Failed to update password',
          detail: err.message,
        });
      }
    },
  });
}
