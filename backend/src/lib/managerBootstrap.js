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

/**
 * Push Wisp paths + storage-mount resolver into the managers. Call before any
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
  });
}

/**
 * Connect to libvirt and containerd. A failed connection is logged and left
 * down rather than thrown: each manager's operations then report the missing
 * connection themselves, and one unreachable daemon doesn't take the other
 * manager's operations down with it.
 */
export async function connectManagers(log) {
  try {
    await connectLibvirt(log);
  } catch (err) {
    log.warn({ err }, 'libvirt connection failed — VM operations will be unavailable');
  }

  try {
    await connectContainerd({ logger: log });
  } catch (err) {
    log.warn({ err }, 'containerd connection failed — container operations will be unavailable');
  }
}

export function disconnectManagers() {
  disconnectLibvirt();
  disconnectContainerd();
}
