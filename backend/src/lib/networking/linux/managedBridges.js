/**
 * Netplan-managed VLAN bridges. Creates and deletes `<base>-vlanN` sub-bridges via
 * `wisp-bridge` (sudo helper) writing 91-wisp-vlan__*.yaml to /etc/netplan/.
 */
import { execFile as execFileCb } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createAppError } from '../../routeErrors.js';
import { isVlanLikeBridgeName } from '../bridgeNaming.js';
import { listHostBridges } from './hostBridges.js';

// vmManager / containerManager imported dynamically inside assertBridgeNotInUse to
// avoid a top-level-await cycle: vmManager → networking → managedBridges → vmManager.

const execFileAsync = promisify(execFileCb);

const NETPLAN_DIR = '/etc/netplan';
const FILE_PREFIX = '91-wisp-vlan__';
const FILE_SUFFIX = '.yaml';
const HELPER_NAME = 'wisp-bridge';
const HELPER_INSTALLED_PATH = `/usr/local/bin/${HELPER_NAME}`;
const HELPER_FALLBACK_PATH = fileURLToPath(new URL('../../scripts/wisp-bridge', import.meta.url));
const LINUX_IFACE_MAX = 15;

function isLinux() {
  return process.platform === 'linux';
}

function netplanFilename(baseBridge, vlanId, bridgeName) {
  return `${FILE_PREFIX}${baseBridge}__${vlanId}__${bridgeName}${FILE_SUFFIX}`;
}

function parseNetplanFilename(file) {
  if (!file.startsWith(FILE_PREFIX) || !file.endsWith(FILE_SUFFIX)) return null;
  const body = file.slice(FILE_PREFIX.length, -FILE_SUFFIX.length);
  const parts = body.split('__');
  if (parts.length !== 3) return null;
  const [baseBridge, vlanRaw, bridgeName] = parts;
  const vlanId = Number(vlanRaw);
  if (!baseBridge || !bridgeName || !Number.isInteger(vlanId)) return null;
  return { baseBridge, vlanId, bridgeName };
}

function assertBridgeNameFormat(name, field) {
  if (typeof name !== 'string' || !name.trim()) {
    throw createAppError('INVALID_NETWORK_BRIDGE_NAME', `${field} is required`);
  }
  const value = name.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value.includes('__')) {
    throw createAppError('INVALID_NETWORK_BRIDGE_NAME', `${field} contains invalid characters`);
  }
  if (value.length > LINUX_IFACE_MAX) {
    throw createAppError('INVALID_NETWORK_BRIDGE_NAME', `${field} exceeds ${LINUX_IFACE_MAX} characters`);
  }
  return value;
}

function normalizeVlanId(vlanId) {
  const n = Number(vlanId);
  if (!Number.isInteger(n) || n < 1 || n > 4094) {
    throw createAppError('INVALID_VLAN_ID', 'VLAN ID must be an integer between 1 and 4094');
  }
  return n;
}

async function interfaceExists(iface) {
  try {
    await access(`/sys/class/net/${iface}`);
    return true;
  } catch {
    return false;
  }
}

async function bridgeExists(iface) {
  try {
    await access(`/sys/class/net/${iface}/bridge`);
    return true;
  } catch {
    return false;
  }
}

async function isVlanInterface(iface) {
  try {
    const content = await readFile('/proc/net/vlan/config', 'utf8');
    const lines = content.split('\n');
    return lines.some((line) => line.startsWith(`${iface} |`));
  } catch {
    return false;
  }
}

