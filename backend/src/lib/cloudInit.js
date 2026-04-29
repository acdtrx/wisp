import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink, mkdir, rmdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import yaml from 'js-yaml';

import { getVMBasePath } from './paths.js';
import { createAppError } from './routeErrors.js';

const execFile = promisify(execFileCb);

// ─── Password Hashing ───────────────────────────

async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const proc = spawn('openssl', ['passwd', '-6', '-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(createAppError('HASH_FAILED', 'Failed to hash password', err.message)));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(createAppError('HASH_FAILED', 'Failed to hash password', stderr || `openssl exited ${code}`));
    });
    proc.stdin.end(password, 'utf8');
  });
}

// ─── ISO Generation ─────────────────────────────

/**
 * @param {string} vmName
 * @param {object} config - cloud-init config (hostname, username, password, etc.)
 * @param {{ firstNicMac?: string, priorPasswordHash?: string }} [opts]
 *   firstNicMac: when set, emit network config matching that MAC so netplan applies to the VM's real NIC.
 *   priorPasswordHash: hashed password from a previous save. Used when the caller passes the `***` placeholder back in (the UI sends `'set'` / `'***'` to mean "leave password unchanged"); we re-emit the prior hash instead of re-hashing the placeholder string.
 */
export async function generateCloudInitISO(vmName, config, opts = {}) {
  const { firstNicMac, priorPasswordHash } = opts;
  const vmBasePath = getVMBasePath(vmName);
  await mkdir(vmBasePath, { recursive: true });
  const isoPath = join(vmBasePath, 'cloud-init.iso');
  const tmpDir = join(tmpdir(), `wisp-ci-${randomBytes(6).toString('hex')}`);

  await mkdir(tmpDir, { recursive: true });

  try {
    const hostname = config.hostname || vmName;

    // Build meta-data through js-yaml so any unusual hostname is properly quoted.
    const metaData = yaml.dump(
      { 'instance-id': vmName, 'local-hostname': hostname },
      { lineWidth: -1, noRefs: true },
    );

    // The UI sends `'***'` (or legacy `'set'`) to mean "keep the existing password".
    // Never feed those placeholders to openssl — that would silently set the VM
    // password to the literal placeholder string. Reuse the stored hash instead.
    const isPasswordPlaceholder = config.password === '***' || config.password === 'set';
    let resolvedPasswordHash = '';
    if (config.password && !isPasswordPlaceholder) {
      resolvedPasswordHash = await hashPassword(config.password);
    } else if (isPasswordPlaceholder && priorPasswordHash) {
      resolvedPasswordHash = priorPasswordHash;
    }

    const userEntry = {
      name: config.username || 'wisp',
      sudo: 'ALL=(ALL) NOPASSWD:ALL',
      shell: '/bin/bash',
      lock_passwd: !resolvedPasswordHash,
    };
    if (resolvedPasswordHash) userEntry.passwd = resolvedPasswordHash;
    if (config.sshKey) {
      const keys = String(config.sshKey)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (keys.length) userEntry.ssh_authorized_keys = keys;
    }

    const userDataObj = {
      hostname,
      users: ['default', userEntry],
    };
    if (firstNicMac) {
      userDataObj.network = {
        version: 2,
        ethernets: {
          default: {
            match: { macaddress: firstNicMac },
            dhcp4: true,
          },
        },
      };
    }
    if (config.packageUpgrade) userDataObj.package_upgrade = true;
    if (config.growPartition) {
      userDataObj.growpart = { mode: 'auto', devices: ['/'] };
    }
    const packages = [];
    if (config.installQemuGuestAgent !== false) packages.push('qemu-guest-agent');
    if (config.installAvahiDaemon !== false) packages.push('avahi-daemon');
    if (packages.length) userDataObj.packages = packages;

    const userData =
      '#cloud-config\n' + yaml.dump(userDataObj, { lineWidth: -1, noRefs: true });

    await writeFile(join(tmpDir, 'meta-data'), metaData);
    await writeFile(join(tmpDir, 'user-data'), userData);

    // Try cloud-localds first, fall back to genisoimage
    try {
      await execFile('cloud-localds', [
        isoPath,
        join(tmpDir, 'user-data'),
        join(tmpDir, 'meta-data'),
      ]);
    } catch {
      /* cloud-localds missing — use genisoimage */
      await execFile('genisoimage', [
        '-output', isoPath,
        '-V', 'cidata',
        '-r', '-J',
        join(tmpDir, 'user-data'),
        join(tmpDir, 'meta-data'),
      ]);
    }

    return { isoPath, passwordHash: resolvedPasswordHash };
  } finally {
    // Clean up temp dir; ignore errors if already removed
    await unlink(join(tmpDir, 'meta-data')).catch(() => {
      /* temp cleanup */
    });
    await unlink(join(tmpDir, 'user-data')).catch(() => {
      /* temp cleanup */
    });
    await rmdir(tmpDir).catch(() => {
      /* temp cleanup */
    });
  }
}

export async function deleteCloudInitISO(vmName) {
  const isoPath = join(getVMBasePath(vmName), 'cloud-init.iso');
  await unlink(isoPath).catch(() => {
    /* may not exist */
  });
}

// ─── Config Persistence ─────────────────────────

function configPath(vmName) {
  return join(getVMBasePath(vmName), 'cloud-init.json');
}

export async function saveCloudInitConfig(vmName, config) {
  const basePath = getVMBasePath(vmName);
  await mkdir(basePath, { recursive: true });
  await writeFile(configPath(vmName), JSON.stringify(config, null, 2));
}

export async function loadCloudInitConfig(vmName) {
  try {
    await access(configPath(vmName), constants.R_OK);
    const raw = await readFile(configPath(vmName), 'utf-8');
    return JSON.parse(raw);
  } catch {
    /* no saved cloud-init config */
    return null;
  }
}

export async function deleteCloudInitConfig(vmName) {
  await unlink(configPath(vmName)).catch(() => {
    /* config file may not exist */
  });
}
