/**
 * The app: every hook, plugin and route registered (docs/ARCHITECTURE.md, Run
 * shape). `index.js` builds it once the stored state is migrated and checked;
 * the route report and the unit tests build it too.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { createAuthHook, createRouteAccessRegistry } from './lib/auth.js';
import { createAppError, handleRequestError } from './lib/appErrors.js';
import { getConfigSync } from './lib/config.js';
import { compileRouteValidator } from './lib/schemaValidation.js';
import { completeRouteSchema } from './routes/schemas.js';
import authRoutes from './routes/auth.js';
import hostRoutes from './routes/host.js';
import eventsRoutes from './routes/events.js';
import libraryRoutes from './routes/library.js';
import vmsRoutes from './routes/vms.js';
import cloudInitRoutes from './routes/cloudinit.js';
import consoleRoutes from './routes/console.js';
import containerConsoleRoutes from './routes/containerConsole.js';
import settingsRoutes from './routes/settings.js';
import mountsRoutes from './routes/mounts.js';
import sshKeysRoutes from './routes/sshKeys.js';
import sectionsRoutes from './routes/sections.js';
import homepageRoutes from './routes/homepage.js';
import backupsRoutes from './routes/backups.js';
import containerRoutes from './routes/containers.js';
import jobsRoutes from './routes/jobs.js';
import updatesRoutes from './routes/updates.js';
import mcpRoutes from './routes/mcp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

const isDev = process.env.NODE_ENV === 'development';

const distPath = resolve(projectRoot, 'frontend/dist');
const publicVendorPath = resolve(projectRoot, 'frontend/public/vendor');
const indexHtmlPath = resolve(distPath, 'index.html');

// In prod the backend also serves the SPA, with baseline security headers on
// every response (buildApp). `style-src 'unsafe-inline'` is required because xterm.js and
// noVNC inject inline style attributes; tightening it would need CSP nonces.
// `img-src data:` covers favicons / lucide-react inline data URIs. HSTS is
// intentionally not set — Wisp is often deployed on plain HTTP behind a LAN;
// the operator's reverse proxy enforces HSTS where TLS terminates.
// The one inline script Wisp ships is the no-flash theme resolve in
// frontend/index.html — it has to run before first paint, so it cannot move
// into the bundle, and 'self' alone would block it. Its hash is pinned here
// rather than opening 'unsafe-inline'. Vite copies the script through
// verbatim, so source and dist hash alike; if that script is edited, refresh
// this constant (a stale hash blocks it, and dark devices flash light on load):
//   node -e "const m=require('fs').readFileSync('frontend/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/);console.log('sha256-'+require('crypto').createHash('sha256').update(m[1]).digest('base64'))"
const THEME_INIT_SCRIPT_HASH = "'sha256-j2zDGxDR0XLnp4WwmvJ+mV1TOkaJklFtKEh668AC76A='";

const CSP =
  "default-src 'self'; " +
  `script-src 'self' ${THEME_INIT_SCRIPT_HASH}; ` +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

/**
 * The path the 404 / SPA-shell handler and the cache policy key on — neither is
 * an auth decision (routes declare their own access level, see lib/auth.js).
 * The router decodes percent-encoded characters before matching, so the raw URL
 * can disagree with the route that actually runs (`/%61pi/vms` dispatches to
 * `/api/vms`). When a route matched, its registered pattern is authoritative;
 * an unmatched request gets its decoded path without the query string, so
 * `/%61pi/nope` is treated as the `/api` miss it reads as (JSON 404) rather
 * than as a client-side route. A malformed escape never reaches here — the
 * router answers 400 first — but falls back to the raw path regardless.
 */
function routePath(request) {
  const matched = request.routeOptions?.url;
  if (matched) return matched;
  const raw = request.url.split('?')[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // a malformed escape is logged as the client sent it
  }
}

