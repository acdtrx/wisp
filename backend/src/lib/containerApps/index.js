/**
 * containerApps — Wisp's app recipe layer. Sits beside routes as a peer
 * consumer of containerManager: takes a high-level app spec (e.g. Jellyfin
 * with libraries + GPU toggle) and translates it into containerManager API
 * calls (createContainer, updateContainerConfig, putMountFileTextContent,
 * execCommandInContainer). containerManager has zero knowledge of apps.
 *
 * Storage: each app container's metadata lives at config.metadata.app
 * (string id) and config.metadata.appConfig (object). containerManager
 * persists `metadata` verbatim and never introspects it.
 */
import {
  createContainer,
  updateContainerConfig,
  deleteContainer,
  getContainerConfig,
  getTaskState,
  putMountFileTextContent,
  execCommandInContainer,
} from '../containerManager.js';
import { createAppError } from '../routeErrors.js';

import {
  APP_REGISTRY,
  getAppModule,
  getAppEntry,
  isKnownApp,
} from './appRegistry.js';

export { APP_REGISTRY, getAppModule, getAppEntry, isKnownApp };

/**
 * Stable signature of a mount list's structural fields. Used to detect when
 * a reload-only update is no longer enough (binds can't be added/removed/
 * retargeted on a running task; only file content reloads in place).
 */
function mountLayoutSig(list) {
  if (!Array.isArray(list)) return '[]';
  return JSON.stringify(list.map((m) => ({
    type: m.type,
    name: m.name,
    containerPath: m.containerPath,
    sourceId: m.sourceId || null,
    subPath: m.subPath || '',
    sizeMiB: Number.isInteger(m.sizeMiB) ? m.sizeMiB : null,
  })));
}

/**
 * Mask app secrets in a container config response. Routes call this before
 * sending container details out over the wire.
 */
export function maskAppSecrets(config) {
  const appType = config?.metadata?.app;
  if (!appType) return config;
  const appModule = getAppModule(appType);
  if (!appModule?.maskSecrets) return config;
  const masked = { ...config, metadata: { ...config.metadata } };
  masked.metadata.appConfig = appModule.maskSecrets(config.metadata.appConfig);
  return masked;
}

/**
 * Create an app container. Computes the derived config from the app module,
 * builds an expanded spec with all the regular containerManager fields plus
 * `metadata.app`/`metadata.appConfig`, then writes derived file contents into
 * the file mounts via the standard `putMountFileTextContent` primitive.
 *
 * On any failure after the container is created, the container is deleted
 * (rollback) so partially-configured containers don't linger.
 */
export async function createAppContainer(spec, onStep) {
  if (!isKnownApp(spec.app)) {
    throw createAppError('UNKNOWN_APP_TYPE', `Unknown app type "${spec.app}"`);
  }
  const appEntry = getAppEntry(spec.app);
  const appModule = appEntry.module;

  const initialAppConfig = spec.appConfig
    ? appModule.validateAppConfig(spec.appConfig, null)
    : appModule.getDefaultAppConfig({ containerName: spec.name });
  const derived = await appModule.generateDerivedConfig(initialAppConfig);
  const finalAppConfig = derived.appConfig ?? initialAppConfig;

  const expandedSpec = {
    name: spec.name,
    image: spec.image,
    iconId: spec.iconId,
    env: derived.env || {},
    mounts: derived.mounts || [],
    devices: Array.isArray(derived.devices) ? derived.devices : [],
    runAsRoot: appEntry.requiresRoot ? true : spec.runAsRoot,
    services: appEntry.defaultServices?.length
      ? appEntry.defaultServices.map((s) => ({
          port: s.port,
          type: s.type,
          txt: { ...(s.txt || {}) },
        }))
      : undefined,
    metadata: { app: spec.app, appConfig: finalAppConfig },
  };

  await createContainer(expandedSpec, onStep);

  if (derived.mountContents && Object.keys(derived.mountContents).length) {
    try {
      for (const [mountName, content] of Object.entries(derived.mountContents)) {
        await putMountFileTextContent(spec.name, mountName, content);
      }
    } catch (err) {
      // Roll back partially-configured container so the user can retry cleanly.
      try { await deleteContainer(spec.name); } catch { /* best-effort rollback */ }
      throw err;
    }
  }
}

