/**
 * No-progress watchdog for size-dependent work (CODING-RULES §6, settled
 * 2026-11-12 as audit TMO-2): a disk convert, a disk copy, a backup tar run as
 * long as the data is big, so a fixed cap would either kill a legitimate job or
 * mean nothing. Instead the work is killed once it shows no progress for
 * `stallMs` — progress being a `poke()` from its output or byte stream, or a
 * change in what `probe()` returns (e.g. the destination's allocated blocks).
 */
import { stat } from 'node:fs/promises';

export function createStallWatchdog({ stallMs, onStall, probe }) {
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

/** `ms` as "N min" for messages. */
export function stallMinutes(ms) {
  return `${Math.round(ms / 60_000)} min`;
}
