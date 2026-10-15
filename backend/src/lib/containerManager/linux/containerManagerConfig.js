/**
 * Update container configuration.
 * Changes are written to container.json; running containers need a restart for most changes.
 */
import { containerError } from './containerManagerConnection.js';
import { getTaskState } from './containerManagerLifecycle.js';
import { normalizeContainerMac } from './containerManagerNetwork.js';
import { deregisterServicesForContainer } from '../../mdns/index.js';
import { registerAllContainerServices } from './containerManagerServices.js';
import { validateAndNormalizeMounts, ensureMissingMountArtifacts } from './containerManagerMounts.js';
import { validateAndNormalizeDevices } from './containerManagerDevices.js';
import { renameMountBackingStore } from './containerManagerMountsContent.js';
import { resolveMount } from './containerPaths.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { RESTART_POLICIES } from './containerManagerRestartPolicy.js';

const RESTART_FIELDS = new Set([
  'image', 'command', 'cpuLimit', 'memoryLimitMiB', 'env', 'mounts', 'devices', 'network', 'runAsRoot',
]);

/**
 * Apply an envPatch delta to config.env (structured shape: { KEY: { value, secret? } }).
 * Returns true if anything actually changed.
 *
 * Delta semantics:
 *   envPatch[key] === null            → delete key
 *   envPatch[key] = { value?, secret? } → upsert; fields omitted are preserved
 *
 * Special rules:
 *   - Marking a key secret → non-secret without providing a new value resets the
 *     value to "" (so stored secrets are never leaked through the flag toggle).
 *   - Adding a brand-new key with secret:true requires an explicit value.
 */
function applyEnvPatch(config, envPatch) {
  if (!envPatch || typeof envPatch !== 'object' || Array.isArray(envPatch)) {
    throw containerError('CONFIG_ERROR', 'envPatch must be an object');
  }
  if (!config.env || typeof config.env !== 'object') config.env = {};
  let mutated = false;

  for (const [rawKey, entry] of Object.entries(envPatch)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!key) {
      throw containerError('CONFIG_ERROR', 'envPatch keys must be non-empty strings');
    }

    if (entry === null) {
      if (key in config.env) {
        delete config.env[key];
        mutated = true;
      }
      continue;
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw containerError('CONFIG_ERROR', `envPatch entry for "${key}" must be an object or null`);
    }
    if ('value' in entry && entry.value != null && typeof entry.value !== 'string') {
      throw containerError('CONFIG_ERROR', `envPatch value for "${key}" must be a string`);
    }
    if ('secret' in entry && typeof entry.secret !== 'boolean') {
      throw containerError('CONFIG_ERROR', `envPatch secret flag for "${key}" must be boolean`);
    }

    const prev = config.env[key];
    const prevExists = !!prev && typeof prev === 'object';
    const prevSecret = !!(prevExists && prev.secret);
    const prevValue = prevExists && typeof prev.value === 'string' ? prev.value : '';

    const nextSecret = 'secret' in entry ? !!entry.secret : prevSecret;

    let nextValue;
    if ('value' in entry && typeof entry.value === 'string') {
      nextValue = entry.value;
    } else if (prevSecret && !nextSecret) {
      // secret → non-secret without explicit value: clear per UX contract.
      nextValue = '';
    } else if (prevExists) {
      nextValue = prevValue;
    } else {
      nextValue = '';
    }

    if (!prevExists && nextSecret && !('value' in entry && typeof entry.value === 'string')) {
      throw containerError('CONFIG_ERROR', `Secret env var "${key}" requires a value`);
    }

    const nextEntry = nextSecret ? { value: nextValue, secret: true } : { value: nextValue };

    if (!prevExists
      || prevSecret !== nextSecret
      || prevValue !== nextValue) {
      config.env[key] = nextEntry;
      mutated = true;
    }
  }

  return mutated;
}

function networkMacOrInterfaceChanged(prev, next) {
  const pm = prev?.mac ? (normalizeContainerMac(prev.mac) || '') : '';
  const nm = next?.mac ? (normalizeContainerMac(next.mac) || '') : '';
  if (pm !== nm) return true;
  if ((prev?.interface || '') !== (next?.interface || '')) return true;
  return false;
}

