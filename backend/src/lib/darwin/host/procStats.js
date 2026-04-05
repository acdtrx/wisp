/**
 * Host stats for macOS dev: CPU from os.cpus() deltas, loadavg, memory from vm_stat + sysctl.
 * No /proc — disk/net throughput, thermal, and power stay unavailable (Tier A).
 */
import { execFileSync } from 'node:child_process';
import { cpus, loadavg, totalmem, freemem } from 'node:os';

let prevAgg = null;
let prevPerCore = null;

/**
 * Aggregate and per-core idle vs total CPU time (same tick as os.cpus()).
 * @returns {{ idle: number, total: number, perCore: { idle: number, total: number }[] } | null}
 */
function sampleCpuTimes() {
  const list = cpus();
  if (!list.length) return null;

  let idleSum = 0;
  let totalSum = 0;
  const perCore = [];

  for (const cpu of list) {
    const t = cpu.times;
    const coreIdle = t.idle;
    const coreBusy = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0);
    const coreTotal = coreIdle + coreBusy;
    idleSum += coreIdle;
    totalSum += coreTotal;
    perCore.push({ idle: coreIdle, total: coreTotal });
  }

  return { idle: idleSum, total: totalSum, perCore };
}

function getCpuUsage() {
  const current = sampleCpuTimes();
  if (!current) return 0;

  if (!prevAgg) {
    prevAgg = { idle: current.idle, total: current.total };
    return 0;
  }

  const deltaTotal = current.total - prevAgg.total;
  const deltaIdle = current.idle - prevAgg.idle;
  prevAgg = { idle: current.idle, total: current.total };

  if (deltaTotal <= 0) return 0;
  return ((deltaTotal - deltaIdle) / deltaTotal) * 100;
}

function getCpuPerCoreUsage() {
  const current = sampleCpuTimes();
  if (!current || current.perCore.length === 0) return [];

  if (!prevPerCore || prevPerCore.length !== current.perCore.length) {
    prevPerCore = current.perCore.map((c) => ({ ...c }));
    return new Array(current.perCore.length).fill(0);
  }

  const out = current.perCore.map((cur, i) => {
    const prev = prevPerCore[i];
    const deltaTotal = cur.total - prev.total;
    const deltaIdle = cur.idle - prev.idle;
    if (deltaTotal <= 0) return 0;
    return ((deltaTotal - deltaIdle) / deltaTotal) * 100;
  });

  prevPerCore = current.perCore.map((c) => ({ ...c }));
  return out;
}

/**
 * Parse `vm_stat` for page counts. Lines look like `Pages free:     12345.`
 * @returns {{ pageSize: number, free: number, inactive: number, speculative: number, purgeable: number } | null}
 */
function parseVmStat() {
  try {
    const out = execFileSync('/usr/bin/vm_stat', [], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });

    const sizeMatch = out.match(/page size of (\d+) bytes/i);
    const pageSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 4096;
    if (!Number.isInteger(pageSize) || pageSize <= 0) return null;

    /** @param {string} label */
    const pages = (label) => {
      const re = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'im');
      const m = out.match(re);
      if (!m) return 0;
      const n = parseInt(m[1], 10);
      return Number.isInteger(n) ? n : 0;
    };

    return {
      pageSize,
      free: pages('free'),
      inactive: pages('inactive'),
      speculative: pages('speculative'),
      purgeable: pages('purgeable'),
    };
  } catch {
    /* vm_stat missing or failed — caller uses os.freemem() */
    return null;
  }
}

/**
 * `sysctl -n vm.swapusage` → total = Xm used = Ym ...
 * @returns {{ swapTotalBytes: number, swapUsedBytes: number }}
 */
function parseSwapusage() {
  try {
    const line = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });

    const totalM = line.match(/total\s*=\s*([\d.]+)\s*M/i);
    const usedM = line.match(/used\s*=\s*([\d.]+)\s*M/i);
    if (!totalM || !usedM) return { swapTotalBytes: 0, swapUsedBytes: 0 };

    const swapTotalBytes = Math.round(parseFloat(totalM[1]) * 1024 * 1024);
    const swapUsedBytes = Math.round(parseFloat(usedM[1]) * 1024 * 1024);
    if (!Number.isFinite(swapTotalBytes) || !Number.isFinite(swapUsedBytes)) {
      return { swapTotalBytes: 0, swapUsedBytes: 0 };
    }
    return { swapTotalBytes, swapUsedBytes };
  } catch {
    return { swapTotalBytes: 0, swapUsedBytes: 0 };
  }
}

/**
 * Linux `MemAvailable`-like semantics: treat free + inactive + speculative + purgeable as broadly reclaimable.
 * `os.freemem()` on Darwin is only the tiny free pool, so total − freemem() looks ~100% used incorrectly.
 */
function getMemoryStats() {
  const total = totalmem();
  const vm = parseVmStat();
  const { swapTotalBytes, swapUsedBytes } = parseSwapusage();

  if (vm) {
    const reclaimablePages = vm.free + vm.inactive + vm.speculative + vm.purgeable;
    const availableBytes = Math.min(total, reclaimablePages * vm.pageSize);
    const used = Math.max(0, Math.min(total, total - availableBytes));
    const cachedBytes = Math.min(total, vm.inactive * vm.pageSize);

    return {
      used,
      total,
      percent: total > 0 ? (used / total) * 100 : 0,
      buffersBytes: 0,
      cachedBytes,
      swapTotalBytes,
      swapUsedBytes,
      swapCachedBytes: 0,
    };
  }

  const free = freemem();
  const used = Math.max(0, total - free);
  return {
    used,
    total,
    percent: total > 0 ? (used / total) * 100 : 0,
    buffersBytes: 0,
    cachedBytes: 0,
    swapTotalBytes,
    swapUsedBytes,
    swapCachedBytes: 0,
  };
}

export function getHostStats() {
  const la = loadavg();
  const loadAvg = Array.isArray(la) && la.length >= 3
    ? [la[0], la[1], la[2]]
    : null;

  return {
    cpu: {
      percent: getCpuUsage(),
      perCore: getCpuPerCoreUsage(),
    },
    memory: getMemoryStats(),
    loadAvg,
    cpuTemp: null,
    cpuTempThresholds: null,
    thermalZones: [],
    cpuPowerWatts: null,
    disk: { readMBs: 0, writeMBs: 0 },
    net: { rxMBs: 0, txMBs: 0 },
  };
}
