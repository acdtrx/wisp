import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { loadRuntimeEnv } from './lib/loadRuntimeEnv.js';
import { createAuthHook, createRouteAccessRegistry, checkRouteAccess, AUTH_LEVELS } from './lib/auth.js';
import { handleUncaughtError } from './lib/routeErrors.js';
import { getConfigSync } from './lib/config.js';
import { configure as configureVmManager, connect as connectLibvirt } from './lib/vmManager/index.js';
import {
  configure as configureContainerManager,
  connect as connectContainerd,
  disconnect as disconnectContainerd,
  startImageUpdateChecker,
  stopImageUpdateChecker,
} from './lib/containerManager/index.js';
import {
  startAutostartContainersAtBackendBoot,
  resumeStalePausedContainersAtBackendBoot,
} from './lib/containerManager/index.js';
import {
  startContainerBackupScheduler,
  stopContainerBackupScheduler,
} from './lib/containerBackupScheduler.js';
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
import sectionsRoutes from './routes/sections.js';
import homepageRoutes from './routes/homepage.js';
import backupsRoutes from './routes/backups.js';
import containerRoutes from './routes/containers.js';
import backgroundJobsRoutes from './routes/backgroundJobs.js';
import updatesRoutes from './routes/updates.js';
import mcpRoutes from './routes/mcp.js';
import { ensureMounts, installMountHotplugHandlers, startAutoMountRetry } from './lib/mountsAutoMount.js';
import { cleanPartialJsonArtifacts } from './lib/bootCleanup.js';
import { startUpdateChecker, stopUpdateChecker, start as startUsbMonitor, stop as stopUsbMonitor } from './lib/host/index.js';
import { startUpdateChecker as startWispUpdateChecker, stopUpdateChecker as stopWispUpdateChecker } from './lib/wispUpdate.js';
import { closeAllSSE } from './lib/sse.js';
import { disconnect as disconnectLibvirtBus } from './lib/vmManager/index.js';
import { start as startDiskMonitor, stop as stopDiskMonitor } from './lib/storage/index.js';
import { connect as connectMdns, disconnect as disconnectMdns } from './lib/mdns/index.js';
import { getDefaultContainerParentBridge } from './lib/networking/index.js';
import { startVmMdnsReconciler, stopVmMdnsReconciler } from './lib/vmMdnsReconciler.js';
import { startContainerMdnsReconciler, stopContainerMdnsReconciler } from './lib/containerMdnsReconciler.js';
import { startWispDiscovery, stopWispDiscovery } from './lib/wispDiscovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
loadRuntimeEnv(projectRoot);

/* Push Wisp paths + storage-mount resolver into the managers before any route
   registers or any manager-internal code runs. After this point, vmManager and
   containerManager have no Wisp-glue dependencies — they read everything from
   the configure() slots. The resolver is sync (matches the pre-refactor
   getConfigSync pattern in paths.js); wisp-config.json is small and the OS
   caches the read. */
{
  const cfg = getConfigSync();
  configureVmManager({ vmsPath: cfg.vmsPath });
  configureContainerManager({
    containersPath: cfg.containersPath,
    resolveMount: (id) => {
      if (typeof id !== 'string' || !id) return null;
      const mounts = getConfigSync().mounts || [];
      const m = mounts.find((x) => x && x.id === id);
      return m ? { id: m.id, mountPath: m.mountPath, label: m.label } : null;
    },
  });
}

const PORT = parseInt(process.env.WISP_PORT, 10) || 8080;

const isDev = process.env.NODE_ENV === 'development';

const distPath = resolve(projectRoot, 'frontend/dist');
const publicVendorPath = resolve(projectRoot, 'frontend/public/vendor');
const indexHtmlPath = resolve(distPath, 'index.html');
// Read the SPA shell once at startup so the SPA-fallback notFoundHandler
// doesn't hit disk on every miss. In dev the file may not exist (no build);
// the fallback is gated on isDev so this is only required in prod.
const indexHtml = !isDev && existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, 'utf-8') : null;

function redactToken(url) {
  return typeof url === 'string'
    ? url.replace(/([?&])token=[^&]*/g, '$1token=REDACTED')
    : url;
}

const loggerConfig = {
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: redactToken(req.url),
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      };
    },
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'SYS:HH:MM:ss.l',
            singleLine: true,
            ignore: 'pid,hostname,reqId,req.host,req.remoteAddress,req.remotePort',
          },
        },
      }
    : {}),
};

