/**
 * Cloud-init: Wisp app glue.
 *
 * Owns:
 *   - building the cloud-init ISO (cloud-localds / genisoimage) with hashed password
 *     and netplan match,
 *   - persisting cloud-init.json next to the VM,
 *   - orchestrating attach/detach against vmManager via the generic ISO primitives
 *     (`attachISO(name, slot, path, { createIfMissing: true })` /
 *      `ejectISO(name, slot, { removeSlot: true })`).
 *
 * vmManager itself never imports this file — the route layer (and previously
 * `vmManagerCloudInit.js` until step 6 moved it here) drives the orchestration.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink, mkdir, rmdir, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import yaml from 'js-yaml';

import { getVMBasePath } from './paths.js';
import { createAppError } from './routeErrors.js';
import {
  attachISO,
  ejectISO,
  getVMXML,
  parseVMFromXML,
} from './vmManager/index.js';

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

// ─── Orchestration (called from routes/cloudinit.js + routes/vms.js) ─────

/** Build the ISO and persist the config. Looks up the first NIC's MAC if the VM
 * already exists so netplan match works against the real interface. */
export async function generateCloudInit(vmName, config) {
  let firstNicMac;
  try {
    const xml = await getVMXML(vmName);
    const vm = parseVMFromXML(xml);
    firstNicMac = vm?.nics?.[0]?.mac ?? undefined;
  } catch {
    /* VM missing or XML unreadable (typical at create time before define) — cloud-init
       still works without a MAC hint; netplan falls back to default match. */
    firstNicMac = undefined;
  }

  const prior = await loadCloudInitConfig(vmName);
  const priorPasswordHash = prior?.passwordHash || '';

  const { isoPath, passwordHash } = await generateCloudInitISO(vmName, config, {
    firstNicMac,
    priorPasswordHash,
  });

  const stored = {
    ...config,
    enabled: true,
    password: passwordHash ? '***' : '',
    passwordHash: passwordHash || '',
  };
  await saveCloudInitConfig(vmName, stored);
  return isoPath;
}

function mergeCloudInitDisablePayload(existing, incoming) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const { enabled: _en, password: incomingPassword, ...rest } = incoming;
  const merged = { ...base, ...rest, enabled: false };
  // `passwordHash` is internal — preserve from prior state, never accept from client.
  merged.passwordHash = base.passwordHash || '';
  const isPlaceholder = incomingPassword === '***' || incomingPassword === 'set';
  if (incomingPassword && !isPlaceholder && String(incomingPassword).trim() !== '') {
    // A new plaintext password came in even though we're disabling — store
    // the placeholder; the hash will be regenerated when cloud-init is
    // re-enabled.
    merged.password = '***';
  } else if (base.password !== undefined && base.password !== '') {
    merged.password = base.password;
  } else if (merged.passwordHash) {
    merged.password = '***';
  } else {
    merged.password = '';
  }
  return merged;
}

/** Attach (or update) the cloud-init ISO at sde via the generic vmManager primitive. */
export async function attachCloudInitDisk(vmName) {
  const isoPath = join(getVMBasePath(vmName), 'cloud-init.iso');
  await attachISO(vmName, 'sde', isoPath, { createIfMissing: true });
}

/** Detach the cloud-init disk from sde (best-effort), remove the ISO file, and clear the JSON config. */
export async function detachCloudInitDisk(vmName) {
  await ejectISO(vmName, 'sde', { removeSlot: true });
  await deleteCloudInitISO(vmName);
  await deleteCloudInitConfig(vmName);
}

export async function getCloudInitConfig(vmName) {
  const config = await loadCloudInitConfig(vmName);
  if (!config) return null;
  // Internal-only fields (passwordHash) must not flow back to the client.
  const { passwordHash: _hash, ...safe } = config;
  const hasPassword = Boolean(safe.password) || Boolean(_hash);
  return {
    ...safe,
    enabled: safe.enabled !== false,
    password: hasPassword ? 'set' : '',
    sshKey: safe.sshKey || '',
  };
}

export async function updateCloudInit(vmName, config, log) {
  if (config.enabled === false) {
    const existing = await loadCloudInitConfig(vmName);
    const merged = mergeCloudInitDisablePayload(existing, config);
    await ejectISO(vmName, 'sde', { removeSlot: true });
    await deleteCloudInitISO(vmName);
    await saveCloudInitConfig(vmName, merged);
    return;
  }

  await generateCloudInit(vmName, config);
  try {
    await attachCloudInitDisk(vmName);
  } catch (err) {
    /* ISO regenerated; live attach can fail if VM state disallows it — config still saved */
    log?.warn?.({ err: err.message, vm: vmName }, '[cloudInit] Could not hot-swap cloud-init disk');
  }
}
