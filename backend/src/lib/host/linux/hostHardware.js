/**
 * Host hardware info from /proc, /sys, optional pci.ids, and optional helper scripts.
 * All file reads; CLI helpers used for RAM (wisp-dmidecode) and disk SMART (wisp-smartctl).
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';

import {
  lookupClassName,
  lookupDeviceName,
  lookupVendorName,
  normalizePciClassHex,
} from './pciIds.js';
import { readAllDiskSmartSummaries } from './smart.js';
import { mountSizeReadsInFlight, readMountSize, readMountTable } from '../../storage/index.js';
import { isAbsent, logHostFailure } from '../hostLog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/** Prefer installed helper + sudoers path (installed by setup's helpers step); bundled path for dev. */
const DMIDECODE_INSTALLED = '/usr/local/bin/wisp-dmidecode';
const DMIDECODE_BUNDLED = resolve(__dirname, '../../../../scripts/wisp-dmidecode');

async function resolveDmidecodeScriptPath() {
  const fromEnv = process.env.WISP_DMIDECODE_SCRIPT;
  if (fromEnv) {
    try {
      await access(fromEnv);
      return fromEnv;
    } catch {
      /* the configured helper is not there: no helper */
      return null;
    }
  }
  for (const p of [DMIDECODE_INSTALLED, DMIDECODE_BUNDLED]) {
    try {
      await access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * An optional sysfs/proc file, or null when it has no value: absent, or (EINVAL)
 * a value the kernel has none of now — a link's speed while it is down. Any
 * other failure is logged, and read as no value.
 */
function readFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (!isAbsent(err) && err.code !== 'EINVAL') logHostFailure(err, 'Hardware file read failed', { path });
    return null;
  }
}

function parseCpuList(raw) {
  if (!raw) return [];
  const tokens = raw.trim().split(',').map((t) => t.trim()).filter(Boolean);
  const cpus = [];

  for (const token of tokens) {
    if (token.includes('-')) {
      const [startRaw, endRaw] = token.split('-', 2);
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) continue;
      for (let i = start; i <= end; i += 1) cpus.push(i);
      continue;
    }

    const single = Number.parseInt(token, 10);
    if (Number.isInteger(single)) cpus.push(single);
  }

  return [...new Set(cpus)].sort((a, b) => a - b);
}

/**
 * Hybrid core type mapping from Linux sysfs.
 * Returns null when unavailable (non-hybrid CPUs or unsupported kernels).
 * @returns {{ performance: number[], efficiency: number[] } | null}
 */
function getCpuCoreTypes() {
  const performanceRaw = readFile('/sys/devices/cpu_core/cpus');
  const efficiencyRaw = readFile('/sys/devices/cpu_atom/cpus');
  if (!performanceRaw || !efficiencyRaw) return null;

  const performance = parseCpuList(performanceRaw);
  const efficiency = parseCpuList(efficiencyRaw);
  if (performance.length === 0 || efficiency.length === 0) return null;

  return { performance, efficiency };
}

/**
 * CPU info from /proc/cpuinfo (first processor block).
 * @returns {{ model: string, cores: number, threads: number, mhz: number | null, cacheKb: number | null } | null }
 */
export function getCpuInfo() {
  const content = readFile('/proc/cpuinfo');
  if (!content) return null;

  const blocks = content.split(/\n\n/).filter(Boolean);
  const first = blocks[0];
  if (!first) return null;

  const model = first.match(/model name\s*:\s*(.+)/)?.[1]?.trim() ?? null;
  const cores = parseInt(first.match(/cpu cores\s*:\s*(\d+)/)?.[1], 10) || 0;
  const siblings = parseInt(first.match(/siblings\s*:\s*(\d+)/)?.[1], 10) || 0;
  const mhzMatch = first.match(/cpu MHz\s*:\s*([\d.]+)/)?.[1];
  const mhz = mhzMatch != null ? parseFloat(mhzMatch, 10) : null;
  const cacheMatch = first.match(/cache size\s*:\s*(\d+)\s*KB/i)?.[1];
  const cacheKb = cacheMatch != null ? parseInt(cacheMatch, 10) : null;

  const physicalCores = cores || 1;
  const threadCount = siblings || (content.split(/processor\s*:/i).length - 1) || 1;

  return {
    model: model || 'Unknown',
    cores: physicalCores,
    threads: threadCount,
    mhz,
    cacheKb,
  };
}

