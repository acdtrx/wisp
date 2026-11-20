import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

// First project import: runtime.env must be in process.env before config.js loads.
import './lib/bootRuntimeEnv.js';
import { buildApp } from './app.js';
import { checkRouteAccess, AUTH_LEVELS, checkPasswordFile } from './lib/auth.js';
import { createAppError } from './lib/appErrors.js';
import { getConfigSync } from './lib/config.js';
import { configureManagers, connectManagers, disconnectManagers } from './lib/managerBootstrap.js';
import { checkRuntimeEnvFile } from './lib/loadRuntimeEnv.js';
import { migrateState } from './lib/stateMigrations.js';
import { notifySystemdReady, takeNotifySocket } from './lib/systemdReady.js';
import { DEV_LOG_TRANSPORT } from './lib/logFormat.js';
import { startImageUpdateChecker, stopImageUpdateChecker } from './lib/containerManager/index.js';
import {
  startAutostartContainersAtBackendBoot,
  resumeStalePausedContainersAtBackendBoot,
} from './lib/containerManager/index.js';
import {
  startContainerBackupScheduler,
  stopContainerBackupScheduler,
} from './lib/containerBackupScheduler.js';
import { ensureMounts, installMountHotplugHandlers, startAutoMountRetry } from './lib/mountsAutoMount.js';
import { cleanPartialJsonArtifacts } from './lib/bootCleanup.js';
import { startUpdateChecker, stopUpdateChecker, start as startUsbMonitor, stop as stopUsbMonitor } from './lib/host/index.js';
import { startUpdateChecker as startWispUpdateChecker, stopUpdateChecker as stopWispUpdateChecker } from './lib/wispUpdate.js';
import { closeAllSSE } from './lib/sse.js';
import { start as startDiskMonitor, stop as stopDiskMonitor } from './lib/storage/index.js';
import { connect as connectMdns, disconnect as disconnectMdns } from './lib/mdns/index.js';
import { checkDefaultBridgeOverride, getDefaultContainerParentBridge } from './lib/networking/index.js';
import { startVmMdnsReconciler, stopVmMdnsReconciler } from './lib/vmMdnsReconciler.js';
import { startContainerMdnsReconciler, stopContainerMdnsReconciler } from './lib/containerMdnsReconciler.js';
import { startWispDiscovery, stopWispDiscovery } from './lib/wispDiscovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

const PORT = process.env.WISP_PORT ? Number(process.env.WISP_PORT) : 8080;

const isDev = process.env.NODE_ENV === 'development';

const loggerConfig = {
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      };
    },
  },
  ...(isDev
    ? {
        transport: DEV_LOG_TRANSPORT,
      }
    : {}),
};

/* pino is Fastify's dependency, not the backend's: the start takes its logger
   from a Fastify instance that never listens, so the migrations log exactly as
   the app does, and the app is handed the same logger. */
function createStartLogger() {
  return Fastify({ logger: loggerConfig }).log;
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

/**
 * The checks stored state must pass once the migrations have run (CODING-RULES
 * §4): runtime.env strictly, retired keys included; wisp-config.json through
 * the strict schema; the password file; WISP_DEFAULT_BRIDGE naming a host
 * bridge. Throws the first problem, naming it.
 */
async function checkStoredConfig() {
  checkRuntimeEnvFile(projectRoot);
  getConfigSync();
  checkPasswordFile();
  const bridgeProblem = await checkDefaultBridgeOverride();
  if (bridgeProblem) throw createAppError('DEFAULT_BRIDGE_INVALID', bridgeProblem);
}

/** Set once the app is built; until then a signal has nothing to close. */
let app = null;

/**
 * The start, in order (docs/ARCHITECTURE.md, Run shape). No module reads stored
 * state or connects when it loads, so nothing has read it before this runs:
 * migrations first, then the strict checks, then the managers, the app and the
 * boot work, and the port opens last.
 */
async function main() {
  takeNotifySocket();
  const log = createStartLogger();

  // `npm run route-access`: every route with the level the auth hook enforces
  // for it, then exit without migrating, connecting or listening.
  if (process.env.WISP_ROUTE_ACCESS_REPORT === '1') {
    configureManagers();
    const { routeAccess } = await buildApp(log);
    process.exit(printRouteAccessReport(routeAccess.list()));
  }

  await migrateState(log);
  await checkStoredConfig();
  // Before any route registers or any manager-internal code runs
  // (lib/managerBootstrap.js), now with the strict config.
  configureManagers();

  const built = await buildApp(log);
  app = built.app;
  // Development refuses to boot on a route without an access declaration;
  // production enforces it as admin.
  checkRouteAccess(built.routeAccess.list(), { strict: isDev, log: app.log });

  await cleanPartialJsonArtifacts(app.log);

  await connectManagers(app.log);
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

  // Production serves the LAN; the dev backend is reached only through the
  // local Vite proxy, so it listens on loopback alone.
  await app.listen({ port: PORT, host: isDev ? '127.0.0.1' : '0.0.0.0' });
  if (await notifySystemdReady()) app.log.info('ready: told systemd');

  startUsbMonitor();

  startUpdateChecker(app.log);
  startImageUpdateChecker(app.log);
  startWispUpdateChecker(app.log);
  startContainerBackupScheduler(app.log);
}

/* Below wisp.service's TimeoutStopSec (15 s), so a hung step ends in our own
   logged exit rather than systemd's SIGKILL. */
const SHUTDOWN_DEADLINE_MS = 10_000;

let shuttingDown = false;
let unsubscribeMountHotplug = null;
let stopMountRetry = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!app) {
    // Still migrating or checking: the process exits, and the migrations'
    // libvirt and containerd connections close with it. A migration cut short
    // runs again on the next start, whole: its ledger entry is written when it ends.
    console.error(`Received ${signal} before the server was up, exiting`);
    process.exit(0);
  }
  app.log.info(`Received ${signal}, shutting down`);
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_DEADLINE_MS / 1000} s, exiting`);
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
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
  disconnectManagers();
  await disconnectMdns();
  if (typeof app.server.closeAllConnections === 'function') {
    app.server.closeAllConnections();
  }
  await app.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* stderr rather than app.log: the dev log transport runs on a worker thread
   that may not flush before the exit. systemd restarts the unit on failure. */
function exitOnFatal(kind, err) {
  console.error(`${kind}:`, err);
  process.exit(1);
}
process.on('unhandledRejection', (err) => exitOnFatal('Unhandled rejection', err));
process.on('uncaughtException', (err) => exitOnFatal('Uncaught exception', err));

/** The start's own expected failures: one line naming the problem. */
const START_FAILURE_CODES = new Set([
  'RUNTIME_ENV_INVALID', 'CONFIG_INVALID', 'PASSWORD_FILE_UNREADABLE', 'PASSWORD_FILE_UNSUPPORTED_FORMAT',
  'DEFAULT_BRIDGE_INVALID', 'MIGRATION_SETUP', 'MIGRATION_FAILED', 'SYSTEMD_NOTIFY_FAILED',
  'DNS_FORWARDER_UNAVAILABLE',
]);

main().catch((err) => {
  // Fastify's logger may not have flushed by the time we exit, so use stderr
  // directly to ensure the message reaches journald.
  if (START_FAILURE_CODES.has(err?.code)) console.error(`Failed to start: ${err.message}`);
  else console.error('Failed to start:', err);
  process.exit(1);
});
