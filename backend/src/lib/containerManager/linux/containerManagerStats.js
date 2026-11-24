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
 * A container's state and figures. The figures are sampled only while it runs: in any
 * other state they are null, never zeros, and `pid` is null when it has no task.
 */
export async function getContainerStats(name) {
  const task = await getTaskState(name);
  const state = containerTaskStatusToUi(task);
  const pid = Number(task?.pid) || null;

  if (state !== 'running') {
    prevStats.delete(name);
    return { state, cpuPercent: null, memoryUsageMiB: null, uptime: null, pid };
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

  let uptime = pid ? await processUptimeMsFromProc(pid) : null;
  if (uptime == null) {
    const startTime = containerState.containerStartTimes.get(name);
    uptime = startTime ? Date.now() - startTime : null;
  }

  return {
    state,
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsageMiB,
    uptime,
    pid,
  };
}
