import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { loadRuntimeEnv } from './lib/loadRuntimeEnv.js';
import { createAuthHook } from './lib/auth.js';
import { connect as connectLibvirt } from './lib/vmManager.js';
import {
  connect as connectContainerd,
  disconnect as disconnectContainerd,
  startImageUpdateChecker,
  stopImageUpdateChecker,
} from './lib/containerManager.js';
import {
  listContainers,
  getContainerConfig,
  startAutostartContainersAtBackendBoot,
} from './lib/containerManager.js';
import authRoutes from './routes/auth.js';
import hostRoutes from './routes/host.js';
import statsRoutes from './routes/stats.js';
import libraryRoutes from './routes/library.js';
import vmsRoutes from './routes/vms.js';
import cloudInitRoutes from './routes/cloudinit.js';
import consoleRoutes from './routes/console.js';
import containerConsoleRoutes from './routes/containerConsole.js';
import settingsRoutes from './routes/settings.js';
import mountsRoutes from './routes/mounts.js';
import sectionsRoutes from './routes/sections.js';
import backupsRoutes from './routes/backups.js';
import containerRoutes from './routes/containers.js';
import backgroundJobsRoutes from './routes/backgroundJobs.js';
import updatesRoutes from './routes/updates.js';
import { ensureMounts, installMountHotplugHandlers, startAutoMountRetry } from './lib/mountsAutoMount.js';
import { cleanPartialJsonArtifacts } from './lib/bootCleanup.js';
import { startUpdateChecker, stopUpdateChecker, start as startUsbMonitor, stop as stopUsbMonitor } from './lib/host/index.js';
import { startUpdateChecker as startWispUpdateChecker, stopUpdateChecker as stopWispUpdateChecker } from './lib/wispUpdate.js';
import { closeAllSSE } from './lib/sse.js';
import { disconnect as disconnectLibvirtBus } from './lib/vmManager.js';
import { start as startDiskMonitor, stop as stopDiskMonitor } from './lib/storage/index.js';
import { connect as connectMdns, disconnect as disconnectMdns, registerAddress, sanitizeHostname } from './lib/mdns/index.js';
import { startVmMdnsPublisher, stopVmMdnsPublisher } from './lib/vmMdnsPublisher.js';
import { startContainerMdnsReconciler, stopContainerMdnsReconciler } from './lib/containerMdnsReconciler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
loadRuntimeEnv(projectRoot);

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
            translateTime: 'HH:MM:ss.l',
            singleLine: true,
            ignore: 'pid,hostname,reqId,req.host,req.remoteAddress,req.remotePort',
          },
        },
      }
    : {}),
};

// trustProxy honors X-Forwarded-Proto / X-Forwarded-For only when the connection
// itself comes from loopback. A TLS-terminating reverse proxy (Caddy/nginx)
// sitting in front lets cookies pick the right `Secure` flag based on the
// browser's actual scheme without trusting headers from arbitrary networks.
const app = Fastify({
  logger: loggerConfig,
  forceCloseConnections: true,
  trustProxy: ['127.0.0.1', '::1'],
});

// In prod the backend also serves the SPA — apply baseline security headers to
// every response. `style-src 'unsafe-inline'` is required because xterm.js and
// noVNC inject inline style attributes; tightening it would need CSP nonces.
// `img-src data:` covers favicons / lucide-react inline data URIs. HSTS is
// intentionally not set — Wisp is often deployed on plain HTTP behind a LAN;
// the operator's reverse proxy enforces HSTS where TLS terminates.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

if (!isDev) {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });
}

// In prod, non-/api / non-/ws 404s serve the SPA shell so client-side routing
// works on deep-link refresh. /api and /ws keep the JSON 404. In dev, vite
// serves the SPA on :5173 and the backend stays a pure JSON API.
app.setNotFoundHandler((request, reply) => {
  if (indexHtml && !request.url.startsWith('/api') && !request.url.startsWith('/ws')) {
    reply.type('text/html').send(indexHtml);
    return;
  }
  request.log.info({ method: request.method, url: redactToken(request.url) }, 'Route not found');
  reply.code(404).send({ error: 'Not Found', detail: `Route ${request.method} ${redactToken(request.url)} not found` });
});

if (isDev) {
  await app.register(cors, { origin: 'http://localhost:5173' });
}

await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

app.addHook('onRequest', createAuthHook());

await app.register(fastifyWebsocket);

app.register(authRoutes, { prefix: '/api/auth' });
app.register(hostRoutes, { prefix: '/api' });
app.register(statsRoutes, { prefix: '/api' });
app.register(libraryRoutes, { prefix: '/api' });
app.register(vmsRoutes, { prefix: '/api' });
app.register(cloudInitRoutes, { prefix: '/api' });
app.register(settingsRoutes, { prefix: '/api' });
app.register(mountsRoutes, { prefix: '/api' });
app.register(sectionsRoutes, { prefix: '/api' });
app.register(backupsRoutes, { prefix: '/api' });
app.register(containerRoutes, { prefix: '/api' });
app.register(backgroundJobsRoutes, { prefix: '/api' });
app.register(updatesRoutes, { prefix: '/api' });
app.register(consoleRoutes, { prefix: '/ws' });
app.register(containerConsoleRoutes, { prefix: '/ws' });

// SPA static serving — only in prod; dev hits vite on :5173. /vendor/* serves
// noVNC. The dist root has wildcard:false so unmatched paths fall through to
// setNotFoundHandler (which returns index.html for client-side routing).
if (!isDev && existsSync(distPath)) {
  await app.register(fastifyStatic, {
    root: publicVendorPath,
    prefix: '/vendor/',
    decorateReply: false,
  });
  await app.register(fastifyStatic, {
    root: distPath,
    wildcard: false,
  });
}

async function start() {
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
  await connectMdns(app.log);

  // Disk monitor must populate its snapshot before ensureMounts can reconcile disk entries.
  startDiskMonitor();

  try {
    await ensureMounts(app.log);
  } catch (err) {
    app.log.warn({ err }, 'Mount auto-mount at startup failed');
  }

  unsubscribeMountHotplug = installMountHotplugHandlers(app.log);
  stopMountRetry = startAutoMountRetry(app.log);

  await startAutostartContainersAtBackendBoot(app.log);

  try {
    const containers = await listContainers();
    for (const c of containers) {
      if (c.state !== 'running') continue;
      const cfg = await getContainerConfig(c.name);
      if (cfg.localDns === true && cfg.network?.ip) {
        await registerAddress(c.name, sanitizeHostname(c.name), cfg.network.ip);
      }
    }
  } catch {
    /* mDNS warm-up is best effort */
  }

  // VM mDNS publisher: subscribes to libvirt lifecycle + AgentEvent, runs an initial
  // reconcile, and keeps a 45s safety-net interval. Replaces the prior coupling that
  // only re-published while a user had a VM's stats SSE open.
  startVmMdnsPublisher(app.log);
  startContainerMdnsReconciler(app.log);

  await app.listen({ port: PORT, host: '0.0.0.0' });

  startUsbMonitor();

  startUpdateChecker(app.log);
  startImageUpdateChecker(app.log);
  startWispUpdateChecker(app.log);
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
  stopVmMdnsPublisher();
  stopContainerMdnsReconciler();
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
