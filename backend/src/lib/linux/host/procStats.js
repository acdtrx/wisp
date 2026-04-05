import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const SECTOR_BYTES = 512;

let prevCpu = null;
let prevCpuTime = 0;
let prevCpuPerCore = null;
let prevCpuPerCoreTime = 0;
let prevDisk = null;
let prevDiskTime = 0;
let prevNet = null;
let prevNetTime = 0;
let prevPowerUj = null;
let prevPowerTime = 0;

function readFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    /* /proc path missing or unreadable */
    return null;
  }
}

function parseCpuStats() {
  const content = readFile('/proc/stat');
  if (!content) return null;

  const line = content.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;

  // user nice system idle iowait irq softirq steal
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0); // idle + iowait
  const total = parts.reduce((sum, v) => sum + v, 0);

  return { idle, total };
}

/**
 * Parse per-core CPU stats from /proc/stat (cpu0, cpu1, ...).
 * Returns array of { idle, total } per core, or null.
 */
function parseCpuPerCoreStats() {
  const content = readFile('/proc/stat');
  if (!content) return null;

  const lines = content.split('\n').filter((l) => /^cpu\d+\s/.test(l));
  if (lines.length === 0) return null;

  const cores = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((sum, v) => sum + v, 0);
    cores.push({ idle, total });
  }
  return cores;
}

function getCpuUsage() {
  const current = parseCpuStats();
  if (!current) return 0;

  const now = Date.now();

  /* Module-level prevCpu is safe: single event loop, no concurrent callers. */
  if (!prevCpu) {
    prevCpu = current;
    prevCpuTime = now;
    return 0;
  }

  const deltaTotal = current.total - prevCpu.total;
  const deltaIdle = current.idle - prevCpu.idle;

  prevCpu = current;
  prevCpuTime = now;

  if (deltaTotal === 0) return 0;
  return ((deltaTotal - deltaIdle) / deltaTotal) * 100;
}

/**
 * Returns array of per-core CPU usage percentages, or empty array if unavailable.
 */
function getCpuPerCoreUsage() {
  const current = parseCpuPerCoreStats();
  if (!current || current.length === 0) return [];

  const now = Date.now();

  if (!prevCpuPerCore || prevCpuPerCore.length !== current.length) {
    prevCpuPerCore = current;
    prevCpuPerCoreTime = now;
    return new Array(current.length).fill(0);
  }

  const perCore = current.map((cur, i) => {
    const prev = prevCpuPerCore[i];
    const deltaTotal = cur.total - prev.total;
    const deltaIdle = cur.idle - prev.idle;
    if (deltaTotal === 0) return 0;
    return ((deltaTotal - deltaIdle) / deltaTotal) * 100;
  });

  prevCpuPerCore = current;
  prevCpuPerCoreTime = now;

  return perCore;
}

/**
 * Load average 1, 5, 15 min from /proc/loadavg.
 * Returns [load1, load5, load15] or null.
 */
function getLoadAverage() {
  const content = readFile('/proc/loadavg');
  if (!content) return null;

  const parts = content.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const load1 = parseFloat(parts[0], 10);
  const load5 = parseFloat(parts[1], 10);
  const load15 = parseFloat(parts[2], 10);

  if (Number.isNaN(load1) || Number.isNaN(load5) || Number.isNaN(load15)) return null;
  return [load1, load5, load15];
}

function getMemoryStats() {
  const content = readFile('/proc/meminfo');
  if (!content) return { used: 0, total: 0, percent: 0 };

  const values = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) values[match[1]] = parseInt(match[2], 10) * 1024; // kB -> bytes
  }

  const total = values.MemTotal || 0;
  const available = values.MemAvailable || 0;
  const used = total - available;
  const buffers = values.Buffers || 0;
  const cached = (values.Cached || 0) + (values.SReclaimable || 0);
  const swapTotal = values.SwapTotal || 0;
  const swapFree = values.SwapFree || 0;
  const swapCached = values.SwapCached || 0;
  const swapUsed = swapTotal - swapFree;

  return {
    used,
    total,
    percent: total > 0 ? (used / total) * 100 : 0,
    buffersBytes: buffers,
    cachedBytes: cached,
    swapTotalBytes: swapTotal,
    swapUsedBytes: swapUsed,
    swapCachedBytes: swapCached,
  };
}

