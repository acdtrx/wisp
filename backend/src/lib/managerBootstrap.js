/**
 * vmManager / containerManager wiring shared by the backend's normal work
 * (`src/index.js`) and its start-time migrations (`lib/stateMigrations.js`).
 * Both configure and connect the managers identically, or a migration would
 * act on a differently configured host than the app it migrates for.
 */
import { getConfigSync } from './config.js';
import {
  configure as configureVmManager,
  connect as connectLibvirt,
  disconnect as disconnectLibvirt,
} from './vmManager/index.js';
import {
  configure as configureContainerManager,
  connect as connectContainerd,
  disconnect as disconnectContainerd,
} from './containerManager/index.js';
import { configure as configureHost } from './host/index.js';
import { configure as configureStorage } from './storage/index.js';
import { configure as configureNetworking } from './networking/index.js';
import { configure as configureMdns } from './mdns/index.js';
import { tryAcquireContainerOperationLock } from './containerOperationLock.js';

/**
 * Push the start's logger into every fenced module (the managers, host,
 * storage, networking, mdns), and Wisp paths, the storage-mount resolver and
 * the per-container operation lock (taken by the manager's own restart-policy
 * and autostart starts) into the managers. Call before any
 * manager-internal code runs; after it, vmManager and containerManager have no
 * Wisp-glue dependencies — they read everything from the configure() slots. The
 * resolver is sync: wisp-config.json is small and the OS caches the read.
 * `getConfig` reads the config: the strict `getConfigSync` for normal work; the
 * migrations pass the tolerant reader (migrations/lib/tolerantConfig.js), since
 * they run before migration 0007 has repaired what older releases wrote.
 */
export function configureManagers({ getConfig = getConfigSync, logger } = {}) {
  const cfg = getConfig();
  configureHost({ logger });
  configureStorage({ logger });
  configureNetworking({ logger });
  configureMdns({ logger });
  configureVmManager({ vmsPath: cfg.vmsPath, logger });
  configureContainerManager({
    logger,
    containersPath: cfg.containersPath,
    resolveMount: (id) => {
      if (typeof id !== 'string' || !id) return null;
      const mounts = getConfig().mounts || [];
      const m = mounts.find((x) => x && x.id === id);
      return m ? { id: m.id, mountPath: m.mountPath, label: m.label } : null;
    },
    tryAcquireOperationLock: tryAcquireContainerOperationLock,
  });
}

/**
 * Connect to libvirt and containerd. A failed connection is logged and left
 * down rather than thrown: each manager's operations then report the missing
 * connection themselves, and one unreachable daemon doesn't take the other
 * manager's operations down with it.
 *
 * `watchEvents: false` connects without the managers' event-driven machinery —
 * no libvirt DomainEvent / containerd events subscription, so no container
 * restart policy, no network reconciler, no list caches, and none of the
 * event-driven writes (clearing outgrown restart-required flags, the network
 * probe). For the migrations, before the start connects for normal work: one
 * actor per concern, and every write they make is one they record.
 * Reads never write, in either mode.
 */
export async function connectManagers(log, { watchEvents = true } = {}) {
  try {
    await connectLibvirt({ watchEvents });
  } catch (err) {
    log.warn({ err }, watchEvents
      ? 'libvirt connection failed — retrying; VM operations unavailable until it connects'
      : 'libvirt connection failed — VM operations unavailable');
  }

  try {
    await connectContainerd({ watchEvents });
  } catch (err) {
    log.warn({ err }, 'containerd connection failed — container operations will be unavailable');
  }
}

export function disconnectManagers() {
  disconnectLibvirt();
  disconnectContainerd();
}