/**
 * Validate `mountRenames` ({ oldName: newName }) against the mount list being
 * replaced and its replacement. A rename says "this mount is the same one under
 * a new name": `oldName` must be a current mount, `newName` a mount of the same
 * type in the new list that isn't a current mount (swaps and chains need two
 * saves). The old name may reappear in the new list as a fresh mount.
 * Returns [[prevEntry, nextEntry], …].
 */
function resolveMountRenames(mountRenames, prevMounts, nextMounts) {
  if (mountRenames == null) return [];
  if (typeof mountRenames !== 'object' || Array.isArray(mountRenames)) {
    throw containerError('CONFIG_ERROR', 'mountRenames must be an object of { oldName: newName }');
  }
  const prevByName = new Map(prevMounts.map((m) => [m.name, m]));
  const nextByName = new Map(nextMounts.map((m) => [m.name, m]));
  const targets = new Set();
  const pairs = [];
  for (const [from, to] of Object.entries(mountRenames)) {
    if (typeof to !== 'string' || !to || to === from) {
      throw containerError('CONFIG_ERROR', `mountRenames["${from}"] must name a different mount`);
    }
    const prev = prevByName.get(from);
    if (!prev) throw containerError('CONFIG_ERROR', `mountRenames: no current mount named "${from}"`);
    const next = nextByName.get(to);
    if (!next) throw containerError('CONFIG_ERROR', `mountRenames: "${to}" is not in the new mount list`);
    if (prevByName.has(to)) {
      throw containerError(
        'CONFIG_ERROR',
        `Cannot rename mount "${from}" to "${to}": a mount named "${to}" already exists — remove or rename it in a separate save first`,
      );
    }
    if (targets.has(to)) throw containerError('CONFIG_ERROR', `mountRenames: "${to}" is the target of more than one rename`);
    if (prev.type !== next.type) {
      throw containerError('CONFIG_ERROR', `Cannot rename mount "${from}" to "${to}": type changes from ${prev.type} to ${next.type}`);
    }
    targets.add(to);
    pairs.push([prev, next]);
  }
  return pairs;
}

/**
 * Move the backing store of every renamed Local mount, then persist the config.
 * Local data lives at files/<name>; a Storage-sourced or tmpfs mount's name is
 * only a config key. If a move or the write fails, the moves already done are
 * reversed so disk and container.json keep agreeing.
 */
async function moveRenamedMountsAndWrite(name, renamePairs, config) {
  const moved = [];
  try {
    for (const [prev, next] of renamePairs) {
      if (prev.sourceId || prev.type === 'tmpfs') continue;
      if (await renameMountBackingStore(name, prev.name, next.name)) moved.push([prev.name, next.name]);
    }
    await writeContainerConfig(name, config);
  } catch (err) {
    for (const [from, to] of moved.reverse()) {
      try {
        await renameMountBackingStore(name, to, from);
      } catch {
        /* best effort — the original error is the one the caller needs */
      }
    }
    throw err;
  }
}

/**
 * Partially update a container's config. Returns { requiresRestart, removedMounts }.
 *
 * `mounts` replaces the mount list. It never deletes mount data: a Local mount
 * that leaves the list keeps files/<name> on disk and is reported in
 * `removedMounts`; the caller deletes that data explicitly with
 * `deleteRemovedMountData` when that is what it means. `mountRenames`
 * ({ oldName: newName }, only alongside `mounts`) marks entries of the new list
 * as renamed current mounts — their Local data moves to the new name.
 */
