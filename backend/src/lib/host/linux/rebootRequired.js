/**
 * Host reboot-required signal.
 *
 * Debian/Ubuntu: /var/run/reboot-required exists when a reboot is pending (created by
 *   update-notifier-common on package upgrades). /var/run/reboot-required.pkgs lists the
 *   triggering packages, one per line.
 * Arch Linux: no official marker. Compare the running kernel (`uname -r`) with the newest
 *   kernel module directory under /usr/lib/modules/; if they differ, a reboot is pending.
 *   Catches kernel upgrades only (not glibc/critical libs — needrestart would be required).
 */
import { readFile, readdir, access } from 'node:fs/promises';
import { release as kernelRelease } from 'node:os';

const UBUNTU_MARKER = '/var/run/reboot-required';
const UBUNTU_PKGS = '/var/run/reboot-required.pkgs';
const ARCH_MODULES_DIR = '/usr/lib/modules';

let cachedDistro;

async function detectDistro() {
  if (cachedDistro !== undefined) return cachedDistro;
  try {
    const content = await readFile('/etc/os-release', 'utf8');
    const obj = {};
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) obj[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
    const id = (obj.ID || '').toLowerCase();
    const idLike = (obj.ID_LIKE || '').toLowerCase();
    if (id === 'arch' || idLike.includes('arch')) cachedDistro = 'arch';
    else if (['ubuntu', 'debian'].includes(id) || /debian|ubuntu/.test(idLike)) cachedDistro = 'debian';
    else cachedDistro = 'unknown';
  } catch {
    cachedDistro = 'unknown';
  }
  return cachedDistro;
}

async function getDebianSignal() {
  try {
    await access(UBUNTU_MARKER);
  } catch {
    return { required: false, reasons: [] };
  }
  let reasons = [];
  try {
    const pkgs = await readFile(UBUNTU_PKGS, 'utf8');
    reasons = pkgs.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    /* marker exists but pkgs file missing or unreadable — still flag as required */
  }
  return { required: true, reasons };
}

/** Compare numeric segments of two kernel versions; ignore non-numeric suffixes. */
function compareKernelVersions(a, b) {
  const parse = (s) => s.split(/[.-]/).map((x) => {
    const n = parseInt(x, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  const [pa, pb] = [parse(a), parse(b)];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function getArchSignal() {
  const running = kernelRelease();
  let entries = [];
  try {
    entries = await readdir(ARCH_MODULES_DIR);
  } catch {
    return { required: false, reasons: [] };
  }
  if (entries.length === 0) return { required: false, reasons: [] };
  const latest = entries.slice().sort(compareKernelVersions).pop();
  if (!latest || latest === running) return { required: false, reasons: [] };
  /* Only flag if the installed kernel is strictly newer than the running one. */
  if (compareKernelVersions(latest, running) <= 0) return { required: false, reasons: [] };
  return { required: true, reasons: [`kernel ${running} → ${latest}`] };
}

/**
 * @returns {Promise<{ required: boolean, reasons: string[] }>}
 */
export async function getRebootSignal() {
  const distro = await detectDistro();
  if (distro === 'debian') return getDebianSignal();
  if (distro === 'arch') return getArchSignal();
  return { required: false, reasons: [] };
}