function formatSensorLabel(rawType, source) {
  const type = String(rawType || '').trim();
  const lower = type.toLowerCase();
  if (lower === 'x86_pkg_temp') return 'CPU Package';
  if (lower === 'acpitz') return 'ACPI';
  if (source === 'hwmon' && type) return type;
  if (!type) return 'Sensor';
  return type.replace(/[_-]+/g, ' ').trim();
}

function normalizeSensorType(rawType) {
  return String(rawType || '')
    .trim()
    .toLowerCase()
    .replace(/[_\-\s]+/g, '');
}

function parseMilliCToC(raw) {
  if (!raw) return null;
  const value = parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value / 1000;
}

function getThermalZoneThresholds(base) {
  let maxC = null;
  let critC = null;
  try {
    const entries = readdirSync(base);
    for (const entry of entries) {
      if (!entry.startsWith('trip_point_') || !entry.endsWith('_temp')) continue;
      const index = entry.slice('trip_point_'.length, -'_temp'.length);
      const tripType = readFile(`${base}/trip_point_${index}_type`)?.trim().toLowerCase();
      const tripC = parseMilliCToC(readFile(`${base}/${entry}`));
      if (tripC == null || !tripType) continue;
      if (tripType.includes('critical')) {
        critC = critC == null ? tripC : Math.min(critC, tripC);
      } else if (tripType.includes('hot') || tripType.includes('passive') || tripType.includes('active')) {
        maxC = maxC == null ? tripC : Math.min(maxC, tripC);
      }
    }
  } catch {
    /* trip point files may be missing */
  }
  return { maxC, critC };
}

function getHwmonThresholds(base, index) {
  return {
    maxC: parseMilliCToC(readFile(`${base}/temp${index}_max`)),
    critC: parseMilliCToC(readFile(`${base}/temp${index}_crit`)),
  };
}

/**
 * PCI BDF from a resolved sysfs path. Uses the last `dddd:dd:dd.d` segment
 * (most downstream device), e.g. `.../0000:01:00.0/nvme/nvme0` → `0000:01:00.0`.
 * @param {string} resolvedPath
 * @returns {string | null}
 */
