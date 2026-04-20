/**
 * VM process introspection. Detects when a running qemu process is still using a binary
 * that has been replaced on disk (e.g. after a qemu/libvirt upgrade), which libvirt
 * surfaces as "the VM needs to be restarted" and manifests in Linux as `/proc/<pid>/exe`
 * pointing at a path ending with " (deleted)".
 *
 * PID source: libvirt writes `/var/run/libvirt/qemu/<name>.pid` for each running VM.
 */
import { readFile, readlink } from 'node:fs/promises';

const QEMU_PIDFILE_DIR = '/var/run/libvirt/qemu';

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
