/**
 * Update container configuration.
 * Changes are written to container.json; running containers need a restart for most changes.
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir } from './containerPaths.js';
import { getTaskState } from './containerManagerLifecycle.js';
import { normalizeContainerMac } from './containerManagerNetwork.js';
import { deregisterAddress, registerAddress, sanitizeHostname } from '../../mdnsManager.js';
import { validateAndNormalizeMounts, ensureMissingMountArtifacts } from './containerManagerMounts.js';
import { deleteMountBackingStore } from './containerManagerMountsContent.js';
import { getAppModule } from './apps/appRegistry.js';
import { execCommandInContainer } from './containerManagerExec.js';

const RESTART_FIELDS = new Set([
  'image', 'command', 'cpuLimit', 'memoryLimitMiB', 'env', 'mounts', 'network', 'runAsRoot', 'appConfig',
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

  // ── Eject: convert app container to generic ──────────────────────
  if (changes.eject === true && config.app) {
    delete config.app;
    delete config.appConfig;
    delete config.pendingRestart;
    await writeFile(configPath, JSON.stringify(config, null, 2));
    return { requiresRestart: false };
  }

  // ── App container: reject raw envPatch/mounts, handle appConfig ─
  if (config.app) {
    if ('envPatch' in changes || 'env' in changes) {
      throw containerError('APP_CONFIG_ONLY', 'Use appConfig to configure app containers, or eject to generic first');
    }
    if ('mounts' in changes) {
      throw containerError('APP_CONFIG_ONLY', 'Use appConfig to configure app containers, or eject to generic first');
    }
    if ('appConfig' in changes) {
      const appModule = getAppModule(config.app);
      if (!appModule) {
        throw containerError('UNKNOWN_APP_TYPE', `Unknown app type "${config.app}"`);
      }
      const validated = appModule.validateAppConfig(changes.appConfig);
      config.appConfig = validated;

      const derived = await appModule.generateDerivedConfig(validated);

      // If generateDerivedConfig returns a transformed appConfig (e.g. with hashed passwords), use it
      if (derived.appConfig) config.appConfig = derived.appConfig;

      // Replace env entirely with derived env
      config.env = derived.env || {};

      // Replace mounts — delete backing stores for removed mounts
      const prevMounts = Array.isArray(config.mounts) ? [...config.mounts] : [];
      const nextNames = new Set((derived.mounts || []).map((m) => m.name));
      for (const m of prevMounts) {
        if (!nextNames.has(m.name)) {
          await deleteMountBackingStore(name, m);
        }
      }
      config.mounts = derived.mounts || [];
      mountsPersisted = config.mounts;

      // Write mount file contents
      if (derived.mountContents) {
        const filesDir = getContainerFilesDir(name);
        for (const [mountName, content] of Object.entries(derived.mountContents)) {
          await writeFile(join(filesDir, mountName), content, 'utf8');
        }
      }

      if (isRunning) {
        // Try live reload if the app supports it; fall back to pendingRestart
        const reloadCmd = appModule.getReloadCommand?.();
        if (reloadCmd) {
          // Write config first so the reload picks up the new files
          await writeFile(configPath, JSON.stringify(config, null, 2));
          if (mountsPersisted) await ensureMissingMountArtifacts(name, mountsPersisted);
          try {
            const result = await execCommandInContainer(name, reloadCmd, { timeoutMs: 15000 });
            if (result.exitCode !== 0) {
              const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
              throw containerError('APP_RELOAD_FAILED', `Reload failed (exit ${result.exitCode})`, detail);
            }
            // Reload succeeded — no restart needed, config already written
            return { requiresRestart: false, reloaded: true };
          } catch (err) {
            if (err.code === 'APP_RELOAD_FAILED') throw err;
            // Exec failed (e.g. command not found) — fall through to pendingRestart
            config.pendingRestart = true;
            requiresRestart = true;
          }
        } else {
          requiresRestart = true;
          config.pendingRestart = true;
        }
      }
    }
  }

  // ── Generic container: envPatch ─────────────────────────────────
  if (!config.app) {
    if ('env' in changes) {
      throw containerError('CONFIG_ERROR', 'Use envPatch to update environment variables');
    }
    if ('envPatch' in changes) {
      const mutated = applyEnvPatch(config, changes.envPatch);
      if (mutated && isRunning) requiresRestart = true;
    }
  }

  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name' || key === 'createdAt' || key === 'state') continue;
    if (key === 'envPatch') continue;
    if (key === 'appConfig' || key === 'eject' || key === 'app') continue;
    /** Server-managed — never writable via PATCH. */
    if (key === 'imageDigest' || key === 'imagePulledAt'
      || key === 'updateAvailable' || key === 'pendingRestart') continue;
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
