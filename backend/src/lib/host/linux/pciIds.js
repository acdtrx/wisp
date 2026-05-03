/**
 * Parse system pci.ids (or pci.ids.gz) for vendor, device, and class name lookups.
 * No CLI — reads files only. Cached after first successful load.
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const PCI_IDS_CANDIDATES = [
  '/usr/share/misc/pci.ids',
  '/usr/share/hwdata/pci.ids',
  '/usr/share/pci.ids',
  '/usr/share/misc/pci.ids.gz',
  '/usr/share/hwdata/pci.ids.gz',
];

/** @type {{ vendors: Map<string, string>, devices: Map<string, string>, classes: Map<string, string> } | null} */
let cache = null;

/** Base class (first byte) fallback when pci.ids has no class section or no match */
const BASE_CLASS_FALLBACK = {
  '00': 'Unclassified device',
  '01': 'Mass storage controller',
  '02': 'Network controller',
  '03': 'Display controller',
  '04': 'Multimedia controller',
  '05': 'Memory controller',
  '06': 'Bridge',
  '07': 'Communication controller',
  '08': 'System peripheral',
  '09': 'Input device',
  '0a': 'Docking station',
  '0b': 'Processor',
  '0c': 'Serial bus controller',
  '0d': 'Wireless controller',
  '0e': 'Intelligent I/O controller',
  '0f': 'Satellite controller',
  '10': 'Encryption controller',
  '11': 'Signal processing controller',
  '12': 'Processing accelerators',
  '13': 'Non-essential instrumentation',
  'ff': 'Unassigned class',
};

function loadPciIdsContent() {
  for (const p of PCI_IDS_CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      const buf = readFileSync(p);
      if (p.endsWith('.gz')) {
        return gunzipSync(buf).toString('utf-8');
      }
      return buf.toString('utf-8');
    } catch {
      /* try next path */
    }
  }
  return null;
}

/**
 * @param {string} content
 * @returns {{ vendors: Map<string, string>, devices: Map<string, string>, classes: Map<string, string> }}
 */
function parsePciIds(content) {
  const vendors = new Map();
  const devices = new Map();
  const classes = new Map();

  let currentVendor = null;
  let inClassSection = false;

  /** @type {{ base: string, sub: string | null } | null} */
  let classCtx = null;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('C ')) {
      inClassSection = true;
      const cMatch = line.match(/^C\s+([0-9a-fA-F]{2})\s+(.+)$/);
      if (cMatch) {
        const base = cMatch[1].toLowerCase();
        classes.set(base, cMatch[2].trim());
        classCtx = { base, sub: null };
      }
      continue;
    }

    if (inClassSection) {
      const subMatch = line.match(/^\t([0-9a-fA-F]{2})\s+(.+)$/);
      if (subMatch && classCtx) {
        const sub = subMatch[1].toLowerCase();
        classCtx.sub = sub;
        classes.set(`${classCtx.base}${sub}`, subMatch[2].trim());
        continue;
      }
      const progMatch = line.match(/^\t\t([0-9a-fA-F]{2})\s+(.+)$/);
      if (progMatch && classCtx && classCtx.sub != null) {
        const prog = progMatch[1].toLowerCase();
        const fullKey = `${classCtx.base}${classCtx.sub}${prog}`;
        classes.set(fullKey, progMatch[2].trim());
        continue;
      }
      continue;
    }

    const vendorMatch = line.match(/^([0-9a-fA-F]{4})\s+(.+)$/);
    if (vendorMatch) {
      currentVendor = vendorMatch[1].toLowerCase();
      vendors.set(currentVendor, vendorMatch[2].trim());
      continue;
    }

    const devMatch = line.match(/^\t([0-9a-fA-F]{4})\s+(.+)$/);
    if (devMatch && currentVendor) {
      const devId = devMatch[1].toLowerCase();
      devices.set(`${currentVendor}:${devId}`, devMatch[2].trim());
      continue;
    }

    /* subsystem lines: two tabs — skip */
  }

  return { vendors, devices, classes };
}

function ensureLoaded() {
  if (cache) return cache;
  const content = loadPciIdsContent();
  if (!content) {
    cache = { vendors: new Map(), devices: new Map(), classes: new Map() };
    return cache;
  }
  cache = parsePciIds(content);
  return cache;
}

function normalizeHex4(raw) {
  const s = String(raw).trim().toLowerCase().replace(/^0x/, '');
  const n = parseInt(s, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n.toString(16).padStart(4, '0');
}

/**
 * sysfs class is 0xCCSSPP (24-bit). Returns 6 lowercase hex chars.
 * @param {string} raw
 */
export function normalizePciClassHex(raw) {
  const s = String(raw).trim().toLowerCase().replace(/^0x/, '');
  const n = parseInt(s, 16);
  if (!Number.isFinite(n) || n < 0) return '000000';
  return (n & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * @param {string} vendorRaw
 * @param {string} deviceRaw
 * @returns {string | null}
 */
export function lookupDeviceName(vendorRaw, deviceRaw) {
  ensureLoaded();
  const v = normalizeHex4(vendorRaw);
  const d = normalizeHex4(deviceRaw);
  if (!v || !d) return null;
  return cache.devices.get(`${v}:${d}`) ?? null;
}

/**
 * @param {string} vendorRaw
 * @returns {string | null}
 */
export function lookupVendorName(vendorRaw) {
  ensureLoaded();
  const v = normalizeHex4(vendorRaw);
  if (!v) return null;
  return cache.vendors.get(v) ?? null;
}

/**
 * Human-readable class string from sysfs class value.
 * @param {string} classRaw
 * @returns {string}
 */
export function lookupClassName(classRaw) {
  const full = normalizePciClassHex(classRaw);
  ensureLoaded();

  const exact = cache.classes.get(full);
  if (exact) return exact;

  const sub4 = full.slice(0, 4);
  const sub4Name = cache.classes.get(sub4);
  if (sub4Name) return sub4Name;

  const base2 = full.slice(0, 2);
  const baseName = cache.classes.get(base2);
  if (baseName) return baseName;

  return BASE_CLASS_FALLBACK[base2] ?? `Class ${full}`;
}