export async function updateContainerConfig(name, changes) {
  // A whole-env replacement would also overwrite write-only secrets the caller
  // has never seen; env changes go through the envPatch delta only.
  if ('env' in changes) {
    throw containerError('CONFIG_ERROR', 'Use envPatch to update environment variables');
  }
  if ('mountRenames' in changes && !('mounts' in changes)) {
    throw containerError('CONFIG_ERROR', 'mountRenames is only valid together with mounts');
  }
  let config = await readContainerConfig(name);

  let requiresRestart = false;
  /** @type {{ type: string, name: string, containerPath: string, readonly: boolean }[] | null} */
  let mountsPersisted = null;
  let renamePairs = [];
  /** Local mounts that left the list; their files/<name> is still on disk. */
  let removedMounts = [];
  const task = await getTaskState(name);
  const isRunning = task && (task.status === 'RUNNING' || task.status === 'PAUSED');

  if ('envPatch' in changes) {
    const mutated = applyEnvPatch(config, changes.envPatch);
    if (mutated && isRunning) requiresRestart = true;
  }

  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name' || key === 'createdAt' || key === 'state') continue;
    if (key === 'envPatch' || key === 'mountRenames') continue;
    /** Server-managed — never writable via PATCH. */
    if (key === 'imageDigest' || key === 'imagePulledAt'
      || key === 'updateAvailable') continue;
    if (key === 'metadata') {
      if (value == null) {
        delete config.metadata;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        config.metadata = value;
      } else {
        throw containerError('CONFIG_ERROR', 'metadata must be an object or null');
      }
      continue;
    }
    if (key === 'pendingRestart') {
      if (value === true) config.pendingRestart = true;
      else delete config.pendingRestart;
      continue;
    }
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

      if (merged.type === 'bridge') {
        if (merged.mac == null || String(merged.mac).trim() === '') {
          throw containerError('INVALID_CONTAINER_MAC', 'MAC address is required for bridge networking');
        }
        const norm = normalizeContainerMac(merged.mac);
        if (!norm) throw containerError('INVALID_CONTAINER_MAC', 'Invalid MAC address format');
        merged.mac = norm;
      } else if (merged.mac != null && String(merged.mac).trim() !== '') {
        const norm = normalizeContainerMac(merged.mac);
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
    if (key === 'restartPolicy') {
      if (!RESTART_POLICIES.includes(value)) {
        throw containerError('CONFIG_ERROR', `restartPolicy must be one of: ${RESTART_POLICIES.join(', ')}`);
      }
      config.restartPolicy = value;
      continue;
    }
    if (key === 'services') {
      throw containerError(
        'CONFIG_ERROR',
        'Use the per-service endpoints (POST/PATCH/DELETE /containers/:name/services/:port) to manage advertised services',
      );
    }
    if (key === 'mounts') {
      const prevMounts = Array.isArray(config.mounts) ? [...config.mounts] : [];
      const normalized = validateAndNormalizeMounts(value, resolveMount);
      renamePairs = resolveMountRenames(changes.mountRenames, prevMounts, normalized);
      const renamedFrom = new Set(renamePairs.map(([prev]) => prev.name));
      const nextNames = new Set(normalized.map((m) => m.name));
      /* Storage-sourced entries point at user data outside the container dir and tmpfs has no
       * on-disk artifact — only Local mounts leave data behind. */
      removedMounts = prevMounts
        .filter((m) => !nextNames.has(m.name) && !renamedFrom.has(m.name) && !m.sourceId && m.type !== 'tmpfs')
        .map((m) => m.name);
      config.mounts = normalized;
      mountsPersisted = normalized;
      if (isRunning && RESTART_FIELDS.has(key)) requiresRestart = true;
      continue;
    }
    if (key === 'devices') {
      config.devices = validateAndNormalizeDevices(value);
      if (isRunning && RESTART_FIELDS.has(key)) requiresRestart = true;
      continue;
    }
    config[key] = value;
    if (isRunning && RESTART_FIELDS.has(key)) requiresRestart = true;
  }

  // A-record (de)registration is owned by routes/containers.js — it calls
  // publishContainer/unpublishContainer on the reconciler after this function
  // returns. We only handle SRV/TXT services here (still managed inside
  // containerManager because they're tied to the container's service array).
  if (changes.localDns === false) {
    await deregisterServicesForContainer(name);
  } else if (changes.localDns === true && isRunning && config.network?.ip) {
    await registerAllContainerServices(name, config);
  }

  if (requiresRestart) config.pendingRestart = true;
  await moveRenamedMountsAndWrite(name, renamePairs, config);
  if (mountsPersisted) {
    await ensureMissingMountArtifacts(name, mountsPersisted);
  }
  return { requiresRestart, removedMounts };
}
