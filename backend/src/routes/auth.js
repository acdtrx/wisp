import { randomBytes } from 'node:crypto';

import {
  verifyPassword, signJWT, setPassword, setSessionCookies, SESSION_COOKIE, CSRF_COOKIE,
} from '../lib/auth.js';
import { appendSetCookie, buildSetCookie } from '../lib/cookies.js';
import { closeAllSSE } from '../lib/sse.js';
import { closeAllWebSockets } from '../lib/wsTracking.js';
import { getRawOidcConfig, getSettings } from '../lib/settings.js';
import { beginLogin, completeLogin } from '../lib/oidc.js';
import { listApiTokens, createApiToken, revokeApiToken, API_TOKEN_SCOPES } from '../lib/apiTokens.js';
import { isAuthRateLimited, recordFailedAuthAttempt, AUTH_RATE_WINDOW_SECONDS } from '../lib/loginRateLimit.js';
import { asAppError, createAppError, errorBody } from '../lib/appErrors.js';
import { openOnPurpose } from '../lib/schemaValidation.js';
import { idParamsSchema, noContentSchema } from './schemas.js';

const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

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

/**
 * The OIDC callback URL — register exactly this as the redirect URI in the
 * provider. Built from `advertisedUrl` (the configured browser-facing URL) when
 * set, so no request header can steer it. Without one it falls back to the
 * request origin: `request.protocol` honors X-Forwarded-Proto only from
 * trusted proxies, and the Host header is whatever the browser sent. A forged
 * Host can only come from a non-browser client, and a provider that
 * exact-matches registered redirect URIs (OIDC Core requires it) rejects the
 * resulting authorization request.
 */
async function oidcRedirectUri(request) {
  const { advertisedUrl } = await getSettings();
  if (advertisedUrl) return new URL(OIDC_CALLBACK_PATH, advertisedUrl).href;
  const host = request.headers.host;
  if (!host) return null;
  return `${request.protocol}://${host}${OIDC_CALLBACK_PATH}`;
}

// Browser-facing 302. Set-Cookie headers (via reply.raw.appendHeader) already
// staged by setSessionCookies survive this — same mechanism the login route uses.
function redirect(reply, location) {
  reply.code(302).header('Location', location).send();
}

/**
 * The OIDC routes' error handler: they are browser navigations, so a refusal
 * (a querystring that fails its schema, or anything else that escapes the
 * handler) ends on the login page with `?sso=error`, never a JSON body
 * (docs/specs/API-AUTH.md, OIDC / SSO login).
 */
function redirectOidcFailure(err, request, reply) {
  const { error, detail } = errorBody(err);
  request.log.warn({ code: error, detail }, 'OIDC request refused');
  redirect(reply, '/login?sso=error');
}

export default async function authRoutes(fastify) {
  fastify.post('/login', {
    config: { auth: 'public' },
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
          additionalProperties: false,
        },
      },
    },
    handler: async (request, reply) => {
      const ip = request.ip || 'unknown';
      if (isAuthRateLimited(ip)) {
        throw createAppError('RATE_LIMITED', `Too many login attempts: try again after ${AUTH_RATE_WINDOW_SECONDS} seconds`);
      }

      const { password } = request.body;

      if (!verifyPassword(password)) {
        recordFailedAuthAttempt(ip);
        throw createAppError('LOGIN_FAILED', 'The password is incorrect');
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
    config: { auth: 'session' },
    schema: {
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      clearSessionCookies(reply, request);
      reply.code(204).send();
    },
  });

  fastify.post('/change-password', {
    config: { auth: 'session' },
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
        204: noContentSchema,
      },
    },
    handler: async (request, reply) => {
      const { currentPassword, newPassword } = request.body;

      // A stolen session must not get unlimited guesses at the password: a
      // wrong current password counts against the same per-IP window as login.
      const ip = request.ip || 'unknown';
      if (isAuthRateLimited(ip)) {
        throw createAppError('RATE_LIMITED', `Too many password attempts: try again after ${AUTH_RATE_WINDOW_SECONDS} seconds`);
      }

      // 422, not 401: the session is valid — 401 means "no/expired session" and
      // makes the frontend log every tab out.
      if (!verifyPassword(currentPassword)) {
        recordFailedAuthAttempt(ip);
        throw createAppError('INVALID_PASSWORD', 'Current password is incorrect');
      }

      try {
        await setPassword(newPassword);
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
        throw asAppError(err, 'Failed to update password');
      }
    },
  });

  // --- API tokens ------------------------------------------------------------
  // `session` routes: the auth hook refuses bearer tokens on them, so a token
  // can never list, mint, or revoke tokens.

  const tokenResponseProps = {
    id: { type: 'string' },
    label: { type: 'string' },
    scope: { type: 'string', enum: API_TOKEN_SCOPES },
    createdAt: { type: 'string' },
  };

  fastify.get('/tokens', {
    config: { auth: 'session' },
    schema: {
      response: {
        200: {
          type: 'array',
          items: { type: 'object', properties: tokenResponseProps, additionalProperties: false },
        },
      },
    },
    handler: async () => listApiTokens(),
  });

  fastify.post('/tokens', {
    config: { auth: 'session' },
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
          additionalProperties: false,
        },
      },
    },
    handler: async (request, reply) => {
      const created = await createApiToken(request.body.label, request.body.scope);
      reply.code(201);
      return created;
    },
  });

  fastify.delete('/tokens/:id', {
    config: { auth: 'session' },
    schema: {
      params: idParamsSchema,
      response: { 204: noContentSchema },
    },
    handler: async (request, reply) => {
      await revokeApiToken(request.params.id);
      reply.code(204).send();
    },
  });

  // --- OIDC / SSO -------------------------------------------------------------
  // `public`: these run before a session exists — `status` tells the login page
  // whether to show the SSO button, `login` redirects the browser to the
  // provider, and `callback` receives the provider redirect and mints the session.

  // Tells the login page whether to show (and auto-redirect to) SSO. Public and
  // secret-free — only the enabled boolean, never issuer/client details.
  fastify.get('/oidc/status', {
    config: { auth: 'public' },
    schema: {
      response: {
        200: { type: 'object', properties: { enabled: { type: 'boolean' } }, additionalProperties: false },
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
  // GET only, here and on the callback: Fastify's automatic HEAD runs the GET
  // handler, so a HEAD (a link checker, a prefetch) would start a login or
  // complete one, the state consumed and the session cookies set.
  fastify.get('/oidc/login', {
    exposeHeadRoute: false,
    config: { auth: 'public', answers: 'redirect' },
    errorHandler: redirectOidcFailure,
    handler: async (request, reply) => {
      const config = await getRawOidcConfig();
      if (!config.enabled) {
        redirect(reply, '/login?sso=disabled');
        return;
      }
      const redirectUri = await oidcRedirectUri(request);
      if (!redirectUri) {
        request.log.warn('OIDC login: no advertisedUrl and the request has no Host header');
        redirect(reply, '/login?sso=error');
        return;
      }
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
    exposeHeadRoute: false,
    config: { auth: 'public', answers: 'redirect' },
    errorHandler: redirectOidcFailure,
    schema: {
      // The provider's parameters: it may add its own (iss, session_state, …).
      querystring: openOnPurpose({
        type: 'object',
        properties: {
          code: { type: 'string' },
          state: { type: 'string' },
          error: { type: 'string' },
          error_description: { type: 'string' },
        },
      }),
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
