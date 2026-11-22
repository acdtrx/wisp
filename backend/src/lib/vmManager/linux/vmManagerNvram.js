/**
 * UEFI NVRAM copy via the wisp-nvram privileged helper. libvirt creates VARS.fd
 * as libvirt-qemu:kvm mode 600; group membership in kvm doesn't grant read,
 * so an in-process copyFile EACCEs. Helper does cp + chown back to deploy user.
 */
import { vmError } from './vmManagerConnection.js';
import { runPrivileged, helperPath } from '../../base/index.js';

// allowMissing: if src doesn't exist, return silently — used by callers that
// want ENOENT to be a legitimate skip (BIOS-only VM, NVRAM declared in XML but
// not yet on disk) while still surfacing permission/IO failures loudly.
export async function copyNvram(src, dst, { allowMissing = false } = {}) {
  try {
    // An NVRAM file is a few MB; 60 s means the copy hung (CODING-RULES §6).
    await runPrivileged(helperPath('wisp-nvram'), ['copy', src, dst], { timeoutMs: 60_000 });
  } catch (err) {
    const stderr = (err && err.stderr) || '';
    const isMissing = /src not found/i.test(stderr) || (err && err.exitCode === 2);
    if (isMissing && allowMissing) return;
    throw vmError(
      'NVRAM_COPY_FAILED',
      `Failed to copy NVRAM ${src} → ${dst}`,
      stderr || (err && err.message) || String(err),
    );
  }
}