async function bridgeHasNonVlanMember(bridgeName) {
  try {
    const members = await readdir(`/sys/class/net/${bridgeName}/brif`);
    if (members.length === 0) return false;
    for (const member of members) {
      if (isVlanLikeBridgeName(member)) continue;
      if (await isVlanInterface(member)) continue;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function getHelperPath() {
  try {
    await access(HELPER_INSTALLED_PATH);
    return HELPER_INSTALLED_PATH;
  } catch {
    try {
      await access(HELPER_FALLBACK_PATH);
      return HELPER_FALLBACK_PATH;
    } catch (err) {
      throw createAppError('NETWORK_BRIDGE_UNAVAILABLE', 'wisp-bridge helper not found', err.message);
    }
  }
}

async function runHelper(args) {
  const helperPath = await getHelperPath();
  const isRoot = process.getuid && process.getuid() === 0;
  try {
    if (isRoot) {
      await execFileAsync(helperPath, args, { timeout: 120000 });
    } else {
      await execFileAsync('sudo', ['-n', helperPath, ...args], { timeout: 120000 });
    }
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').trim() || 'helper failed';
    throw createAppError('NETWORK_BRIDGE_APPLY_FAILED', 'Failed to apply netplan bridge change', detail);
  }
}

function toManagedBridge(meta) {
  return {
    name: meta.bridgeName,
    baseBridge: meta.baseBridge,
    vlanId: meta.vlanId,
    vlanInterface: `${meta.baseBridge}.${meta.vlanId}`,
    file: `${NETPLAN_DIR}/${netplanFilename(meta.baseBridge, meta.vlanId, meta.bridgeName)}`,
  };
}

async function listManagedBridgeMeta() {
  if (!isLinux()) return [];
  let entries = [];
  try {
    entries = await readdir(NETPLAN_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of entries) {
    const parsed = parseNetplanFilename(file);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
}

export async function listManagedNetworkBridges() {
  const meta = await listManagedBridgeMeta();
  const out = [];
  for (const item of meta) {
    const data = toManagedBridge(item);
    out.push({
      ...data,
      present: await bridgeExists(item.bridgeName),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listEligibleParentBridges() {
  const bridges = await listHostBridges();
  const managed = await listManagedNetworkBridges();
  const managedNames = new Set(managed.map((b) => b.name));
  const eligible = [];
  for (const name of bridges) {
    if (managedNames.has(name)) continue;
    if (isVlanLikeBridgeName(name)) continue;
    if (await isVlanInterface(name)) continue;
    if (!(await bridgeHasNonVlanMember(name))) continue;
    eligible.push(name);
  }
  return eligible;
}

function expectedBridgeName(baseBridge, vlanId) {
  return `${baseBridge}-vlan${vlanId}`;
}

async function assertParentBridge(baseBridge) {
  if (!(await interfaceExists(baseBridge)) || !(await bridgeExists(baseBridge))) {
    throw createAppError('INVALID_NETWORK_BRIDGE_PARENT', `Parent bridge "${baseBridge}" does not exist`);
  }
  if (isVlanLikeBridgeName(baseBridge) || (await isVlanInterface(baseBridge))) {
    throw createAppError('INVALID_NETWORK_BRIDGE_PARENT', 'Parent bridge cannot be VLAN-tagged');
  }
  if (!(await bridgeHasNonVlanMember(baseBridge))) {
    throw createAppError(
      'INVALID_NETWORK_BRIDGE_PARENT',
      `Parent bridge "${baseBridge}" must have at least one non-VLAN member`,
    );
  }
}

async function assertCreateInput(baseBridgeRaw, vlanRaw) {
  if (!isLinux()) {
    throw createAppError('NETWORK_BRIDGE_UNAVAILABLE', 'Network bridge management is only supported on Linux');
  }
  const baseBridge = assertBridgeNameFormat(baseBridgeRaw, 'baseBridge');
  const vlanId = normalizeVlanId(vlanRaw);
  await assertParentBridge(baseBridge);
  const bridgeName = expectedBridgeName(baseBridge, vlanId);
  assertBridgeNameFormat(bridgeName, 'bridgeName');
  const vlanInterface = `${baseBridge}.${vlanId}`;
  if (vlanInterface.length > LINUX_IFACE_MAX) {
    throw createAppError('INVALID_NETWORK_BRIDGE_NAME', `VLAN interface "${vlanInterface}" exceeds ${LINUX_IFACE_MAX} characters`);
  }
  return { baseBridge, vlanId, bridgeName };
}

async function assertBridgeNotInUse(bridgeName) {
  const [{ listVMs, getVMConfig }, { listContainers, getContainerConfig }] = await Promise.all([
    import('../../vmManager.js'),
    import('../../containerManager.js'),
  ]);

  const vmRefs = [];
  const vms = await listVMs();
  for (const vm of vms) {
    try {
      const config = await getVMConfig(vm.name);
      const nics = Array.isArray(config.nics) ? config.nics : [];
      if (nics.some((nic) => nic?.type === 'bridge' && nic?.source === bridgeName)) {
        vmRefs.push(vm.name);
      }
    } catch {
      /* skip VM if config unavailable */
    }
  }

  const containerRefs = [];
  const containers = await listContainers();
  for (const container of containers) {
    try {
      const config = await getContainerConfig(container.name);
      if (config?.network?.interface === bridgeName) {
        containerRefs.push(container.name);
      }
    } catch {
      /* skip container if config unavailable */
    }
  }

  if (vmRefs.length === 0 && containerRefs.length === 0) return;
  const detail = [
    vmRefs.length ? `VMs: ${vmRefs.slice(0, 5).join(', ')}` : null,
    containerRefs.length ? `Containers: ${containerRefs.slice(0, 5).join(', ')}` : null,
  ].filter(Boolean).join(' | ');
  throw createAppError('NETWORK_BRIDGE_IN_USE', `Bridge "${bridgeName}" is in use and cannot be deleted`, detail);
}

export async function createManagedNetworkBridge(input) {
  const { baseBridge, vlanId, bridgeName } = await assertCreateInput(input?.baseBridge, input?.vlanId);
  if (await interfaceExists(bridgeName)) {
    throw createAppError('NETWORK_BRIDGE_EXISTS', `Bridge "${bridgeName}" already exists`);
  }
  const managed = await listManagedBridgeMeta();
  if (managed.some((m) => m.bridgeName === bridgeName)) {
    throw createAppError('NETWORK_BRIDGE_EXISTS', `Bridge "${bridgeName}" already exists`);
  }

  await runHelper([
    'create-vlan-bridge',
    '--base',
    baseBridge,
    '--vlan',
    String(vlanId),
    '--name',
    bridgeName,
    '--file-name',
    netplanFilename(baseBridge, vlanId, bridgeName),
  ]);

  return {
    name: bridgeName,
    baseBridge,
    vlanId,
    vlanInterface: `${baseBridge}.${vlanId}`,
    present: await bridgeExists(bridgeName),
  };
}

export async function deleteManagedNetworkBridge(nameRaw) {
  if (!isLinux()) {
    throw createAppError('NETWORK_BRIDGE_UNAVAILABLE', 'Network bridge management is only supported on Linux');
  }
  const name = assertBridgeNameFormat(nameRaw, 'name');
  const managed = await listManagedBridgeMeta();
  const target = managed.find((m) => m.bridgeName === name);
  if (!target) {
    throw createAppError('NETWORK_BRIDGE_NOT_FOUND', `Managed bridge "${name}" not found`);
  }
  await assertBridgeNotInUse(name);

  await runHelper([
    'delete-vlan-bridge',
    '--base',
    target.baseBridge,
    '--vlan',
    String(target.vlanId),
    '--name',
    name,
    '--file-name',
    netplanFilename(target.baseBridge, target.vlanId, target.bridgeName),
  ]);

  return { ok: true };
}
