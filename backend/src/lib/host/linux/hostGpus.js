/**
 * Host GPU enumeration for container passthrough.
 *
 * Reads `/dev/dri/renderD*` chardev nodes and pairs each with vendor/PCI/model
 * info from `/sys/class/drm/<name>/device/`. v1 returns Intel + AMD only —
 * NVIDIA needs CDI / nvidia-container-toolkit, which isn't wired up yet, so we
 * filter those out at the source rather than letting the user pick something
 * that would fail at start.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { lookupDeviceName } from './pciIds.js';

const VENDOR_INTEL = '0x8086';
const VENDOR_AMD = '0x1002';
const VENDOR_NVIDIA = '0x10de';

const VENDOR_NAMES = {
  [VENDOR_INTEL]: 'Intel',
  [VENDOR_AMD]: 'AMD',
  [VENDOR_NVIDIA]: 'NVIDIA',
};

async function readTrim(path) {
  try {
    const buf = await readFile(path, 'utf8');
    return buf.trim();
  } catch {
    return null;
  }
}

/** Parse `KEY=value` lines (sysfs `uevent` format). */
function parseUevent(text) {
  const out = {};
  if (!text) return out;
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Enumerate render nodes under /dev/dri/renderD<N>.
 * Returns paths only — vendor/model resolution happens per-node.
 */
async function listRenderNodes() {
  let entries;
  try {
    entries = await readdir('/dev/dri');
  } catch {
    return [];
  }
  return entries
    .filter((n) => /^renderD\d+$/.test(n))
    .map((n) => `/dev/dri/${n}`)
    .sort();
}

/**
 * @param {string} devicePath e.g. `/dev/dri/renderD128`
 * @returns {Promise<null | {
 *   device: string,
 *   vendor: string,
 *   vendorName: string,
 *   pciSlot: string | null,
 *   model: string | null,
 * }>}
 */
async function describeRenderNode(devicePath) {
  const name = basename(devicePath);
  const sysBase = `/sys/class/drm/${name}/device`;

  const [vendorRaw, deviceRaw, ueventRaw, st] = await Promise.all([
    readTrim(`${sysBase}/vendor`),
    readTrim(`${sysBase}/device`),
    readTrim(`${sysBase}/uevent`),
    stat(devicePath).catch(() => null),
  ]);

  if (!st || !st.isCharacterDevice()) return null;
  if (!vendorRaw) return null;

  const vendor = vendorRaw.toLowerCase();
  const vendorName = VENDOR_NAMES[vendor] || `Unknown (${vendor})`;
  const uevent = parseUevent(ueventRaw);
  const pciSlot = uevent.PCI_SLOT_NAME || null;
  const model = vendorRaw && deviceRaw
    ? lookupDeviceName(vendorRaw, deviceRaw) || null
    : null;

  return { device: devicePath, vendor, vendorName, pciSlot, model };
}

/**
 * List GPUs available for container passthrough. Intel + AMD only in v1.
 * Hosts with no `/dev/dri` (no GPU, headless servers) return [].
 *
 * @returns {Promise<Array<{
 *   device: string,
 *   vendor: string,
 *   vendorName: string,
 *   pciSlot: string | null,
 *   model: string | null,
 * }>>}
 */
export async function listHostGpus() {
  const nodes = await listRenderNodes();
  const described = await Promise.all(nodes.map((p) => describeRenderNode(p)));
  return described.filter((g) => g
    && (g.vendor === VENDOR_INTEL || g.vendor === VENDOR_AMD));
}