/**
 * Apply a new app config to an existing app container. Validates, derives,
 * persists the new metadata + container fields (env/mounts/devices), writes
 * any updated mount file contents, and — if the container is running —
 * issues the app's reload command. Falls back to `pendingRestart` when the
 * change can't be applied live (no reload command, mount layout changed,
 * app reports `requiresRestartForChange`, or reload exec fails).
 *
 * Returns `{ requiresRestart, reloaded? }`.
 */
export async function applyAppConfig(name, newAppConfig) {
  const config = await getContainerConfig(name);
  const appType = config?.metadata?.app;
  if (!appType) {
    throw createAppError('CONFIG_ERROR', `Container "${name}" is not an app container`);
  }
  const appModule = getAppModule(appType);
  if (!appModule) {
    throw createAppError('UNKNOWN_APP_TYPE', `Unknown app type "${appType}"`);
  }

  const oldAppConfig = config.metadata.appConfig;
  const validated = appModule.validateAppConfig(newAppConfig, oldAppConfig);
  const derived = await appModule.generateDerivedConfig(validated);
  const finalAppConfig = derived.appConfig ?? validated;

  const oldMounts = Array.isArray(config.mounts) ? config.mounts : [];
  const nextMounts = Array.isArray(derived.mounts) ? derived.mounts : [];
  const mountLayoutChanged = mountLayoutSig(oldMounts) !== mountLayoutSig(nextMounts);

  const updateChanges = {
    env: derived.env || {},
    mounts: nextMounts,
    metadata: { ...config.metadata, appConfig: finalAppConfig },
  };
  if (Array.isArray(derived.devices)) {
    updateChanges.devices = derived.devices;
  }

  await updateContainerConfig(name, updateChanges);

  if (derived.mountContents && Object.keys(derived.mountContents).length) {
    for (const [mountName, content] of Object.entries(derived.mountContents)) {
      await putMountFileTextContent(name, mountName, content);
    }
  }

  const task = await getTaskState(name);
  const isRunning = task && (task.status === 'RUNNING' || task.status === 'PAUSED');
  if (!isRunning) {
    return { requiresRestart: false };
  }

  const reloadCmd = appModule.getReloadCommand?.();
  if (!reloadCmd) {
    await updateContainerConfig(name, { pendingRestart: true });
    return { requiresRestart: true };
  }

  const appWantsRestart = !!appModule.requiresRestartForChange?.(oldAppConfig, validated);
  const stillNeedsRestart = appWantsRestart || mountLayoutChanged;

  try {
    const result = await execCommandInContainer(name, reloadCmd, { timeoutMs: 15000 });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().slice(0, 500);
      throw createAppError('APP_RELOAD_FAILED', `Reload failed (exit ${result.exitCode})`, detail);
    }
    if (stillNeedsRestart) {
      await updateContainerConfig(name, { pendingRestart: true });
    }
    return { requiresRestart: stillNeedsRestart, reloaded: true };
  } catch (err) {
    if (err.code === 'APP_RELOAD_FAILED') throw err;
    // Reload exec failed for non-app-related reason (e.g. command not found in
    // image). Surface as pendingRestart instead of bubbling the exec error.
    await updateContainerConfig(name, { pendingRestart: true });
    return { requiresRestart: true };
  }
}

/**
 * Eject an app container into a generic container. Clears `metadata.app`/
 * `metadata.appConfig` only — env, mounts, devices, services, and any files
 * previously written by the app are preserved. The user can keep using the
 * container as a regular configurable container from this point on.
 */
export async function eject(name) {
  const config = await getContainerConfig(name);
  if (!config?.metadata?.app) return;
  const nextMeta = { ...config.metadata };
  delete nextMeta.app;
  delete nextMeta.appConfig;
  const metadata = Object.keys(nextMeta).length ? nextMeta : null;
  await updateContainerConfig(name, { metadata });
}