// trustProxy decides whose X-Forwarded-Proto / X-Forwarded-For are honored —
// which drives request.protocol (https redirects + the cookie `Secure` flag) and
// request.ip (login rate-limit key). Loopback is always trusted (an optional
// same-host TLS proxy). When the reverse proxy (Caddy/nginx/Traefik) runs on a
// DIFFERENT host or container, add its IP/subnet to `trustedProxies` in
// wisp-config.json so the browser's real https scheme survives the hop.
// Never `true` — that would trust forged headers from anyone on the network.
const trustedProxies = getConfigSync().trustedProxies || [];
const app = Fastify({
  logger: loggerConfig,
  forceCloseConnections: true,
  trustProxy: ['127.0.0.1', '::1', ...trustedProxies],
});

// In prod the backend also serves the SPA — apply baseline security headers to
// every response. `style-src 'unsafe-inline'` is required because xterm.js and
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
    return raw;
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

// In prod, 404s outside the API and the static-file prefixes serve the SPA shell
// so client-side routing works on deep-link refresh. /api and /ws keep the JSON
// 404, and so do misses under /assets/ and /vendor/: those URLs name files, and
// answering a missing script with the HTML shell hands the browser a page it
// can't run (and, under /assets/, one it would cache). In dev, vite serves the
// SPA on :5173 and the backend stays a pure JSON API.
const NO_SHELL_FALLBACK_PREFIXES = ['/api', '/ws', '/assets/', '/vendor/'];

app.setNotFoundHandler((request, reply) => {
  const path = routePath(request);
  if (indexHtml && !NO_SHELL_FALLBACK_PREFIXES.some((p) => path.startsWith(p))) {
    reply.type('text/html').send(indexHtml);
    return;
  }
  request.log.info({ method: request.method, url: redactToken(request.url) }, 'Route not found');
  reply.code(404).send({ error: 'Not Found', detail: `Route ${request.method} ${redactToken(request.url)} not found` });
});

// Framework errors (schema validation, body parsing) and anything a handler
// lets escape answer in the same { error, detail } shape as handled errors.
app.setErrorHandler(handleUncaughtError);

// Every route declares its access level (`config: { auth }`, lib/auth.js). The
// registry sees each route as it is added; start() checks the declarations
// once routing is final.
const routeAccess = createRouteAccessRegistry();
app.addHook('onRoute', routeAccess.onRoute);

// Third-party plugins that add routes of their own (the CORS preflight, static
// assets) can't carry a per-route declaration, so the routes such a plugin
// registers while it loads are marked public. Pending plugins are flushed first
// so the window holds only that plugin's routes; a route it added later would
// stay undeclared and fail closed.
let markingPluginRoutesPublic = false;
app.addHook('onRoute', (routeOptions) => {
  if (markingPluginRoutesPublic) routeOptions.config = { ...routeOptions.config, auth: 'public' };
});
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
app.register(sectionsRoutes, { prefix: '/api' });
app.register(homepageRoutes, { prefix: '/api' });
app.register(backupsRoutes, { prefix: '/api' });
app.register(containerRoutes, { prefix: '/api' });
app.register(backgroundJobsRoutes, { prefix: '/api' });
app.register(updatesRoutes, { prefix: '/api' });
app.register(mcpRoutes); // /mcp — bearer-token-only MCP endpoint (see docs/spec/MCP.md)
app.register(consoleRoutes, { prefix: '/ws' });
app.register(containerConsoleRoutes, { prefix: '/ws' });

// SPA static serving — only in prod; dev hits vite on :5173. /vendor/* serves
// noVNC. The dist root has wildcard:false so unmatched paths fall through to
// setNotFoundHandler (which returns index.html for client-side routing).
if (!isDev && existsSync(distPath)) {
  await registerPluginWithPublicRoutes(fastifyStatic, {
    root: publicVendorPath,
    prefix: '/vendor/',
    decorateReply: false,
  });
  await registerPluginWithPublicRoutes(fastifyStatic, {
    root: distPath,
    wildcard: false,
  });
}

/**
 * `npm run route-access`: print every route with the level the auth hook
 * enforces for it, then exit without listening. Exits 1 when a route lacks a
 * valid declaration.
 */
