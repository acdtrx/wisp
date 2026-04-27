/**
 * VM process introspection. Detects when a running qemu process is still using a binary
 * that has been replaced on disk (e.g. after a qemu/libvirt upgrade), which libvirt
 * surfaces as "the VM needs to be restarted" and manifests in Linux as `/proc/<pid>/exe`
 * pointing at a path ending with " (deleted)".
 *
 * PID source: libvirt writes `/var/run/libvirt/qemu/<name>.pid` for each running VM.
 */
import { readFile, readlink } from 'node:fs/promises';
import { watch } from 'node:fs';

const QEMU_PIDFILE_DIR = '/var/run/libvirt/qemu';
const QEMU_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/usr/libexec'];

/**
 * @param {string} name
 * @returns {Promise<boolean>} True when the VM's qemu process is using a replaced (deleted) binary.
 *   Returns false on any error (no pidfile, dead pid, EACCES) — absence of evidence, not evidence of staleness.
 */
export async function isVMBinaryStale(name) {
  let pid;
  try {
    const raw = await readFile(`${QEMU_PIDFILE_DIR}/${name}.pid`, 'utf8');
    pid = parseInt(raw.trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
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