/**
 * Deepest PCI BDF in a sysfs path (e.g. block device symlink under /sys/block).
 * @param {string} path
 * @returns {string | null}
 */
function extractPciAddressFromSysfsPath(path) {
  const matches = path.match(/[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f]/gi);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].toLowerCase();
}

/**
 * PCI BDF for the block device, if the device sits under a PCI bus in sysfs.
 * @param {string} blockName
 * @returns {string | null}
 */
function getBlockDevicePciAddress(blockName) {
  try {
    const resolved = readlinkSync(`/sys/block/${blockName}`);
    return extractPciAddressFromSysfsPath(resolved);
  } catch (err) {
    logHostFailure(err, 'Block device link read failed', { blockName });
    return null;
  }
}

/**
 * Rotational flag from /sys/block/&lt;name&gt;/queue/rotational (0=SSD/NVMe, 1=HDD).
 * @param {string} blockName
 * @returns {boolean | null}
 */
function getBlockRotational(blockName) {
  const raw = readFile(`/sys/block/${blockName}/queue/rotational`);
  if (!raw) return null;
  const v = raw.trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return null;
}

/**
 * List block devices with model and size from /sys/block.
 * Skips loop and ram devices by default.
 * @returns {{ name: string, model: string, sizeBytes: number, rotational: boolean | null, pciAddress: string | null }[] }
 */
export function getDiskInfo() {

  const result = [];
  try {
    const devices = readdirSync('/sys/block');
    for (const name of devices) {
      if (name.startsWith('loop') || name.startsWith('ram')) continue;

      let model = 'Unknown';
      const modelPath = `/sys/block/${name}/device/model`;
      const modelRaw = readFile(modelPath);
      if (modelRaw) model = modelRaw.trim();

      let sizeBytes = 0;
      const sizePath = `/sys/block/${name}/size`;
      const sizeRaw = readFile(sizePath);
      if (sizeRaw) sizeBytes = parseInt(sizeRaw.trim(), 10) * 512;

      const rotational = getBlockRotational(name);
      const pciAddress = getBlockDevicePciAddress(name);

      result.push({ name, model, sizeBytes, rotational, pciAddress });
    }
  } catch (err) {
    logHostFailure(err, 'Listing /sys/block failed');
    return [];
  }
  return result;
}

/**
 * `ip netns add` bind-mounts a file under /run/netns (or /var/run/netns); these are not disk usage the operator cares about on Host Overview.
 */
function isNetnsBindMount(mount) {
  return (
    mount === '/run/netns' ||
    mount.startsWith('/run/netns/') ||
    mount === '/var/run/netns' ||
    mount.startsWith('/var/run/netns/')
  );
}

/** Mounts whose size read timed out and was logged, until a read of theirs comes back. */
const loggedUnanswered = new Set();

/**
 * Filesystem usage per mount point from the mount table + statfs.
 * One row per mount point: when mounts are stacked on a path, the topmost
 * (last in mount order) is the one statfs sees, so it alone is reported.
 * Excludes pseudo/virtual filesystems and network-namespace bind mounts (containers / CNI).
 * Each size is read off the main thread and bounded (storage's readMountSize):
 * a mount that does not answer in time, or whose read fails, keeps its row
 * with null sizes. A failure is logged each time; a timeout once while the
 * mount stays unanswered.
 * @returns {Promise<{ mount: string, device: string, totalBytes: number|null, usedBytes: number|null, availBytes: number|null }[]>}
 */
