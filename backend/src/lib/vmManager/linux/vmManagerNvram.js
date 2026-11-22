/**
 * UEFI NVRAM copy via the wisp-nvram privileged helper. libvirt creates VARS.fd
 * as libvirt-qemu:kvm mode 600; group membership in kvm doesn't grant read,
 * so an in-process copyFile EACCEs. Helper does cp + chown back to deploy user.
 */
import { vmError } from './vmManagerConnection.js';
import { runPrivileged, helperPath } from '../../base/index.js';

/* The helper's worst case: its copy's 30 s and three quick steps of 10 s, each
 * with 2 s to end, ends inside this. */
const NVRAM_COPY_TIMEOUT_MS = 75_000;

// allowMissing: if src doesn't exist, return silently — used by callers that
// want a missing file to be a legitimate skip (BIOS-only VM, NVRAM declared in
// XML but not yet on disk) while still surfacing permission/IO failures loudly.
export async function copyNvram(src, dst, { allowMissing = false } = {}) {
  try {
    await runPrivileged(helperPath('wisp-nvram'), ['copy', src, dst], { timeoutMs: NVRAM_COPY_TIMEOUT_MS });
  } catch (err) {
    if (err.reason === 'not-found' && allowMissing) return;
    throw vmError('NVRAM_COPY_FAILED', `Failed to copy NVRAM ${src} → ${dst}`, err.detail ?? err.message);
  }
}
