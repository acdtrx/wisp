import { getHostStats } from '../lib/procStats.js';
import { getRunningVMAllocations, getHostHardware } from '../lib/vmManager.js';
import { getRunningContainerCount } from '../lib/containerManager.js';
import { getPendingUpdatesCount, getLastCheckedAt } from '../lib/aptUpdates.js';
import { getRebootSignal } from '../lib/rebootRequired.js';
import { setupSSE } from '../lib/sse.js';

export default async function statsRoutes(fastify) {
  fastify.get('/stats', {
    schema: { hide: true },
    handler: async (request, reply) => {
      setupSSE(reply);

      const hardware = getHostHardware();

      async function sendStats() {
        try {
          const host = getHostStats();
          const vms = await getRunningVMAllocations();
          const runningContainers = await getRunningContainerCount();
          const reboot = await getRebootSignal();

          const payload = {
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
            rebootRequired: reboot.required,
            rebootReasons: reboot.reasons,
          };

          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (err) {
          fastify.log.error({ err }, 'Failed to gather stats');
          const errPayload = {
            error: 'Failed to gather stats',
            detail: err.raw || err.message,
            code: err.code,
          };
          try { reply.raw.write(`data: ${JSON.stringify(errPayload)}\n\n`); }
          catch { /* client gone — interval will be cleared on close */ }
        }
      }

      await sendStats();
      const interval = setInterval(sendStats, 3000);

      request.raw.on('close', () => {
        clearInterval(interval);
      });
    },
  });
}
