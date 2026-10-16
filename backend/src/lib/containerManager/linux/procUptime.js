/**
 * Process age and start time from Linux /proc (host PID). Used for container
 * uptime when in-memory start times were lost on backend restart, and for the
 * restart-required rule (has the task started since the flag was set?).
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
 * Wall-clock start time (epoch ms) of a host process, or null if unavailable.
 * `btime` (boot time, whole seconds) + `starttime` ticks: the btime rounding
 * makes the result up to 1 s early, never late.
 * @param {number} pid - Host PID
 */
export async function processStartTimeMsFromProc(pid) {
  if (pid == null || pid <= 0 || !Number.isFinite(pid)) return null;
  try {
    const [procStat, statStr] = await Promise.all([
      readFile('/proc/stat', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const btimeLine = procStat.split('\n').find((l) => l.startsWith('btime '));
    const btimeSec = btimeLine ? parseInt(btimeLine.slice(6), 10) : NaN;
    const starttimeTicks = parseLinuxProcStatStarttime(statStr);
    if (starttimeTicks == null || !Number.isFinite(btimeSec)) return null;
    return btimeSec * 1000 + Math.floor((starttimeTicks * 1000) / LINUX_USER_HZ);
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
