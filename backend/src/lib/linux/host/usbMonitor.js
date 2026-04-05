/**
 * Host USB enumeration from sysfs + hotplug detection via fs.watch on /dev/bus/usb.
 * No lsusb / usbutils dependency.
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  watch as fsWatch,
} from 'node:fs';
import { join } from 'node:path';

const SYSFS_USB_DEVICES = '/sys/bus/usb/devices';
const DEV_BUS_USB = '/dev/bus/usb';
const USB_IDS_PATHS = ['/usr/share/hwdata/usb.ids', '/usr/share/misc/usb.ids'];

const DEBOUNCE_MS = 300;

/** @type { Array<{ bus: string, device: string, vendorId: string, productId: string, name: string }> | null } */
let cache = null;

/** @type { Map<string, string> | null } */
let hwdataVendors = null;

/** @type { Map<string, string> | null } */
let hwdataProducts = null;

/** @type { ReturnType<typeof fsWatch>[] } */
const watchers = [];

/** @type { Set<string> } */
const watchedBusDirs = new Set();

/** @type { Set<() => void> } */
const changeListeners = new Set();

let debounceTimer = null;
let started = false;

/**
 * Read optional sysfs file; trim; empty string if missing.
 * @param {string} base
 * @param {string} name
 */
function readSysfsFile(base, name) {
  try {
    const p = join(base, name);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadHwdataMaps() {
  if (hwdataVendors != null) return;

  hwdataVendors = new Map();
  hwdataProducts = new Map();

  let path = null;
  for (const p of USB_IDS_PATHS) {
    if (existsSync(p)) {
      path = p;
      break;
    }
  }
  if (!path) {
    /* usb.ids missing — names fall back to sysfs strings only */
    return;
  }

  try {
    const text = readFileSync(path, 'utf8');
    let currentVendor = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const vendorMatch = line.match(/^([0-9a-fA-F]{4})\s+(.+)$/);
      if (vendorMatch && !line.startsWith('\t')) {
        currentVendor = vendorMatch[1].toLowerCase();
        hwdataVendors.set(currentVendor, vendorMatch[2].trim());
        continue;
      }
      const productMatch = line.match(/^\t([0-9a-fA-F]{4})\s+(.+)$/);
      if (productMatch && currentVendor) {
        const pid = productMatch[1].toLowerCase();
        hwdataProducts.set(`${currentVendor}:${pid}`, productMatch[2].trim());
      }
    }
  } catch {
    /* parse failed — leave maps empty-ish */
  }
}

/**
 * @param {string} vendorId
 * @param {string} productId
 * @param {string} manufacturer
 * @param {string} product
 */
function resolveDeviceName(vendorId, productId, manufacturer, product) {
  const vid = vendorId.toLowerCase();
  const pid = productId.toLowerCase();

  if (product) return product;
  loadHwdataMaps();
  const combo = hwdataProducts?.get(`${vid}:${pid}`);
  if (combo) return combo;
  const vendorName = hwdataVendors?.get(vid);
  if (vendorName) return `${vendorName} Device`;
  if (manufacturer) return manufacturer;
  return 'Unknown Device';
}

/**
 * Enumerate USB devices from sysfs (synchronous).
 * @returns { Array<{ bus: string, device: string, vendorId: string, productId: string, name: string }> }
 */
function enumerateFromSysfs() {
  const out = [];
  let entries;
  try {
    entries = readdirSync(SYSFS_USB_DEVICES);
  } catch {
    return [];
  }

  loadHwdataMaps();

  for (const entry of entries) {
    const base = join(SYSFS_USB_DEVICES, entry);
    const vendorId = readSysfsFile(base, 'idVendor').toLowerCase();
    const productId = readSysfsFile(base, 'idProduct').toLowerCase();
    if (!vendorId || !productId || vendorId.length !== 4 || productId.length !== 4) {
      continue;
    }

    const busRaw = readSysfsFile(base, 'busnum');
    const devRaw = readSysfsFile(base, 'devnum');
    if (!busRaw || !devRaw) continue;

    const bus = String(parseInt(busRaw, 10)).padStart(3, '0');
    const device = String(parseInt(devRaw, 10)).padStart(3, '0');

    const manufacturer = readSysfsFile(base, 'manufacturer');
    const product = readSysfsFile(base, 'product');
    const name = resolveDeviceName(vendorId, productId, manufacturer, product);

    out.push({
      bus,
      device,
      vendorId,
      productId,
      name,
    });
  }

  out.sort((a, b) => {
    const busCmp = a.bus.localeCompare(b.bus, undefined, { numeric: true });
    if (busCmp !== 0) return busCmp;
    return a.device.localeCompare(b.device, undefined, { numeric: true });
  });

  return out;
}

function deviceListKey(devices) {
  return devices.map((d) => `${d.bus}:${d.device}:${d.vendorId}:${d.productId}`).join('|');
}

function notifyIfChanged() {
  const next = enumerateFromSysfs();
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

function closeAllWatchers() {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  watchers.length = 0;
  watchedBusDirs.clear();
}

/**
 * Watch one directory; on any event, schedule sysfs re-enumeration.
 * @param {string} dir
 * @param {boolean} [alsoRescanBuses] — when true (parent /dev/bus/usb), pick up new bus subdirs
 */
function watchDir(dir, alsoRescanBuses = false) {
  if (!existsSync(dir)) return;
  try {
    const w = fsWatch(dir, { persistent: true }, () => {
      if (alsoRescanBuses) {
        watchNewBusSubdirsOnly();
      }
      scheduleRefresh();
    });
    watchers.push(w);
  } catch {
    /* watch failed — hotplug updates may be missed */
  }
}

/**
 * Add fs.watch for each numeric subdirectory under /dev/bus/usb not yet watched.
 */
function watchNewBusSubdirsOnly() {
  if (!existsSync(DEV_BUS_USB)) return;
  try {
    const entries = readdirSync(DEV_BUS_USB);
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const full = join(DEV_BUS_USB, name);
      if (watchedBusDirs.has(full)) continue;
      watchedBusDirs.add(full);
      watchDir(full, false);
    }
  } catch {
    /* cannot list bus usb */
  }
}

/**
 * Attach fs.watch to /dev/bus/usb (new buses) and each bus subdirectory (e.g. 001, 002).
 */
function attachBusWatchers() {
  closeAllWatchers();

  if (!existsSync(DEV_BUS_USB)) return;

  watchDir(DEV_BUS_USB, true);

  try {
    const entries = readdirSync(DEV_BUS_USB);
    for (const name of entries) {
      if (/^\d+$/.test(name)) {
        const full = join(DEV_BUS_USB, name);
        watchedBusDirs.add(full);
        watchDir(full, false);
      }
    }
  } catch {
    /* cannot list bus usb */
  }
}

/**
 * Start monitoring. Safe to call once at server boot. Idempotent.
 */
export function start() {
  if (started) return;
  started = true;

  cache = enumerateFromSysfs();
  attachBusWatchers();
}

/**
 * Stop all watchers (shutdown).
 */
export function stop() {
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  closeAllWatchers();
  started = false;
}

/**
 * Current device list (copy). Lazy-enumerates on first call if start() has not run.
 */
export function getDevices() {
  if (cache === null) {
    cache = enumerateFromSysfs();
  }
  return cache.map((d) => ({ ...d }));
}

/**
 * @param {() => void} callback
 * @returns {() => void} unsubscribe
 */
export function onChange(callback) {
  changeListeners.add(callback);
  return () => {
    changeListeners.delete(callback);
  };
}
