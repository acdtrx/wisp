/**
 * Process age from Linux /proc (host PID). Used for container uptime when in-memory
 * start times were lost on backend restart.
 */
import { readFile } from 'node:fs/promises';

/** jiffies per second for /proc/[pid]/stat starttime (see getconf CLK_TCK; 100 on typical x86_64 Linux). */
const LINUX_USER_HZ = 100;

/**
 * Milliseconds since boot for this process, or null if unavailable.
 * @param {number} pid - Host PID (container init from containerd Tasks.Get)
 */
export async function processUptimeMsFromProc(pid) {
  if (pid == null || pid <= 0 || !Number.isFinite(pid)) return null;
  try {
    const [uptimeStr, statStr] = await Promise.all([
      readFile('/proc/uptime', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const uptimeSec = parseFloat(uptimeStr.trim().split(/\s+/)[0]);
    const starttimeTicks = parseLinuxProcStatStarttime(statStr);
    if (starttimeTicks == null || Number.isNaN(uptimeSec)) return null;
    const ageSec = uptimeSec - starttimeTicks / LINUX_USER_HZ;
    if (ageSec < 0 || ageSec > 10 * 365 * 24 * 3600) return null;
    return Math.round(ageSec * 1000);
  } catch {
    /* /proc unavailable, pid exited, or parse failed */
    return null;
  }
}

/**
 * Field 22 `starttime` from /proc/pid/stat (clock ticks since boot).
 */
function parseLinuxProcStatStarttime(stat) {
  const rp = stat.lastIndexOf(')');
  if (rp === -1) return null;
  const tail = stat.slice(rp + 2).trim().split(/\s+/);
  const st = tail[19];
  if (st == null) return null;
  const n = parseInt(st, 10);
  return Number.isFinite(n) ? n : null;
}
