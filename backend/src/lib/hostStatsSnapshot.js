/**
 * One host-stats snapshot: the `stats` topic's payload. Shared by the events
 * stream (which sends it every 5 s), and by `GET /api/host/stats` and the MCP
 * get_host_stats tool (which answer a single sample).
 */
import {
  getHostStats,
  getPendingUpdatesCount,
  getLastCheckedAt,
  isUpdateOperationInProgress,
  getRebootSignal,
} from './host/index.js';
import { getRunningVMAllocations, getHostHardware, pingLibvirt } from './vmManager/index.js';
import { getRunningContainerCount } from './containerManager/index.js';
import { getCachedStatus as getWispUpdateStatus } from './wispUpdate.js';
import { isCertificateFailed } from './hostCertificate.js';

/**
 * A figure read from a workload list, or null when the list could not be read:
 * the list's own topic carries its error, and the host's figures stand without it.
 */
async function fromList(read) {
  try {
    return await read();
  } catch {
    return null; // the list's own topic carries its error (above)
  }
}

export async function buildHostStatsPayload() {
  const hardware = getHostHardware();
  const host = getHostStats();
  // One cheap libvirt question per tick: a libvirtd gone away marks the VM list
  // stale, so the list read below (and the vms topic) reports it.
  await pingLibvirt();
  const vms = await fromList(getRunningVMAllocations);
  const runningContainers = await fromList(getRunningContainerCount);
  const reboot = await getRebootSignal();
  const certificateFailed = await isCertificateFailed();

  return {
    cpu: {
      allocated: vms ? vms.vcpus : null,
      total: hardware.cores,
      usagePercent: Math.round(host.cpu.percent * 10) / 10,
      perCore: (host.cpu.perCore || []).map((p) => Math.round(p * 10) / 10),
    },
    cpuTemp: host.cpuTemp != null ? Math.round(host.cpuTemp * 10) / 10 : null,
    cpuTempThresholds: host.cpuTempThresholds
      ? {
        maxC: host.cpuTempThresholds.maxC != null ? Math.round(host.cpuTempThresholds.maxC * 10) / 10 : null,
        critC: host.cpuTempThresholds.critC != null ? Math.round(host.cpuTempThresholds.critC * 10) / 10 : null,
      }
      : null,
    thermalZones: (host.thermalZones || []).map((zone) => ({
      type: zone.type,
      label: zone.label,
      tempC: zone.tempC != null ? Math.round(zone.tempC * 10) / 10 : null,
      maxC: zone.maxC != null ? Math.round(zone.maxC * 10) / 10 : null,
      critC: zone.critC != null ? Math.round(zone.critC * 10) / 10 : null,
      pciAddress: zone.pciAddress ?? null,
    })),
    cpuPowerWatts: host.cpuPowerWatts,
    memory: {
      allocatedGB: vms ? Math.round((vms.memoryBytes / (1024 ** 3)) * 10) / 10 : null,
      totalGB: Math.round((hardware.totalMemoryBytes / (1024 ** 3)) * 10) / 10,
      usagePercent: Math.round(host.memory.percent * 10) / 10,
      usedBytes: host.memory.used ?? 0,
      buffersBytes: host.memory.buffersBytes ?? 0,
      cachedBytes: host.memory.cachedBytes ?? 0,
      swapTotalBytes: host.memory.swapTotalBytes ?? 0,
      swapUsedBytes: host.memory.swapUsedBytes ?? 0,
    },
    loadAvg: host.loadAvg,
    disk: {
      readMBs: Math.round(host.disk.readMBs * 100) / 100,
      writeMBs: Math.round(host.disk.writeMBs * 100) / 100,
    },
    net: {
      rxMBs: Math.round(host.net.rxMBs * 100) / 100,
      txMBs: Math.round(host.net.txMBs * 100) / 100,
    },
    runningVMs: vms ? vms.count : null,
    runningContainers,
    pendingUpdates: getPendingUpdatesCount(),
    updatesLastChecked: getLastCheckedAt(),
    updateOperationInProgress: isUpdateOperationInProgress(),
    rebootRequired: reboot.required,
    rebootReasons: reboot.reasons,
    certificateFailed,
    wispUpdate: (() => {
      const s = getWispUpdateStatus();
      return {
        current: s.current,
        latest: s.latest,
        available: s.available,
        lastChecked: s.lastChecked,
      };
    })(),
  };
}
