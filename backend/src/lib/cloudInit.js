import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink, mkdir, rmdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

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
 * @param {{ firstNicMac?: string }} [opts] - optional; if firstNicMac is set, emit network config matching that MAC so netplan applies to the VM's real NIC
 */
export async function generateCloudInitISO(vmName, config, opts = {}) {
  const { firstNicMac } = opts;
  const vmBasePath = getVMBasePath(vmName);
  await mkdir(vmBasePath, { recursive: true });
  const isoPath = join(vmBasePath, 'cloud-init.iso');
  const tmpDir = join(tmpdir(), `wisp-ci-${randomBytes(6).toString('hex')}`);

  await mkdir(tmpDir, { recursive: true });

  try {
    // Build meta-data
    const metaData = [
      `instance-id: ${vmName}`,
      `local-hostname: ${config.hostname || vmName}`,
    ].join('\n') + '\n';

    // Build user-data
    const userLines = ['#cloud-config'];
    userLines.push(`hostname: ${config.hostname || vmName}`);

    // Network: match domain's first NIC by MAC so distro netplan applies to the real interface
    if (firstNicMac) {
      userLines.push('network:');
      userLines.push('  version: 2');
      userLines.push('  ethernets:');
      userLines.push('    default:');
      userLines.push('      match:');
      userLines.push(`        macaddress: "${firstNicMac}"`);
      userLines.push('      dhcp4: true');
    }

    // User block
    const userEntry = {
      name: config.username || 'wisp',
      sudo: 'ALL=(ALL) NOPASSWD:ALL',
      shell: '/bin/bash',
      lock_passwd: true,
    };

    if (config.password) {
      userEntry.passwd = await hashPassword(config.password);
      userEntry.lock_passwd = false;
    }

    if (config.sshKey) {
      userEntry.ssh_authorized_keys = [config.sshKey];
    }

    // YAML for users — hand-built to avoid a YAML library dependency
    userLines.push('users:');
    userLines.push('  - default');
    userLines.push(`  - name: ${userEntry.name}`);
    userLines.push(`    sudo: "${userEntry.sudo}"`);
    userLines.push(`    shell: ${userEntry.shell}`);
    userLines.push(`    lock_passwd: ${userEntry.lock_passwd}`);
    if (userEntry.passwd) {
      userLines.push(`    passwd: "${userEntry.passwd}"`);
    }
    if (userEntry.ssh_authorized_keys) {
      userLines.push('    ssh_authorized_keys:');
      for (const key of userEntry.ssh_authorized_keys) {
        userLines.push(`      - "${key}"`);
      }
    }

    if (config.packageUpgrade) {
      userLines.push('package_upgrade: true');
    }

    if (config.growPartition) {
      userLines.push('growpart:');
      userLines.push('  mode: auto');
      userLines.push('  devices:');
      userLines.push("    - '/'");
    }

    const packages = [];
    if (config.installQemuGuestAgent !== false) packages.push('qemu-guest-agent');
    if (config.installAvahiDaemon !== false) packages.push('avahi-daemon');
    if (packages.length > 0) {
      userLines.push('packages:');
      for (const pkg of packages) {
        userLines.push(`  - ${pkg}`);
      }
    }

    const userData = userLines.join('\n') + '\n';

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

    return isoPath;
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
