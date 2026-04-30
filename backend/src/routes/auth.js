import { randomBytes } from 'node:crypto';

import { verifyPassword, signJWT, setPassword } from '../lib/auth.js';
import { appendSetCookie, buildSetCookie } from '../lib/cookies.js';
import { closeAllSSE } from '../lib/sse.js';
import { closeAllWebSockets } from '../lib/wsTracking.js';

const SESSION_COOKIE = 'wisp_session';
const CSRF_COOKIE = 'wisp_csrf';
const SESSION_MAX_AGE_SECONDS = 86400;

// `Secure` must reflect the actual request scheme. Browsers silently drop
// Secure cookies received over plain HTTP for non-localhost origins — so
// hardcoding `secure: true` in production breaks LAN-HTTP installs (login
// returns 200, browser discards the cookie, next API call 401s, frontend
// bounces to /login). With trustProxy enabled and the frontend proxy passing
// X-Forwarded-Proto, request.protocol is the original browser-side scheme.
function setSessionCookies(reply, request, jwt, csrfToken) {
  const baseAttrs = {
    secure: request.protocol === 'https',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
  appendSetCookie(reply, buildSetCookie(SESSION_COOKIE, jwt, { ...baseAttrs, httpOnly: true }));
  appendSetCookie(reply, buildSetCookie(CSRF_COOKIE, csrfToken, { ...baseAttrs, httpOnly: false }));
}

function clearSessionCookies(reply, request) {
  const baseAttrs = {
    secure: request.protocol === 'https',
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  };
  appendSetCookie(reply, buildSetCookie(SESSION_COOKIE, '', { ...baseAttrs, httpOnly: true }));
  appendSetCookie(reply, buildSetCookie(CSRF_COOKIE, '', { ...baseAttrs, httpOnly: false }));
}

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
            ok: { type: 'boolean' },
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
      // Random per-session CSRF token. Frontend reads the (non-HttpOnly)
      // wisp_csrf cookie and echoes it as X-CSRF-Token on state-changing
      // requests; the auth hook compares header to cookie. Double-submit
      // pattern — same-origin SameSite=Lax already blocks cross-site posts,
      // but the explicit token defends against subdomain/proxy edge cases
      // and deliberate mistake-class regressions.
      const csrfToken = randomBytes(32).toString('base64url');
      setSessionCookies(reply, request, token, csrfToken);
      return { ok: true };
    },
  });

  fastify.post('/logout', {
    schema: {
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      clearSessionCookies(reply, request);
      reply.code(204).send();
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
        // Rotate every live connection so pre-rotation tokens can't keep
        // streaming. New connections will fail JWT verify against the new
        // secret and the frontend's 401 handler bounces them to /login.
        closeAllSSE();
        closeAllWebSockets('password changed');
        // Re-issue the current session against the new secret so the user
        // who just changed their password isn't immediately bounced to /login.
        const newToken = signJWT({ role: 'admin' });
        const newCsrf = randomBytes(32).toString('base64url');
        setSessionCookies(reply, request, newToken, newCsrf);
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