/**
 * Cache policy for the SPA shell and its assets. Set here rather than through
 * `@fastify/static`'s `setHeaders` for two reasons: that hook writes to
 * `reply.raw` and is immediately overwritten by the plugin's own `reply.headers()`
 * call, and it never runs for the deep-link shell served by setNotFoundHandler.
 *
 * The service worker controls every navigation, so a stale `sw.js` or `index.html`
 * pinned in the HTTP cache would outlive a self-update. Both revalidate. Assets
 * under /assets/ are content-hashed by Vite — a changed file gets a changed name,
 * so a cached copy can never be wrong and pins for a year. That holds only for a
 * file actually served: a miss under /assets/ (a chunk a pre-update page still
 * asks for) is a 404 that must not be cached, or the URL would stay broken for
 * a year if the file ever appeared.
 */
function applyShellCachePolicy(request, reply) {
  const path = routePath(request);
  if (path.startsWith('/api') || path.startsWith('/ws')) return;

  if (path === '/sw.js') {
    reply.header('Cache-Control', 'no-cache');
    return;
  }
  if (path.startsWith('/assets/')) {
    reply.header('Cache-Control', reply.statusCode >= 400 ? 'no-store' : 'public, max-age=31536000, immutable');
    return;
  }
  // The shell is the only HTML Wisp serves, from both fastify-static and the
  // deep-link fallback. Without this it has no Cache-Control and browsers apply
  // heuristic freshness, which can outlive an update.
  const contentType = reply.getHeader('content-type');
  if (typeof contentType === 'string' && contentType.startsWith('text/html')) {
    reply.header('Cache-Control', 'no-cache');
  }
}

// In prod, 404s outside the API and the static-file prefixes serve the SPA shell
// so client-side routing works on deep-link refresh. /api and /ws keep the JSON
// 404, and so do misses under /assets/ and /vendor/: those URLs name files, and
// answering a missing script with the HTML shell hands the browser a page it
// can't run (and, under /assets/, one it would cache). In dev, vite serves the
// SPA on :5173 and the backend stays a pure JSON API.
const NO_SHELL_FALLBACK_PREFIXES = ['/api', '/ws', '/assets/', '/vendor/'];

/**
 * The app with every hook, plugin and route registered, and ready: routing is
 * final when it returns. It reads the config (trustedProxies) and the SPA shell,
 * so the start calls it once the stored state is migrated and checked.
 */