function printRouteAccessReport(routes) {
  const rows = new Map();
  for (const route of routes) {
    const key = `${route.url}\0${route.auth}\0${route.declared}`;
    if (!rows.has(key)) rows.set(key, { ...route, methods: [] });
    rows.get(key).methods.push(...route.method.split(','));
  }
  const sorted = [...rows.values()].sort((a, b) => a.url.localeCompare(b.url));
  const counts = Object.fromEntries(AUTH_LEVELS.map((level) => [level, 0]));
  let undeclared = 0;
  for (const row of sorted) {
    const methods = [...new Set(row.methods)].join(',');
    const level = row.declared ? row.auth : `${row.auth} (UNDECLARED)`;
    console.log(`${level.padEnd(18)} ${methods.padEnd(20)} ${row.url}`);
    const endpoints = new Set(row.methods.filter((m) => m !== 'HEAD')).size || 1;
    if (row.declared) counts[row.auth] += endpoints;
    else undeclared += endpoints;
  }
  const summary = AUTH_LEVELS.map((level) => `${level} ${counts[level]}`).join(', ');
  console.log(`\nEndpoints (HEAD mirrors of GET not counted): ${summary}, undeclared ${undeclared}`);
  return undeclared > 0 ? 1 : 0;
}

if (process.env.WISP_ROUTE_ACCESS_REPORT === '1') {
  await app.ready();
  process.exit(printRouteAccessReport(routeAccess.list()));
}

async function start() {
  // Routing is final once the app is ready: development refuses to boot on a
  // route without an access declaration; production enforces it as admin.
  await app.ready();
  checkRouteAccess(routeAccess.list(), { strict: isDev, log: app.log });

  await cleanPartialJsonArtifacts(app.log);

  try {
    await connectLibvirt(app.log);
  } catch (err) {
    app.log.warn({ err }, 'libvirt connection failed — VM operations will be unavailable');
  }

  try {
    await connectContainerd({ logger: app.log });
  } catch (err) {
    app.log.warn({ err }, 'containerd connection failed — container operations will be unavailable');
  }
  // The forwarder answers the host's own .local name from the bridge new
  // containers attach to — the segment containers reach the host on.
  await connectMdns(app.log, { hostInterface: await getDefaultContainerParentBridge() });

  // Disk monitor must populate its snapshot before ensureMounts can reconcile disk entries.
  startDiskMonitor();

  try {
    await ensureMounts(app.log);
  } catch (err) {
    app.log.warn({ err }, 'Mount auto-mount at startup failed');
  }

  unsubscribeMountHotplug = installMountHotplugHandlers(app.log);
  stopMountRetry = startAutoMountRetry(app.log);

  // A paused task at boot can only be a backup interrupted by a crash —
  // resume before autostart so the pass sees accurate states.
  await resumeStalePausedContainersAtBackendBoot(app.log);
  await startAutostartContainersAtBackendBoot(app.log);

  // mDNS reconcilers subscribe to vm/containerManager.subscribeVMNetworkChange /
  // subscribeContainerNetworkChange. Both managers replay current snapshots to
  // any new subscriber, so boot-time registration happens automatically once
  // these start — no separate warm-up loop needed.
  startVmMdnsReconciler(app.log);
  startContainerMdnsReconciler(app.log);

  // Announce this instance and browse for peers (settings-gated, best-effort,
  // never rejects). Not awaited: a hung avahi/DBus must not delay app.listen.
  startWispDiscovery(app.log, { port: PORT });

  await app.listen({ port: PORT, host: '0.0.0.0' });

  startUsbMonitor();

  startUpdateChecker(app.log);
  startImageUpdateChecker(app.log);
  startWispUpdateChecker(app.log);
  startContainerBackupScheduler(app.log);
}

let shuttingDown = false;
let unsubscribeMountHotplug = null;
let stopMountRetry = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}, shutting down`);
  closeAllSSE();
  if (unsubscribeMountHotplug) {
    try { unsubscribeMountHotplug(); } catch { /* no-op */ }
    unsubscribeMountHotplug = null;
  }
  if (stopMountRetry) {
    try { stopMountRetry(); } catch { /* no-op */ }
    stopMountRetry = null;
  }
  stopUsbMonitor();
  stopDiskMonitor();
  stopUpdateChecker();
  stopImageUpdateChecker();
  stopWispUpdateChecker();
  stopContainerBackupScheduler();
  stopVmMdnsReconciler();
  stopContainerMdnsReconciler();
  await stopWispDiscovery(); // needs the live bus — before disconnectMdns
  disconnectLibvirtBus();
  disconnectContainerd();
  await disconnectMdns();
  if (typeof app.server.closeAllConnections === 'function') {
    app.server.closeAllConnections();
  }
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  // Bootstrap fatal — Fastify's logger may not have flushed by the time we
  // exit, so use stderr directly to ensure the message reaches journald.
  console.error('Failed to start:', err);
  process.exit(1);
});
