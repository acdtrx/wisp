/**
 * Host hardware for macOS: `system_profiler -json` inventory + statfs + os.networkInterfaces.
 */
import { cpus, networkInterfaces } from 'node:os';
import { existsSync, statfsSync } from 'node:fs';

import { mapProfilerToHardwareParts, runSystemProfilerJson } from './systemProfilerHardware.js';

/**
 * @returns {{ model: string, cores: number, threads: number, mhz: number | null, cacheKb: number | null } | null}
 */
function getCpuInfoFromOs() {
  const list = cpus();
  if (!list.length) return null;

  const n = list.length;
  const model = String(list[0].model || '').trim() || 'Unknown';

  return {
    model,
    cores: n,
    threads: n,
    mhz: null,
    cacheKb: null,
  };
}

/**
 * @returns {{ mount: string, device: string, totalBytes: number, usedBytes: number, availBytes: number }[] }
 */
function getFilesystemUsage() {
  const paths = ['/', '/System/Volumes/Data'];
  const result = [];

  for (const mount of paths) {
    if (!existsSync(mount)) continue;
    try {
      const st = statfsSync(mount);
      const totalBytes = st.blocks * st.bsize;
      const availBytes = st.bfree * st.bsize;
      const usedBytes = Math.max(0, totalBytes - availBytes);
      result.push({
        mount,
        device: '',
        totalBytes,
        usedBytes,
        availBytes,
      });
    } catch {
      /* skip paths we cannot stat */
    }
  }

  return result;
}

/**
 * @returns {{ name: string, mac: string | null, speedMbps: number | null, state: string }[] }
 */
function getNetworkAdaptersFromOs() {
  const ifaces = networkInterfaces();
  if (!ifaces) return [];

  const result = [];
  for (const name of Object.keys(ifaces)) {
    if (name === 'lo') continue;
    const addrs = ifaces[name];
    if (!addrs?.length) continue;

    let mac = null;
    for (const a of addrs) {
      if (a.mac && a.mac !== '00:00:00:00:00:00') {
        mac = a.mac;
        break;
      }
    }

    result.push({
      name,
      mac,
      speedMbps: null,
      state: 'unknown',
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * @param {{ name: string, mac: string | null, speedMbps: number | null, state: string }[]} adapters
 * @param {Map<string, { mac: string | null, speedMbps: number | null, state: string }>} enrich
 */
function enrichNetworkAdapters(adapters, enrich) {
  return adapters.map((a) => {
    const e = enrich.get(a.name);
    if (!e) return a;
    return {
      ...a,
      mac: a.mac || e.mac,
      speedMbps: e.speedMbps != null ? e.speedMbps : a.speedMbps,
      state: e.state || a.state,
    };
  });
}

/** Hide virtual / stub interfaces macOS often lists without a hardware MAC. */
function filterAdaptersWithMac(adapters) {
  return adapters.filter((a) => {
    const m = a.mac && String(a.mac).trim();
    return m && m !== '00:00:00:00:00:00';
  });
}

export async function getHostHardwareInfo() {
  const list = cpus();
  const osCpu = getCpuInfoFromOs();
  const osFallback = {
    logicalCpus: list.length,
    model: String(list[0]?.model || '').trim() || 'Unknown',
  };

  let profilerParts = null;
  try {
    const root = await runSystemProfilerJson();
    profilerParts = mapProfilerToHardwareParts(root, osFallback);
  } catch {
    /* system_profiler missing, non-mac host, timeout, or invalid JSON — OS-only fallback */
  }

  const cpu = profilerParts?.cpu
    ? { ...profilerParts.cpu }
    : osCpu
      ? { ...osCpu, coreTypes: null }
      : null;

  const networkBase = getNetworkAdaptersFromOs();
  const merged = profilerParts?.networkEnrich
    ? enrichNetworkAdapters(networkBase, profilerParts.networkEnrich)
    : networkBase;
  const network = filterAdaptersWithMac(merged);

  return {
    cpu,
    disks: profilerParts ? profilerParts.disks : [],
    filesystems: getFilesystemUsage(),
    network,
    memory: profilerParts ? profilerParts.memory : [],
    pciDevices: profilerParts ? profilerParts.pciDevices : [],
    system: profilerParts?.system ?? null,
  };
}
