/**
 * One host-stats snapshot in the exact shape the /api/stats SSE stream pushes.
 * Shared by the stats route (which sends it every 5 s) and the MCP
 * get_host_stats tool (which returns a single sample).
 */
import {
  getHostStats,
  getPendingUpdatesCount,
  getLastCheckedAt,
  isUpdateOperationInProgress,
  getRebootSignal,
} from './host/index.js';
import { getRunningVMAllocations, getHostHardware } from './vmManager/index.js';
import { getRunningContainerCount } from './containerManager/index.js';
import { getCachedStatus as getWispUpdateStatus } from './wispUpdate.js';

export async function buildHostStatsPayload() {
  const hardware = getHostHardware();
  const host = getHostStats();
  const vms = await getRunningVMAllocations();
  const runningContainers = await getRunningContainerCount();
  const reboot = await getRebootSignal();

  return {
    cpu: {
      allocated: vms.vcpus,
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
      allocatedGB: Math.round((vms.memoryBytes / (1024 ** 3)) * 10) / 10,
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
    runningVMs: vms.count,
    runningContainers,
    pendingUpdates: getPendingUpdatesCount(),
    updatesLastChecked: getLastCheckedAt(),
    updateOperationInProgress: isUpdateOperationInProgress(),
    rebootRequired: reboot.required,
    rebootReasons: reboot.reasons,
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