export async function getFilesystemUsage() {
  const visibleByMountPoint = new Map();
  for (const entry of readMountTable()) visibleByMountPoint.set(entry.mountPoint, entry);

  const mounts = [...visibleByMountPoint.values()].filter(({ mountPoint: mount, fsType: fstype }) => (
    !mount.startsWith('/proc') && !mount.startsWith('/sys') && !mount.startsWith('/dev')
    && !isNetnsBindMount(mount)
    && fstype !== 'tmpfs' && fstype !== 'devtmpfs' && fstype !== 'squashfs'
  ));

  return Promise.all(mounts.map(async ({ source: device, mountPoint: mount }) => {
    const read = await readMountSize(mount);
    if (read.sizes) {
      loggedUnanswered.delete(mount);
      return { mount, device, ...read.sizes };
    }
    if (read.error) {
      loggedUnanswered.delete(mount);
      logHostFailure(read.error, 'Filesystem usage read failed', { mount });
    } else if (!loggedUnanswered.has(mount)) {
      loggedUnanswered.add(mount);
      logHostFailure(
        { message: 'no answer within the size read bound', code: 'TIMEOUT' },
        'Filesystem usage read did not answer (logged once while it stays unanswered)',
        { mount, readsInFlight: mountSizeReadsInFlight() },
      );
    }
    return { mount, device, totalBytes: null, usedBytes: null, availBytes: null };
  }));
}

/**
 * Network adapters from /sys/class/net (excluding loopback).
 * @returns {{ name: string, mac: string | null, speedMbps: number | null, state: string }[] }
 */
export function getNetworkAdapters() {
  const result = [];
  try {
    const names = readdirSync('/sys/class/net');
    for (const name of names) {
      if (name === 'lo') continue;

      let mac = null;
      const addrPath = `/sys/class/net/${name}/address`;
      const addrRaw = readFile(addrPath);
      if (addrRaw) mac = addrRaw.trim();

      let speedMbps = null;
      const speedPath = `/sys/class/net/${name}/speed`;
      const speedRaw = readFile(speedPath);
      if (speedRaw) {
        const n = parseInt(speedRaw.trim(), 10);
        if (Number.isInteger(n)) speedMbps = n;
      }

      let state = 'unknown';
      const statePath = `/sys/class/net/${name}/operstate`;
      const stateRaw = readFile(statePath);
      if (stateRaw) state = stateRaw.trim();

      result.push({ name, mac, speedMbps, state });
    }
  } catch (err) {
    logHostFailure(err, 'Listing /sys/class/net failed');
    return [];
  }
  return result;
}

const DMI_ID_BASE = '/sys/class/dmi/id';

function readDmiField(name) {
  const raw = readFile(`${DMI_ID_BASE}/${name}`);
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (lower === 'not specified' || lower === 'to be filled by o.e.m.' || lower === 'default string') return null;
  return t;
}

/**
 * Motherboard / system / BIOS identity from DMI sysfs.
 * @returns { Record<string, string | null> | null }
 */
export function getSystemInfo() {
  try {
    readdirSync(DMI_ID_BASE);
  } catch (err) {
    // No DMI sysfs (some VMs) is no identity to show.
    if (!isAbsent(err)) logHostFailure(err, 'Listing DMI sysfs failed');
    return null;
  }

  return {
    boardVendor: readDmiField('board_vendor'),
    boardName: readDmiField('board_name'),
    boardVersion: readDmiField('board_version'),
    systemVendor: readDmiField('sys_vendor'),
    systemProduct: readDmiField('product_name'),
    systemVersion: readDmiField('product_version'),
    biosVendor: readDmiField('bios_vendor'),
    biosVersion: readDmiField('bios_version'),
    biosDate: readDmiField('bios_date'),
  };
}

function getPciDriver(devicePath) {
  try {
    return basename(readlinkSync(`${devicePath}/driver`));
  } catch (err) {
    // No `driver` link: no driver is bound.
    if (!isAbsent(err)) logHostFailure(err, 'PCI driver link read failed', { devicePath });
    return null;
  }
}

/**
 * PCI devices from sysfs + pci.ids resolution.
 * @returns {{ address: string, classId: string, classCode: string, className: string, vendor: string, vendorId: string, device: string, deviceId: string, driver: string | null }[] }
 */
