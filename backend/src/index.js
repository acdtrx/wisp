import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';

import { loadRuntimeEnv } from './lib/loadRuntimeEnv.js';
import { createAuthHook } from './lib/auth.js';
import { connect as connectLibvirt } from './lib/vmManager.js';
import { connect as connectContainerd, disconnect as disconnectContainerd } from './lib/containerManager.js';
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
import backupsRoutes from './routes/backups.js';
import containerRoutes from './routes/containers.js';
import backgroundJobsRoutes from './routes/backgroundJobs.js';
import { ensureNetworkMounts } from './lib/networkMountAutoMount.js';
import { startUpdateChecker, stopUpdateChecker } from './lib/aptUpdates.js';
import { closeAllSSE } from './lib/sse.js';
import { disconnect as disconnectLibvirtBus } from './lib/vmManager.js';
import { start as startUsbMonitor, stop as stopUsbMonitor } from './lib/usbMonitor.js';
import { connect as connectMdns, disconnect as disconnectMdns, registerAddress, sanitizeHostname } from './lib/mdnsManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadRuntimeEnv(resolve(__dirname, '..', '..'));

const PORT = parseInt(process.env.WISP_BACKEND_PORT, 10) || 3001;

const app = Fastify({ logger: true, forceCloseConnections: true });

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
app.register(backupsRoutes, { prefix: '/api' });
app.register(containerRoutes, { prefix: '/api' });
app.register(backgroundJobsRoutes, { prefix: '/api' });
app.register(consoleRoutes, { prefix: '/ws' });
app.register(containerConsoleRoutes, { prefix: '/ws' });

async function start() {
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
  await connectMdns();

  try {
    await ensureNetworkMounts(app.log);
  } catch (err) {
    app.log.warn({ err }, 'Network mount auto-mount at startup failed');
  }

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

  await app.listen({ port: PORT, host: '0.0.0.0' });

  startUsbMonitor();

  startUpdateChecker(app.log);
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`Received ${signal}, shutting down`);
  closeAllSSE();
  stopUsbMonitor();
  stopUpdateChecker();
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