function pciAddressFromSysfsPath(resolvedPath) {
  const matches = [...String(resolvedPath).matchAll(/([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].toLowerCase();
}

/**
 * Follow hwmon `device` symlink; if it resolves under a PCI device, return its address.
 * @param {string} hwmonBase e.g. /sys/class/hwmon/hwmon0
 * @returns {string | null}
 */
function getHwmonPciAddress(hwmonBase) {
  try {
    const resolved = realpathSync(join(hwmonBase, 'device'));
    return pciAddressFromSysfsPath(resolved);
  } catch {
    /* missing symlink or not PCI */
    return null;
  }
}

function scoreCpuSensor(entry) {
  const type = String(entry.type || '').toLowerCase();
  if (!type) return 0;
  if (type.includes('x86_pkg_temp')) return 100;
  if (type.includes('package id')) return 95;
  if (type.includes('tdie')) return 92;
  if (type.includes('tctl')) return 90;
  if (type.includes('cpu package') || type.includes('cpu_thermal')) return 88;
  if (type.includes('coretemp') || type.includes('k10temp') || type.includes('k8temp') || type.includes('zenpower')) return 85;
  if (type.includes('cpu') || type.includes('core')) return 80;
  if (type.includes('acpitz')) return 20;
  if (
    type.includes('nvme')
    || type.includes('iwlwifi')
    || type.includes('gpu')
    || type.includes('pch')
    || type.includes('battery')
    || type.includes('bat')
    || type.includes('wifi')
    || type.includes('wireless')
    || type.includes('skin')
  ) {
    return 0;
  }
  return 10;
}

function getThermalZones() {
  const zones = [];
  const thermalTypeKeys = new Set();

  try {
    const thermalEntries = readdirSync('/sys/class/thermal');
    for (const name of thermalEntries) {
      if (!name.startsWith('thermal_zone')) continue;
      const base = `/sys/class/thermal/${name}`;
      const type = readFile(`${base}/type`)?.trim();
      const tempC = parseMilliCToC(readFile(`${base}/temp`));
      if (tempC == null) continue;
      const thresholds = getThermalZoneThresholds(base);
      zones.push({
        type: type || name,
        tempC,
        ...thresholds,
        label: formatSensorLabel(type || name, 'thermal'),
        pciAddress: null,
      });
      thermalTypeKeys.add(normalizeSensorType(type || name));
    }
  } catch {
    /* thermal sysfs may be missing or unreadable */
  }

  try {
    const hwmons = readdirSync('/sys/class/hwmon');
    for (const name of hwmons) {
      const base = `/sys/class/hwmon/${name}`;
      const hwmonName = readFile(`${base}/name`)?.trim();
      const pciAddress = getHwmonPciAddress(base);
      const entries = readdirSync(base);
      for (const entry of entries) {
        if (!entry.startsWith('temp') || !entry.endsWith('_input')) continue;
        const index = entry.slice(4, -6);
        const tempLabel = readFile(`${base}/temp${index}_label`)?.trim();
        const tempC = parseMilliCToC(readFile(`${base}/${entry}`));
        if (tempC == null) continue;
        const type = [hwmonName, tempLabel].filter(Boolean).join(' ').trim() || `${name} temp${index}`;
        const typeKey = normalizeSensorType(type);
        // Prefer thermal_zone for overlapping sensor names/types.
        if (thermalTypeKeys.has(typeKey)) continue;
        const thresholds = getHwmonThresholds(base, index);
        zones.push({
          type,
          tempC,
          ...thresholds,
          label: formatSensorLabel(type, 'hwmon'),
          pciAddress,
        });
      }
    }
  } catch {
    /* hwmon sysfs may be missing or unreadable */
  }

  return zones;
}

function getPrimaryCpuZone(zones) {
  if (!Array.isArray(zones) || zones.length === 0) return null;

  let best = null;
  let bestScore = -1;
  for (const zone of zones) {
    const score = scoreCpuSensor(zone);
    if (score <= 0) continue;
    if (score > bestScore) {
      best = zone;
      bestScore = score;
    }
  }
  return best;
}

const RAPL_ENERGY_PATH = '/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj';

/**
 * CPU package power in watts from Intel RAPL (energy_uj). Delta-based. Returns null if unavailable.
 * Requires readable energy_uj (often root or udev/ACL). Not available in VMs or on non-Intel.
 */
function getCpuPowerWatts() {
  let content;
  try {
    content = readFile(RAPL_ENERGY_PATH);
  } catch {
    /* RAPL not available or not readable */
    return null;
  }
  if (!content) return null;

  const energyUj = parseInt(content.trim(), 10);
  if (!Number.isInteger(energyUj) || energyUj < 0) return null;

  const now = Date.now();

  if (prevPowerUj === null) {
    prevPowerUj = energyUj;
    prevPowerTime = now;
    return null;
  }

  const elapsedSec = (now - prevPowerTime) / 1000;
  if (elapsedSec <= 0) {
    prevPowerUj = energyUj;
    prevPowerTime = now;
    return null;
  }

  // energy_uj can wrap (e.g. at 2^32)
  let deltaUj = energyUj - prevPowerUj;
  if (deltaUj < 0) deltaUj += 2 ** 32;

  prevPowerUj = energyUj;
  prevPowerTime = now;

  const watts = (deltaUj / 1_000_000) / elapsedSec;
  return Math.round(watts * 100) / 100;
}

function parseDiskStats() {
  const content = readFile('/proc/diskstats');
  if (!content) return null;

  let readSectors = 0;
  let writeSectors = 0;

  for (const line of content.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;

    const deviceName = parts[2];
    // Aggregate physical devices only (sd*, nvme*n*p*, vd*, xvd*), skip partitions for sd/vd/xvd
    const isWholeDevice =
      /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+)$/.test(deviceName) ||
      /^nvme\d+n\d+$/.test(deviceName);

    if (!isWholeDevice) continue;

    readSectors += parseInt(parts[5], 10) || 0;   // sectors read
    writeSectors += parseInt(parts[9], 10) || 0;  // sectors written
  }

  return { readSectors, writeSectors };
}

function getDiskIO() {
  const current = parseDiskStats();
  if (!current) return { readMBs: 0, writeMBs: 0 };

  const now = Date.now();

  if (!prevDisk) {
    prevDisk = current;
    prevDiskTime = now;
    return { readMBs: 0, writeMBs: 0 };
  }

  const elapsed = (now - prevDiskTime) / 1000;
  if (elapsed <= 0) return { readMBs: 0, writeMBs: 0 };

  const deltaRead = current.readSectors - prevDisk.readSectors;
  const deltaWrite = current.writeSectors - prevDisk.writeSectors;

  prevDisk = current;
  prevDiskTime = now;

  return {
    readMBs: Math.max(0, (deltaRead * SECTOR_BYTES) / (1024 * 1024) / elapsed),
    writeMBs: Math.max(0, (deltaWrite * SECTOR_BYTES) / (1024 * 1024) / elapsed),
  };
}

function parseNetStats() {
  const content = readFile('/proc/net/dev');
  if (!content) return null;

  let rxBytes = 0;
  let txBytes = 0;

  for (const line of content.split('\n')) {
    const match = line.match(/^\s*(\S+):\s*(.*)/);
    if (!match) continue;

    const iface = match[1];
    if (iface === 'lo') continue;

    const parts = match[2].trim().split(/\s+/).map(Number);
    rxBytes += parts[0] || 0;  // receive bytes
    txBytes += parts[8] || 0;  // transmit bytes
  }

  return { rxBytes, txBytes };
}

function getNetIO() {
  const current = parseNetStats();
  if (!current) return { rxMBs: 0, txMBs: 0 };

  const now = Date.now();

  if (!prevNet) {
    prevNet = current;
    prevNetTime = now;
    return { rxMBs: 0, txMBs: 0 };
  }

  const elapsed = (now - prevNetTime) / 1000;
  if (elapsed <= 0) return { rxMBs: 0, txMBs: 0 };

  const deltaRx = current.rxBytes - prevNet.rxBytes;
  const deltaTx = current.txBytes - prevNet.txBytes;

  prevNet = current;
  prevNetTime = now;

  return {
    rxMBs: Math.max(0, deltaRx / (1024 * 1024) / elapsed),
    txMBs: Math.max(0, deltaTx / (1024 * 1024) / elapsed),
  };
}

export function getHostStats() {
  const thermalZones = getThermalZones();
  const primaryCpuZone = getPrimaryCpuZone(thermalZones);

  return {
    cpu: {
      percent: getCpuUsage(),
      perCore: getCpuPerCoreUsage(),
    },
    memory: getMemoryStats(),
    loadAvg: getLoadAverage(),
    cpuTemp: primaryCpuZone?.tempC ?? null,
    cpuTempThresholds: primaryCpuZone ? { maxC: primaryCpuZone.maxC ?? null, critC: primaryCpuZone.critC ?? null } : null,
    thermalZones,
    cpuPowerWatts: getCpuPowerWatts(),
    disk: getDiskIO(),
    net: getNetIO(),
  };
}
