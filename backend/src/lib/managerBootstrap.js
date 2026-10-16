/**
 * vmManager / containerManager wiring shared by the backend (`src/index.js`)
 * and the state-migration runner (`scripts/migrate.mjs`). Both processes must
 * configure and connect the managers identically, or a migration would act on a
 * differently configured host than the app it migrates for.
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
import { tryAcquireContainerOperationLock } from './containerOperationLock.js';

/**
 * Push Wisp paths, the storage-mount resolver and the per-container operation
 * lock (taken by the manager's own restart-policy and autostart starts) into
 * the managers. Call before any
 * manager-internal code runs; after it, vmManager and containerManager have no
 * Wisp-glue dependencies — they read everything from the configure() slots. The
 * resolver is sync: wisp-config.json is small and the OS caches the read.
 */
export function configureManagers() {
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
 * restart policy, no network reconcilers, no list caches. For a process other
 * than the backend (the migration runner): one actor per concern.
 */
export async function connectManagers(log, { watchEvents = true } = {}) {
  try {
    await connectLibvirt(log, { watchEvents });
  } catch (err) {
    log.warn({ err }, 'libvirt connection failed — VM operations will be unavailable');
  }

  try {
    await connectContainerd({ logger: log, watchEvents });
  } catch (err) {
    log.warn({ err }, 'containerd connection failed — container operations will be unavailable');
  }
}

export function disconnectManagers() {
  disconnectLibvirt();
  disconnectContainerd();
}