export function getPciDevices() {
  const out = [];
  try {
    const names = readdirSync('/sys/bus/pci/devices');
    for (const addr of names) {
      const base = `/sys/bus/pci/devices/${addr}`;
      const vendorRaw = readFile(`${base}/vendor`);
      const deviceRaw = readFile(`${base}/device`);
      const classRaw = readFile(`${base}/class`);
      if (!vendorRaw || !deviceRaw || !classRaw) continue;

      const vendorIdNum = parseInt(vendorRaw.trim(), 16);
      const deviceIdNum = parseInt(deviceRaw.trim(), 16);
      if (!Number.isFinite(vendorIdNum) || !Number.isFinite(deviceIdNum)) continue;

      const vendorIdStr = vendorIdNum.toString(16).padStart(4, '0').toLowerCase();
      const deviceIdStr = deviceIdNum.toString(16).padStart(4, '0').toLowerCase();
      const classHex = normalizePciClassHex(classRaw.trim());
      const vendorName = lookupVendorName(vendorRaw.trim()) ?? `Vendor ${vendorIdStr}`;
      const deviceName = lookupDeviceName(vendorRaw.trim(), deviceRaw.trim()) ?? `Device ${deviceIdStr}`;
      const className = lookupClassName(classRaw.trim());

      out.push({
        address: addr,
        classId: classHex.slice(0, 4),
        classCode: classHex,
        className,
        vendor: vendorName,
        vendorId: vendorIdStr,
        device: deviceName,
        deviceId: deviceIdStr,
        driver: getPciDriver(base),
      });
    }
  } catch (err) {
    logHostFailure(err, 'Listing PCI devices failed');
    return [];
  }

  return out.sort((a, b) => a.address.localeCompare(b.address, 'en'));
}

const JEDEC_MANUFACTURERS = {
  '80CE': 'Samsung',
  '80AD': 'SK Hynix',
  '802C': 'Micron',
  '8564': 'Nanya',
  '857F': 'Elpida',
  '0198': 'Kingston',
  '014F': 'Transcend',
  '04F1': 'G.Skill',
  '04CB': 'A-DATA',
  '0451': 'Qimonda',
  '01F1': 'Corsair',
  '0443': 'Ramaxel',
  '017A': 'Apacer',
  '80BA': 'PNY',
  '059B': 'Crucial',
};

/** If manufacturer looks like a raw JEDEC hex dump, resolve to a name. */
function resolveJedecManufacturer(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  if (!/^[0-9A-Fa-f]+$/.test(raw) || raw.length < 4) return raw;
  const prefix = raw.slice(0, 4).toUpperCase();
  return JEDEC_MANUFACTURERS[prefix] || raw;
}

async function runDmidecodeScript() {
  const scriptPath = await resolveDmidecodeScriptPath();
  if (!scriptPath) {
    return [];
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  try {
    const args = isRoot ? [scriptPath, []] : ['sudo', ['-n', scriptPath]];
    const { stdout } = await execFileAsync(args[0], args[1], { timeout: 10000 });
    const data = JSON.parse(stdout);
    if (!Array.isArray(data)) return [];
    for (let i = 0; i < data.length; i++) {
      const dimm = data[i];
      if (dimm.manufacturer) {
        dimm.manufacturer = resolveJedecManufacturer(dimm.manufacturer);
      }
      dimm.slot = String(i + 1);
    }
    return data;
  } catch (err) {
    logHostFailure(err, 'RAM module read (wisp-dmidecode) failed');
    return [];
  }
}

/**
 * RAM hardware info via wisp-dmidecode script (dmidecode --type memory).
 * Returns array of memory device info; empty array if script unavailable or not root.
 * @returns { Promise<{ type: string, sizeBytes: number, speedMts: number | null, slot: string, formFactor: string | null, manufacturer: string | null, voltage: string | null }[]> }
 */
export async function getRamInfo() {
  return runDmidecodeScript();
}

/**
 * Aggregate hardware info for GET /api/host/hardware.
 * getRamInfo is async; others are sync. Caller can await getHostHardwareInfo().
 */
export async function getHostHardwareInfo() {
  const cpu = getCpuInfo();
  const disks = await readAllDiskSmartSummaries(getDiskInfo());
  const filesystems = await getFilesystemUsage();
  const network = getNetworkAdapters();
  const memory = await getRamInfo();
  const pciDevices = getPciDevices();
  const system = getSystemInfo();

  return {
    cpu: cpu ? { ...cpu, coreTypes: getCpuCoreTypes() } : null,
    disks,
    filesystems,
    network,
    memory,
    pciDevices,
    system,
  };
}
