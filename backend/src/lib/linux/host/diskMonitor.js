/**
 * Removable/fixed block-device enumeration from sysfs + udev metadata + /proc/mounts.
 * Hotplug detection via fs.watch on /dev/disk/by-uuid/.
 *
 * No libudev / UDisks2 dependency — parses /run/udev/data/b<maj>:<min> directly.
 */
import {
  readFileSync,
  readlinkSync,
  readdirSync,
  existsSync,
  watch as fsWatch,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';

const BY_UUID_DIR = '/dev/disk/by-uuid';
const SYS_CLASS_BLOCK = '/sys/class/block';
const UDEV_DATA_DIR = '/run/udev/data';
const PROC_MOUNTS = '/proc/mounts';

const DEBOUNCE_MS = 300;
/** Catches mount/unmount that happens outside Wisp (shell, udev, hook). fs.watch on /dev/disk/by-uuid
 *  only fires on device add/remove, not on /proc/mounts changes — so poll the mount table. */
const MOUNT_POLL_MS = 3000;

const IGNORED_FSTYPES = new Set([
  'crypto_LUKS',
  'linux_raid_member',
  'LVM2_member',
  'zfs_member',
  'swap',
]);

/** @type { Array<import('./diskMonitor.types.js').DetectedDisk> | null } */
let cache = null;

/** @type { ReturnType<typeof fsWatch> | null } */
let uuidWatcher = null;

/** @type { Set<() => void> } */
const changeListeners = new Set();

let debounceTimer = null;
let mountPollTimer = null;
let started = false;

function readSysfsFile(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Parse a udev database file (/run/udev/data/b<maj>:<min>).
 * Returns the E: key/value map as a plain object.
 */
function parseUdevData(path) {
  const out = {};
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('E:')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(2, eq).trim();
    const value = line.slice(eq + 1);
    out[key] = value;
  }
  return out;
}

/** Read `/proc/mounts` once per snapshot and index by device path. */
function readMountsByDevice() {
  const map = new Map();
  let text;
  try {
    text = readFileSync(PROC_MOUNTS, 'utf8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const dev = parts[0];
    const at = parts[1];
    if (!dev.startsWith('/dev/')) continue;
    if (!map.has(dev)) map.set(dev, at);
  }
  return map;
}

/**
 * Return `{ partName, sysfsRel }` for a UUID, or null if unresolvable.
 * UUIDs whose /dev target isn't a block device in sysfs are skipped.
 */
function resolveUuidTarget(uuid) {
  let link;
  try {
    link = readlinkSync(join(BY_UUID_DIR, uuid));
  } catch {
    return null;
  }
  const partName = basename(link);
  if (!partName) return null;
  const sysfsBlock = join(SYS_CLASS_BLOCK, partName);
  if (!existsSync(sysfsBlock)) return null;
  return { partName, sysfsBlock };
}

/**
 * Identify the parent disk sysfs name from a partition sysfs entry.
 * Returns null when the block device is a whole disk (no partition).
 */
function parentDiskName(partName) {
  try {
    const sysfsLink = readlinkSync(join(SYS_CLASS_BLOCK, partName));
    const parent = basename(dirname(sysfsLink));
    if (!parent || parent === 'block') return null;
    return parent;
  } catch {
    return null;
  }
}

function deviceListKey(devices) {
  return devices
    .map(
      (d) =>
        `${d.uuid}|${d.devPath}|${d.fsType}|${d.label}|${d.sizeBytes}|${d.removable ? 1 : 0}|${d.mountedAt || ''}`,
    )
    .join('||');
}

function enumerateDisks() {
  const out = [];
  let uuids;
  try {
    uuids = readdirSync(BY_UUID_DIR);
  } catch {
    return out;
  }
  const mountsByDevice = readMountsByDevice();

  for (const uuid of uuids) {
    const resolved = resolveUuidTarget(uuid);
    if (!resolved) continue;
    const { partName, sysfsBlock } = resolved;
    const devPath = `/dev/${partName}`;

    const devStr = readSysfsFile(join(sysfsBlock, 'dev'));
    if (!devStr.includes(':')) continue;
    const [maj, min] = devStr.split(':');

    const udev = parseUdevData(join(UDEV_DATA_DIR, `b${maj}:${min}`));
    const fsType = (udev.ID_FS_TYPE || '').trim();
    if (!fsType) continue;
    if (IGNORED_FSTYPES.has(fsType)) continue;

    const parent = parentDiskName(partName);
    const parentSysfs = parent ? join(SYS_CLASS_BLOCK, parent) : sysfsBlock;

    const removable = readSysfsFile(join(parentSysfs, 'removable')) === '1';
    const sizeSectors = Number.parseInt(readSysfsFile(join(sysfsBlock, 'size')), 10);
    const sizeBytes = Number.isFinite(sizeSectors) ? sizeSectors * 512 : 0;

    const vendor = readSysfsFile(join(parentSysfs, 'device', 'vendor'));
    const model = readSysfsFile(join(parentSysfs, 'device', 'model'));
    const label = (udev.ID_FS_LABEL || '').trim();

    const mountedAt = mountsByDevice.get(devPath) || null;

    out.push({
      uuid,
      devPath,
      fsType,
      label,
      sizeBytes,
      removable,
      vendor,
      model,
      mountedAt,
    });
  }

  out.sort((a, b) => a.uuid.localeCompare(b.uuid));
  return out;
}

function notifyIfChanged() {
  const next = enumerateDisks();
  const prevKey = cache != null ? deviceListKey(cache) : null;
  const nextKey = deviceListKey(next);
  if (prevKey === nextKey) return;

  cache = next;
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      /* listener threw — ignore */
    }
  }
}

function scheduleRefresh() {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    notifyIfChanged();
  }, DEBOUNCE_MS);
}

function attachUuidWatcher() {
  if (uuidWatcher) return;
  if (!existsSync(BY_UUID_DIR)) return;
  try {
    uuidWatcher = fsWatch(BY_UUID_DIR, { persistent: true }, () => scheduleRefresh());
  } catch {
    /* watch failed — hotplug updates may be missed */
  }
}

function closeWatcher() {
  if (uuidWatcher) {
    try {
      uuidWatcher.close();
    } catch {
      /* already closed */
    }
    uuidWatcher = null;
  }
}

/**
 * Start monitoring. Safe to call once at server boot. Idempotent.
 */
export function start() {
  if (started) return;
  started = true;
  cache = enumerateDisks();
  attachUuidWatcher();
  mountPollTimer = setInterval(notifyIfChanged, MOUNT_POLL_MS);
  mountPollTimer.unref?.();
}

/**
 * Stop watchers (shutdown).
 */
export function stop() {
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (mountPollTimer != null) {
    clearInterval(mountPollTimer);
    mountPollTimer = null;
  }
  closeWatcher();
  started = false;
}

/**
 * Current snapshot (copy). Lazy-enumerates on first call if start() has not run.
 */
export function getDevices() {
  if (cache === null) cache = enumerateDisks();
  return cache.map((d) => ({ ...d }));
}

/**
 * Force an immediate re-enumeration + notify (use after Wisp performs a mount/unmount so
 * listeners see the new mountedAt without waiting for a kernel event).
 */
export function refresh() {
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  notifyIfChanged();
}

/**
 * @param {() => void} callback
 * @returns {() => void} unsubscribe
 */
export function onChange(callback) {
  changeListeners.add(callback);
  return () => changeListeners.delete(callback);
}
