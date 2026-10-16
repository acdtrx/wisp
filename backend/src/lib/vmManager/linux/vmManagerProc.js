/**
 * VM process introspection. Reads the qemu process's start time (uptime and the
 * restart-required rule) and detects when a running qemu process is still using a
 * binary that has been replaced on disk (e.g. after a qemu/libvirt upgrade), which
 * libvirt surfaces as "the VM needs to be restarted" and manifests in Linux as
 * `/proc/<pid>/exe` pointing at a path ending with " (deleted)".
 *
 * PID source: libvirt writes `/var/run/libvirt/qemu/<name>.pid` for each running VM.
 */
import { readFile, readlink } from 'node:fs/promises';
import { watch } from 'node:fs';

const QEMU_PIDFILE_DIR = '/var/run/libvirt/qemu';
const QEMU_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/usr/libexec'];

/** jiffies per second for /proc/[pid]/stat starttime (getconf CLK_TCK; 100 on typical x86_64 Linux). */
const LINUX_USER_HZ = 100;

/** PID of the VM's qemu process from libvirt's pidfile, or null (no file, unreadable, garbage). */
async function readQemuPid(name) {
  try {
    const raw = await readFile(`${QEMU_PIDFILE_DIR}/${name}.pid`, 'utf8');
    const pid = parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    /* no pidfile (VM stopped) or not readable */
    return null;
  }
}

/**
 * Wall-clock start time (epoch ms) of the VM's qemu process, or null when it
 * can't be read. `btime` (boot time, whole seconds) + `starttime` ticks from
 * /proc/<pid>/stat (world-readable, unlike /proc/<pid>/exe): the btime
 * rounding makes the result up to 1 s early, never late.
 */
export async function getQemuStartTimeMs(name) {
  const pid = await readQemuPid(name);
  if (pid == null) return null;
  try {
    const [procStat, pidStat] = await Promise.all([
      readFile('/proc/stat', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const btimeLine = procStat.split('\n').find((l) => l.startsWith('btime '));
    const btimeSec = btimeLine ? parseInt(btimeLine.slice(6), 10) : NaN;
    const rp = pidStat.lastIndexOf(')');
    const ticks = rp === -1 ? NaN : parseInt(pidStat.slice(rp + 2).trim().split(/\s+/)[19], 10);
    if (!Number.isFinite(btimeSec) || !Number.isFinite(ticks)) return null;
    return btimeSec * 1000 + Math.floor((ticks * 1000) / LINUX_USER_HZ);
  } catch {
    /* pid exited between the reads, or /proc unavailable */
    return null;
  }
}

/**
 * @param {string} name
 * @returns {Promise<boolean>} True when the VM's qemu process is using a replaced (deleted) binary.
 *   Returns false on any error (no pidfile, dead pid, EACCES) — absence of evidence, not evidence of staleness.
 */
export async function isVMBinaryStale(name) {
  const pid = await readQemuPid(name);
  if (pid == null) return false;
  try {
    const target = await readlink(`/proc/${pid}/exe`);
    return target.endsWith(' (deleted)');
  } catch {
    return false;
  }
}

/**
 * Watch the directories where qemu-system-* binaries can live and invoke `onChange`
 * whenever any of them is created/replaced/removed (apt/dnf upgrade of qemu-system).
 * Returns a cleanup function that closes all watchers.
 */
export function watchQemuBinaries(onChange) {
  const watchers = [];
  for (const dir of QEMU_BIN_DIRS) {
    try {
      const w = watch(dir, (_eventType, filename) => {
        if (filename && String(filename).startsWith('qemu-system-')) onChange();
      });
      w.on('error', () => { /* directory may be unwatchable; ignore */ });
      watchers.push(w);
    } catch {
      /* directory missing or not watchable on this host — skip */
    }
  }
  return () => {
    for (const w of watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
  };
}