export async function buildApp(log) {
  // trustProxy decides whose X-Forwarded-Proto / X-Forwarded-For are honored —
  // which drives request.protocol (https redirects + the cookie `Secure` flag) and
  // request.ip (login rate-limit key). Loopback is always trusted (an optional
  // same-host TLS proxy). When the reverse proxy (Caddy/nginx/Traefik) runs on a
  // DIFFERENT host or container, add its IP/subnet to `trustedProxies` in
  // wisp-config.json so the browser's real https scheme survives the hop.
  // Never `true` — that would trust forged headers from anyone on the network.
  const trustedProxies = getConfigSync().trustedProxies || [];
  const app = Fastify({
    loggerInstance: log,
    forceCloseConnections: true,
    trustProxy: ['127.0.0.1', '::1', ...trustedProxies],
    // Errors Fastify raises before routing (bad percent-encoding, an over-long
    // parameter, a failed async constraint) skip setErrorHandler; this sends
    // them through the same handler, in the same { error, detail } shape.
    frameworkErrors: handleRequestError,
  });

  // The SPA shell, read once so the SPA-fallback notFoundHandler doesn't hit
  // disk on every miss. In dev the file may not exist (no build); the fallback
  // is gated on isDev so this is only required in prod.
  const indexHtml = !isDev && existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, 'utf-8') : null;

  if (!isDev) {
    app.addHook('onSend', async (request, reply, payload) => {
      reply.header('Content-Security-Policy', CSP);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'same-origin');
      applyShellCachePolicy(request, reply);
      return payload;
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = routePath(request);
    if (indexHtml && !NO_SHELL_FALLBACK_PREFIXES.some((p) => path.startsWith(p))) {
      reply.type('text/html').send(indexHtml);
      return;
    }
    request.log.info({ method: request.method, url: request.url }, 'Route not found');
    throw createAppError('ROUTE_NOT_FOUND', `No route for ${request.method} ${request.url.split('?')[0]}`);
  });

  // Routes and hooks throw; framework refusals (schema validation, body
  // parsing) land here too: one handler answers every error.
  app.setErrorHandler(handleRequestError);

  // Input is checked by one validator: JSON bodies uncoerced, the string parts
  // (querystring, params) coerced, unknown keys refused (lib/schemaValidation.js).
  app.setValidatorCompiler(compileRouteValidator);

  // Every route declares its access level (`config: { auth }`, lib/auth.js) and
  // its schemas. The registry sees each route as it is added, before the hooks
  // below change it; main() checks the access levels once routing is final, and
  // the route report (`npm run route-access`, run by `npm run check`) the schemas.
  const routeAccess = createRouteAccessRegistry();
  app.addHook('onRoute', routeAccess.onRoute);

  // Third-party plugins that add routes of their own (the CORS preflight, static
  // assets) can't carry a per-route declaration, so the routes such a plugin
  // registers while it loads are marked public, and as the plugin's. Pending
  // plugins are flushed first so the window holds only that plugin's routes; a
  // route it added later would stay undeclared and fail closed.
  let markingPluginRoutesPublic = false;
  app.addHook('onRoute', (routeOptions) => {
    if (markingPluginRoutesPublic) routeOptions.config = { ...routeOptions.config, auth: 'public', pluginRoute: true };
  });

  // What every route of Wisp's own gets: an undeclared querystring or body
  // takes nothing, and every error answers the one error body.
  app.addHook('onRoute', completeRouteSchema);
  async function registerPluginWithPublicRoutes(plugin, opts) {
    await app.after();
    markingPluginRoutesPublic = true;
    try {
      await app.register(plugin, opts);
    } finally {
      markingPluginRoutesPublic = false;
    }
  }

  if (isDev) {
    await registerPluginWithPublicRoutes(cors, { origin: 'http://localhost:5173' });
  }

  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

  app.addHook('onRequest', createAuthHook());

  await app.register(fastifyWebsocket);

  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(hostRoutes, { prefix: '/api' });
  app.register(eventsRoutes, { prefix: '/api' });
  app.register(libraryRoutes, { prefix: '/api' });
  app.register(vmsRoutes, { prefix: '/api' });
  app.register(cloudInitRoutes, { prefix: '/api' });
  app.register(settingsRoutes, { prefix: '/api' });
  app.register(mountsRoutes, { prefix: '/api' });
  app.register(sshKeysRoutes, { prefix: '/api' });
  app.register(sectionsRoutes, { prefix: '/api' });
  app.register(homepageRoutes, { prefix: '/api' });
  app.register(backupsRoutes, { prefix: '/api' });
  app.register(containerRoutes, { prefix: '/api' });
  app.register(jobsRoutes, { prefix: '/api' });
  app.register(updatesRoutes, { prefix: '/api' });
  app.register(mcpRoutes); // /mcp — bearer-token-only MCP endpoint (see docs/specs/MCP.md)
  app.register(consoleRoutes, { prefix: '/ws' });
  app.register(containerConsoleRoutes, { prefix: '/ws' });

  // SPA static serving — only in prod; dev hits vite on :5173. /vendor/* serves
  // noVNC. The dist root has wildcard:false so unmatched paths fall through to
  // setNotFoundHandler (which returns index.html for client-side routing).
  // Dotfiles (noVNC's `.pinned` record) are build bookkeeping, never served.
  if (!isDev && existsSync(distPath)) {
    await registerPluginWithPublicRoutes(fastifyStatic, {
      root: publicVendorPath,
      prefix: '/vendor/',
      decorateReply: false,
      dotfiles: 'ignore',
    });
    await registerPluginWithPublicRoutes(fastifyStatic, {
      root: distPath,
      wildcard: false,
      dotfiles: 'ignore',
    });
  }

  await app.ready();
  return { app, routeAccess };
}
