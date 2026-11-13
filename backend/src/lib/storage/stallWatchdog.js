/**
 * No-progress watchdog for size-dependent work (CODING-RULES §6): a disk
 * convert, a disk copy, a backup tar run as long as the data is big, so a fixed
 * cap would either kill a legitimate job or mean nothing. Instead the work is
 * killed once it shows no progress for `stallMs` — progress being a `poke()`
 * from its output or byte stream, or a change in what a probe returns (the
 * destination's allocated blocks, the process's bytes read). `probe` is one
 * probe or a list; any of them changing counts.
 */
import { readFile, stat } from 'node:fs/promises';

function combineProbes(probe) {
  if (!probe) return null;
  if (!Array.isArray(probe)) return probe;
  return async () => (await Promise.all(probe.map((p) => p().catch(() => undefined)))).join(':');
}

export function createStallWatchdog({ stallMs, onStall, probe: probes }) {
  const probe = combineProbes(probes);
  let last = Date.now();
  let lastProbe;
  let fired = false;
  let checking = false;
  const timer = setInterval(async () => {
    if (fired || checking) return;
    checking = true;
    try {
      if (probe) {
        const value = await probe().catch(() => undefined);
        if (value !== undefined && value !== lastProbe) {
          lastProbe = value;
          last = Date.now();
        }
      }
      if (!fired && Date.now() - last >= stallMs) {
        fired = true;
        clearInterval(timer);
        onStall();
      }
    } finally {
      checking = false;
    }
  }, Math.min(15_000, Math.max(1_000, stallMs / 4)));
  timer.unref?.();
  return {
    poke() {
      last = Date.now();
    },
    stop() {
      clearInterval(timer);
    },
    get fired() {
      return fired;
    },
  };
}

/** A probe for `createStallWatchdog`: the file's allocated blocks (grows as data lands). */
export function fileBlocksProbe(path) {
  return async () => (await stat(path)).blocks;
}

/**
 * A probe for `createStallWatchdog`: bytes the process has read (`rchar` in
 * /proc/<pid>/io, Linux). It grows while a copy reads a long run of zeros that
 * writes nothing to a sparse destination.
 */
export function processReadProbe(pid) {
  return async () => {
    const io = await readFile(`/proc/${pid}/io`, 'utf8');
    return /^rchar:\s*(\d+)/m.exec(io)?.[1];
  };
}

/**
 * SIGKILL a child spawned with `detached: true` and everything in its process
 * group — the forks a tool such as `tar -z` starts hold its pipes too, so
 * killing the child alone leaves them running.
 */
export function killProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** `ms` as "N min" for messages ("N s" when it is not whole minutes). */
export function stallMinutes(ms) {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}
