/**
 * Container stats: CPU usage, memory, uptime.
 * Uses containerd Tasks.Metrics gRPC call.
 */
import {
  containerState, getClient, callUnary, unpackAny,
} from './containerManagerConnection.js';
import { getTaskState, containerTaskStatusToUi } from './containerManagerLifecycle.js';
import { processUptimeMsFromProc } from './procUptime.js';

const prevStats = new Map();

/**
 * Get stats for a running container.
 */
export async function getContainerStats(name) {
  const task = await getTaskState(name);
  const state = containerTaskStatusToUi(task);

  if (state !== 'running') {
    prevStats.delete(name);
    return {
      state,
      cpuPercent: 0,
      memoryUsageMiB: 0,
      uptime: 0,
      pid: Number(task?.pid) || 0,
    };
  }

  // A Metrics call that fails fails the read: the figures are missing, never zeros.
  let cpuPercent = 0;
  let memoryUsageMiB = 0;
  const metricsRes = await callUnary(getClient('tasks'), 'metrics', {
    filters: [`id==${name}`],
  });
  const data = metricsRes.metrics?.length > 0 ? unpackAny(metricsRes.metrics[0].data) : null;
  if (data) {
    // cgroups v2 metrics format
    if (data.cpu?.usageUsec != null) {
      const now = Date.now();
      const cpuUsec = Number(data.cpu.usageUsec);
      const prev = prevStats.get(name);
      if (prev) {
        const elapsedMs = now - prev.time;
        const cpuDeltaUsec = cpuUsec - prev.cpuUsec;
        if (elapsedMs > 0) {
          cpuPercent = Math.min(100, (cpuDeltaUsec / (elapsedMs * 1000)) * 100);
        }
      }
      prevStats.set(name, { time: now, cpuUsec });
    }

    if (data.memory?.usage != null) {
      memoryUsageMiB = Math.round(Number(data.memory.usage) / (1024 * 1024));
    }
  }

  const pidNum = Number(task?.pid) || 0;
  let uptime = 0;
  if (pidNum) {
    const fromProc = await processUptimeMsFromProc(pidNum);
    if (fromProc != null) {
      uptime = fromProc;
    } else {
      const startTime = containerState.containerStartTimes.get(name);
      uptime = startTime ? Date.now() - startTime : 0;
    }
  }

  return {
    state,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsageMiB,
    uptime,
    pid: pidNum,
  };
}
