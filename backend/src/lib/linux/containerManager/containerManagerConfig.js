/**
 * Update container configuration.
 * Changes are written to container.json; running containers need a restart for most changes.
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';
import { getTaskState } from './containerManagerLifecycle.js';
import { normalizeMacvlanMac } from './containerManagerNetwork.js';
import { deregisterAddress, registerAddress, sanitizeHostname } from '../../mdnsManager.js';
import { validateAndNormalizeMounts, ensureMissingMountArtifacts } from './containerManagerMounts.js';
import { deleteMountBackingStore } from './containerManagerMountsContent.js';

const RESTART_FIELDS = new Set([
  'image', 'command', 'cpuLimit', 'memoryLimitMiB', 'env', 'mounts', 'network', 'runAsRoot',
]);

function networkMacOrInterfaceChanged(prev, next) {
  const pm = prev?.mac ? (normalizeMacvlanMac(prev.mac) || '') : '';
  const nm = next?.mac ? (normalizeMacvlanMac(next.mac) || '') : '';
  if (pm !== nm) return true;
  if ((prev?.interface || '') !== (next?.interface || '')) return true;
  return false;
}

/**
 * Partially update a container's config. Returns { requiresRestart: boolean }.
 */
export async function updateContainerConfig(name, changes) {
  const dir = getContainerDir(name);
  const configPath = join(dir, 'container.json');

  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
  }

  let requiresRestart = false;
  /** @type {{ type: string, name: string, containerPath: string, readonly: boolean }[] | null} */
  let mountsPersisted = null;
  const task = await getTaskState(name);
  const isRunning = task && (task.status === 'RUNNING' || task.status === 'PAUSED');

  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name' || key === 'createdAt' || key === 'state') continue;
    if (key === 'iconId') {
      if (value == null || value === '') {
        delete config.iconId;
      } else {
        config.iconId = String(value).trim();
      }
      continue;
    }
    if (key === 'network') {
      if (value == null || typeof value !== 'object') {
        throw containerError('CONFIG_ERROR', 'network must be an object');
      }
      const prevNet = { ...(config.network || {}) };
      const toMerge = { ...value };
      if (isRunning) {
        delete toMerge.ip;
      }
      const merged = { ...(config.network || {}), ...toMerge };

      if (merged.type === 'macvlan') {
        if (merged.mac == null || String(merged.mac).trim() === '') {
          throw containerError('INVALID_CONTAINER_MAC', 'MAC address is required for macvlan');
        }
        const norm = normalizeMacvlanMac(merged.mac);
        if (!norm) throw containerError('INVALID_CONTAINER_MAC', 'Invalid MAC address format');
        merged.mac = norm;
      } else if (merged.mac != null && String(merged.mac).trim() !== '') {
        const norm = normalizeMacvlanMac(merged.mac);
        if (!norm) throw containerError('INVALID_CONTAINER_MAC', 'Invalid MAC address format');
        merged.mac = norm;
      }
      // Container network selection is interface-based; ignore legacy vlan fields.
      delete merged.vlan;

      if (isRunning && networkMacOrInterfaceChanged(prevNet, merged)) {
        throw containerError(
          'CONTAINER_MUST_BE_STOPPED',
          'Stop the container before changing MAC or interface',
        );
      }

      config.network = merged;
      if (isRunning && RESTART_FIELDS.has(key)) requiresRestart = true;
      continue;
    }
    if (key === 'localDns') {
      config.localDns = value === true;
      continue;
    }
    if (key === 'mounts') {
      const prevMounts = Array.isArray(config.mounts) ? [...config.mounts] : [];
      const normalized = validateAndNormalizeMounts(value);
      const nextNames = new Set(normalized.map((m) => m.name));
      for (const m of prevMounts) {
        if (!nextNames.has(m.name)) {
          await deleteMountBackingStore(name, m);
        }
      }
      config.mounts = normalized;
      mountsPersisted = normalized;
      if (isRunning && RESTART_FIELDS.has(key)) requiresRestart = true;
      continue;
    }
    config[key] = value;
    if (isRunning && RESTART_FIELDS.has(key)) requiresRestart = true;
  }

  if (changes.localDns === false) {
    await deregisterAddress(name);
  } else if (changes.localDns === true && isRunning && config.network?.ip) {
    await registerAddress(name, sanitizeHostname(name), config.network.ip);
  }

  await writeFile(configPath, JSON.stringify(config, null, 2));
  if (mountsPersisted) {
    await ensureMissingMountArtifacts(name, mountsPersisted);
  }
  return { requiresRestart };
}
