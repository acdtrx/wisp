import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
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
import backupsRoutes from './routes/backups.js';
import containerRoutes from './routes/containers.js';
import backgroundJobsRoutes from './routes/backgroundJobs.js';
import { ensureMounts, installMountHotplugHandlers } from './lib/mountsAutoMount.js';
import { cleanPartialJsonArtifacts } from './lib/bootCleanup.js';
import { startUpdateChecker, stopUpdateChecker } from './lib/aptUpdates.js';
import { closeAllSSE } from './lib/sse.js';
import { disconnect as disconnectLibvirtBus } from './lib/vmManager.js';
import { start as startUsbMonitor, stop as stopUsbMonitor } from './lib/usbMonitor.js';
import { start as startDiskMonitor, stop as stopDiskMonitor } from './lib/diskMonitor.js';
import { connect as connectMdns, disconnect as disconnectMdns, registerAddress, sanitizeHostname } from './lib/mdnsManager.js';
import { startVmMdnsPublisher, stopVmMdnsPublisher } from './lib/vmMdnsPublisher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadRuntimeEnv(resolve(__dirname, '..', '..'));

const PORT = parseInt(process.env.WISP_BACKEND_PORT, 10) || 3001;

const isDev = process.env.NODE_ENV === 'development';

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

const app = Fastify({ logger: loggerConfig, forceCloseConnections: true });

app.setNotFoundHandler((request, reply) => {
  request.log.info({ method: request.method, url: redactToken(request.url) }, 'Route not found');
  reply.code(404).send({ error: 'Not Found', detail: `Route ${request.method} ${redactToken(request.url)} not found` });
});

if (process.env.NODE_ENV === 'development') {
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
app.register(backupsRoutes, { prefix: '/api' });
app.register(containerRoutes, { prefix: '/api' });
app.register(backgroundJobsRoutes, { prefix: '/api' });
app.register(consoleRoutes, { prefix: '/ws' });
app.register(containerConsoleRoutes, { prefix: '/ws' });

async function start() {
  await cleanPartialJsonArtifacts(app.log);

  try {
    await connectLibvirt();
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

  await app.listen({ port: PORT, host: '0.0.0.0' });

  startUsbMonitor();

  startUpdateChecker(app.log);
  startImageUpdateChecker(app.log);
}

let shuttingDown = false;
let unsubscribeMountHotplug = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}, shutting down`);
  closeAllSSE();
  if (unsubscribeMountHotplug) {
    try { unsubscribeMountHotplug(); } catch { /* no-op */ }
    unsubscribeMountHotplug = null;
  }
  stopUsbMonitor();
  stopDiskMonitor();
  stopUpdateChecker();
  stopImageUpdateChecker();
  stopVmMdnsPublisher();
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
  console.error('Failed to start:', err);
  process.exit(1);
});
