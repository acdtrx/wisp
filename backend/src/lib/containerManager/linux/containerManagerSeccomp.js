/**
 * Default seccomp filter for container tasks: Docker's default profile
 * (`seccomp/default.json`, vendored unmodified from moby/profiles — Apache-2.0,
 * attribution and license in `seccomp/NOTICE.txt`), converted to the OCI
 * `linux.seccomp` shape exactly as moby's `setupSeccomp` does it:
 *
 *   - `architectures` = the archMap entry for the host arch plus its sub-arches;
 *   - each syscall rule is kept or dropped by its `includes` / `excludes`
 *     conditions — arch, capabilities (all `includes.caps` must be in the
 *     bounding set; any `excludes.caps` present drops it), and `minKernel`
 *     against the running kernel's major.minor;
 *   - `comment`, `includes` and `excludes` never reach the runtime.
 *
 * The profile allows ~370 syscalls and answers everything else with EPERM;
 * with the default capability set (no CAP_SYS_ADMIN) it also blocks namespace
 * creation via clone flags, returns ENOSYS for clone3 (libc falls back to
 * clone), and refuses AF_ALG / AF_VSOCK sockets.
 */
import { release } from 'node:os';

import profile from './seccomp/default.json' with { type: 'json' };

/** Node `process.arch` → the libseccomp-style name the profile's `arches` lists use. */
const NODE_TO_PROFILE_ARCH = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'arm',
  ia32: 'x86',
  loong64: 'loongarch64',
  ppc64: 'ppc64le',
  riscv64: 'riscv64',
  s390x: 's390x',
};

/** Profile arch name → OCI/libseccomp architecture constant. */
const PROFILE_TO_SECCOMP_ARCH = {
  amd64: 'SCMP_ARCH_X86_64',
  arm64: 'SCMP_ARCH_AARCH64',
  arm: 'SCMP_ARCH_ARM',
  x86: 'SCMP_ARCH_X86',
  loongarch64: 'SCMP_ARCH_LOONGARCH64',
  ppc64le: 'SCMP_ARCH_PPC64LE',
  riscv64: 'SCMP_ARCH_RISCV64',
  s390x: 'SCMP_ARCH_S390X',
};

function parseKernelVersion(text) {
  const m = /^(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function kernelAtLeast(kernel, minText) {
  const min = parseKernelVersion(minText);
  if (!kernel || !min) return false;
  return kernel.major > min.major || (kernel.major === min.major && kernel.minor >= min.minor);
}

/**
 * Convert a moby-format profile for one host and capability set.
 * @param {object} src - moby-format profile (archMap + conditional syscall rules)
 * @param {{ arch: string, kernelRelease: string, boundingCaps: string[] }} host
 *   arch: profile arch name (e.g. 'amd64'); kernelRelease: `uname -r`.
 * @returns {object} OCI `linux.seccomp`
 */
export function convertSeccompProfile(src, { arch, kernelRelease, boundingCaps }) {
  const kernel = parseKernelVersion(kernelRelease);
  const caps = new Set(boundingCaps);

  const architectures = [];
  const seccompArch = PROFILE_TO_SECCOMP_ARCH[arch];
  const archEntry = seccompArch ? (src.archMap || []).find((a) => a.architecture === seccompArch) : null;
  if (archEntry) architectures.push(archEntry.architecture, ...(archEntry.subArchitectures || []));

  const syscalls = [];
  for (const call of src.syscalls || []) {
    const exc = call.excludes;
    if (exc) {
      if (exc.arches?.includes(arch)) continue;
      if (exc.caps?.some((c) => caps.has(c))) continue;
      if (exc.minKernel && kernelAtLeast(kernel, exc.minKernel)) continue;
    }
    const inc = call.includes;
    if (inc) {
      if (inc.arches?.length && !inc.arches.includes(arch)) continue;
      if (inc.caps?.length && !inc.caps.every((c) => caps.has(c))) continue;
      if (inc.minKernel && !kernelAtLeast(kernel, inc.minKernel)) continue;
    }
    const rule = { names: call.names || [call.name], action: call.action };
    if (call.args?.length) rule.args = call.args;
    if (call.errnoRet != null) rule.errnoRet = call.errnoRet;
    syscalls.push(rule);
  }

  const out = { defaultAction: src.defaultAction };
  if (src.defaultErrnoRet != null) out.defaultErrnoRet = src.defaultErrnoRet;
  if (architectures.length) out.architectures = architectures;
  out.syscalls = syscalls;
  return out;
}

const cache = new Map();

/**
 * The default profile for this host and the given bounding capability set.
 * Memoized: the result depends only on the caps, which are constant per process.
 * @param {string[]} boundingCaps
 * @returns {object} OCI `linux.seccomp`
 */
export function defaultSeccompProfile(boundingCaps) {
  const key = [...boundingCaps].sort().join(',');
  if (!cache.has(key)) {
    cache.set(key, convertSeccompProfile(profile, {
      arch: NODE_TO_PROFILE_ARCH[process.arch] || process.arch,
      kernelRelease: release(),
      boundingCaps,
    }));
  }
  return cache.get(key);
}
