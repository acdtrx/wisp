/**
 * Boot-time mount reconciliation and hotplug handlers.
 *
 * Startup: mount configured SMB shares (and any adopted disk that happens to be present),
 * then hard-converge — anything under /mnt/wisp/ not in config gets lazy-unmounted.
 *
 * Hotplug: on disk insertion, auto-mount adopted disks whose UUID appeared.
 * On disk removal, lazy-unmount the stale mountPath so the kernel cleans up.
 */
import { readFile } from 'node:fs/promises';
import { getRawMounts } from './settings.js';
import {
  getMountStatus, mountSMB, unmountSMB,
  mountDisk, unmountDisk,
  getDevices as getDiskDevices,
  onChange as onDiskChange,
  refresh as refreshDiskSnapshot,
} from './storage/index.js';

const WISP_MOUNT_ROOT = '/mnt/wisp';

async function readCurrentWispMounts() {
  try {
    const content = await readFile('/proc/mounts', 'utf8');
    const out = [];
    for (const line of content.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const mount = parts[1];
      if (mount === WISP_MOUNT_ROOT || mount.startsWith(`${WISP_MOUNT_ROOT}/`)) {
        out.push(mount);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Startup reconciliation. Awaited before the HTTP server listens.
 * @param {{ info: Function, warn: Function }} log
 */
export async function ensureMounts(log) {
  const mounts = await getRawMounts();
  const configuredPaths = new Set(mounts.map((d) => d.mountPath));

  const currentWisp = await readCurrentWispMounts();
  for (const mountPath of currentWisp) {
    if (configuredPaths.has(mountPath)) continue;
    try {
      await unmountSMB(mountPath, { lazy: true });
      log.info({ mountPath }, 'Hard-converge: unmounted orphan mount');
    } catch (err) {
      log.warn({ err, mountPath }, 'Hard-converge: failed to unmount orphan');
    }
  }

  const presentDiskUuids = new Set(getDiskDevices().map((d) => d.uuid));

  for (const d of mounts) {
    if (d.autoMount === false) continue;
    if (d.type === 'smb') {
      try {
        const { mounted } = await getMountStatus(d.mountPath);
        if (mounted) continue;
        await mountSMB(d.share, d.mountPath, { username: d.username, password: d.password });
        log.info({ id: d.id, mountPath: d.mountPath }, 'SMB mounted at startup');
      } catch (err) {
        log.warn({ err, id: d.id, mountPath: d.mountPath }, 'SMB auto-mount failed');
      }
    } else if (d.type === 'disk') {
      if (!presentDiskUuids.has(d.uuid)) continue;
      try {
        const { mounted } = await getMountStatus(d.mountPath);
        if (mounted) continue;
        await mountDisk(d.uuid, d.mountPath, { fsType: d.fsType, readOnly: d.readOnly });
        log.info({ id: d.id, mountPath: d.mountPath, uuid: d.uuid }, 'Disk mounted at startup');
        refreshDiskSnapshot();
      } catch (err) {
        log.warn({ err, id: d.id, mountPath: d.mountPath, uuid: d.uuid }, 'Disk auto-mount failed');
      }
    }
  }
}

/**
 * Periodic auto-mount retry. `ensureMounts` runs once at boot and gives up on
 * failures (logs and moves on). For long-lived backends, configured mounts
 * that failed at boot (e.g. SMB server unreachable, NIC not yet up) should
 * keep being attempted in the background — without that, the operator has to
 * notice and click Mount manually. Returns a stop function for shutdown.
 *
 * Cadence: 5 minutes. Disks are skipped here — diskMonitor's hotplug handlers
 * (`installMountHotplugHandlers`) already react to insertion events, so an
 * idle disk poll wouldn't change anything.
 *
 * @param {{ info: Function, warn: Function }} log
 */
const AUTO_MOUNT_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export function startAutoMountRetry(log) {
  const tick = async () => {
    let mounts;
    try {
      mounts = await getRawMounts();
    } catch (err) {
      log.warn({ err }, 'Auto-mount retry: could not read settings');
      return;
    }
    for (const d of mounts) {
      if (d.autoMount === false) continue;
      if (d.type !== 'smb') continue;
      try {
        const { mounted } = await getMountStatus(d.mountPath);
        if (mounted) continue;
        await mountSMB(d.share, d.mountPath, { username: d.username, password: d.password });
        log.info({ id: d.id, mountPath: d.mountPath }, 'SMB mounted on retry');
      } catch (err) {
        /* swallow — next tick will retry */
        log.warn({ err: err.message, id: d.id }, 'SMB auto-mount retry failed');
      }
    }
  };

  const interval = setInterval(tick, AUTO_MOUNT_RETRY_INTERVAL_MS);
  interval.unref();
  return () => clearInterval(interval);
}

/**
 * Subscribe to diskMonitor for hotplug events. Returns an unsubscribe fn.
 * @param {{ info: Function, warn: Function }} log
 */
export function installMountHotplugHandlers(log) {
  let lastUuids = new Set(getDiskDevices().map((d) => d.uuid));

  return onDiskChange(async () => {
    const current = getDiskDevices();
    const currentUuids = new Set(current.map((d) => d.uuid));
    const appeared = [...currentUuids].filter((u) => !lastUuids.has(u));
    const disappeared = [...lastUuids].filter((u) => !currentUuids.has(u));
    lastUuids = currentUuids;

    if (appeared.length === 0 && disappeared.length === 0) return;

    let configured;
    try {
      configured = await getRawMounts();
    } catch (err) {
      log.warn({ err }, 'Could not read mount settings during hotplug');
      return;
    }
    const diskConfig = configured.filter((m) => m.type === 'disk');

    for (const uuid of appeared) {
      const cfg = diskConfig.find((m) => m.uuid === uuid);
      if (!cfg) continue;
      if (cfg.autoMount === false) continue;
      try {
        const { mounted } = await getMountStatus(cfg.mountPath);
        if (mounted) continue;
        await mountDisk(uuid, cfg.mountPath, { fsType: cfg.fsType, readOnly: cfg.readOnly });
        log.info({ uuid, mountPath: cfg.mountPath }, 'Disk auto-mounted on insertion');
        refreshDiskSnapshot();
      } catch (err) {
        log.warn({ err, uuid, mountPath: cfg.mountPath }, 'Disk auto-mount on insertion failed');
      }
    }

    for (const uuid of disappeared) {
      const cfg = diskConfig.find((m) => m.uuid === uuid);
      if (!cfg) continue;
      try {
        await unmountDisk(cfg.mountPath, { lazy: true });
        log.info({ uuid, mountPath: cfg.mountPath }, 'Disk lazy-unmounted after removal');
      } catch (err) {
        log.warn({ err, uuid, mountPath: cfg.mountPath }, 'Disk lazy-unmount on removal failed');
      }
    }
  });
}
