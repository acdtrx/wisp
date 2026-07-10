import { randomBytes } from 'node:crypto';

import { verifyPassword, signJWT, setPassword } from '../lib/auth.js';
import { appendSetCookie, buildSetCookie } from '../lib/cookies.js';
import { closeAllSSE } from '../lib/sse.js';
import { closeAllWebSockets } from '../lib/wsTracking.js';
import { getRawOidcConfig } from '../lib/settings.js';
import { beginLogin, completeLogin } from '../lib/oidc.js';
import { listApiTokens, createApiToken, revokeApiToken, API_TOKEN_SCOPES } from '../lib/apiTokens.js';
import { isAuthRateLimited, recordFailedAuthAttempt, AUTH_RATE_WINDOW_SECONDS } from '../lib/loginRateLimit.js';
import { handleRouteError } from '../lib/routeErrors.js';

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

// Browser-facing 302. Set-Cookie headers (via reply.raw.appendHeader) already
// staged by setSessionCookies survive this — same mechanism the login route uses.
function redirect(reply, location) {
  reply.code(302).header('Location', location).send();
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
      if (isAuthRateLimited(ip)) {
        reply.code(429).send({
          error: 'Too many login attempts',
          detail: `Try again after ${AUTH_RATE_WINDOW_SECONDS} seconds`,
        });
        return;
      }

      const { password } = request.body;

      if (!verifyPassword(password)) {
        recordFailedAuthAttempt(ip);
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

  // --- API tokens ------------------------------------------------------------
  // Session-only by construction: the auth hook rejects bearer auth on every
  // /api/auth route, so a token can never list, mint, or revoke tokens.

  const tokenResponseProps = {
    id: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string', enum: API_TOKEN_SCOPES },
    createdAt: { type: 'string' },
  };

  fastify.get('/tokens', {
    schema: {
      response: {
        200: {
          type: 'array',
          items: { type: 'object', properties: tokenResponseProps },
        },
      },
    },
    handler: async () => listApiTokens(),
  });

  fastify.post('/tokens', {
    schema: {
      body: {
        type: 'object',
        required: ['label', 'scope'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 64 },
          scope: { type: 'string', enum: API_TOKEN_SCOPES },
        },
        additionalProperties: false,
      },
      response: {
        201: {
          type: 'object',
          properties: {
            ...tokenResponseProps,
            // Plaintext, returned exactly once — only the hash is stored.
            token: { type: 'string' },
          },
        },
      },
    },
    handler: async (request, reply) => {
      try {
        const created = await createApiToken(request.body.label, request.body.scope);
        reply.code(201);
        return created;
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  fastify.delete('/tokens/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } },
      },
      response: { 204: { type: 'null' } },
    },
    handler: async (request, reply) => {
      try {
        await revokeApiToken(request.params.id);
        reply.code(204).send();
      } catch (err) {
        handleRouteError(err, reply, request);
      }
    },
  });

  // --- OIDC / SSO (public routes; see PUBLIC_ROUTES in lib/auth.js) ---------

  // Tells the login page whether to show (and auto-redirect to) SSO. Public and
  // secret-free — only the enabled boolean, never issuer/client details.
  fastify.get('/oidc/status', {
    schema: {
      response: {
        200: { type: 'object', properties: { enabled: { type: 'boolean' } } },
      },
    },
    handler: async () => {
      const config = await getRawOidcConfig();
      return { enabled: config.enabled === true };
    },
  });

  // Kicks off the auth-code flow: build the provider authorization URL (with
  // PKCE + state + nonce) and 302 the browser to it. On any failure — including
  // an unreachable provider — bounce back to /login?sso=error so the password
  // form (and its "try SSO again" button) is shown instead of a dead end.
  fastify.get('/oidc/login', {
    handler: async (request, reply) => {
      const config = await getRawOidcConfig();
      if (!config.enabled) {
        redirect(reply, '/login?sso=disabled');
        return;
      }
      const host = request.headers.host;
      if (!host) {
        request.log.warn('OIDC login: request has no Host header');
        redirect(reply, '/login?sso=error');
        return;
      }
      // Derive the callback from the request origin. trustProxy (loopback) makes
      // request.protocol honor X-Forwarded-Proto so this is the browser-facing
      // URL even behind a TLS-terminating reverse proxy. Register this exact URL
      // as the redirect URI in the provider.
      const redirectUri = `${request.protocol}://${host}/api/auth/oidc/callback`;
      try {
        const { authorizationUrl } = await beginLogin({
          issuer: config.issuer,
          clientId: config.clientId,
          redirectUri,
        });
        redirect(reply, authorizationUrl);
      } catch (err) {
        request.log.error({ err: err.message, code: err.code }, 'OIDC login start failed');
        redirect(reply, '/login?sso=error');
      }
    },
  });

  // Provider redirect target. Validates state + exchanges the code + verifies
  // the ID token, then issues the SAME session as a password login. Access
  // control is delegated to the provider (restrict the client to your user
  // there); any subject that authenticates is the single Wisp user.
  fastify.get('/oidc/callback', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          state: { type: 'string' },
          error: { type: 'string' },
          error_description: { type: 'string' },
        },
        // Providers may append extra params (iss, session_state, …).
        additionalProperties: true,
      },
    },
    handler: async (request, reply) => {
      const { code, state, error } = request.query || {};
      if (error) {
        // access_denied = the user cancelled/denied consent at the provider.
        const dest = error === 'access_denied' ? '/login?sso=cancelled' : '/login?sso=error';
        request.log.info({ error }, 'OIDC callback returned provider error');
        redirect(reply, dest);
        return;
      }
      const config = await getRawOidcConfig();
      if (!config.enabled) {
        redirect(reply, '/login?sso=disabled');
        return;
      }
      try {
        const { claims } = await completeLogin({
          issuer: config.issuer,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          state,
          code,
        });
        request.log.info({ sub: claims.sub }, 'OIDC login succeeded');
        const token = signJWT({ role: 'admin' });
        const csrfToken = randomBytes(32).toString('base64url');
        setSessionCookies(reply, request, token, csrfToken);
        redirect(reply, '/');
      } catch (err) {
        request.log.warn({ err: err.message, code: err.code }, 'OIDC callback failed');
        redirect(reply, '/login?sso=error');
      }
    },
  });
}
