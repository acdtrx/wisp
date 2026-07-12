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
  getMountFileTextContent,
  putMountFileTextContent,
  execCommandInContainer,
} from '../containerManager/index.js';
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

const RELOAD_DETAIL_MAX = 1000;

/**
 * Extract the useful part of a failed reload's output.
 *
 * Reload tools narrate before they fail: `caddy reload` emits several JSON log lines
 * ("using config from file", "adapted config to JSON", a formatting warning) and only then
 * prints the error that actually matters. Taking the *first* N characters therefore shows
 * the noise and truncates the diagnosis. Prefer the lines that look like errors, and when
 * falling back to raw output keep the tail, where the failure lives.
 */
function reloadFailureDetail(result) {
  const raw = (result.stderr || result.stdout || '').trim();
  if (!raw) return `exit ${result.exitCode}`;

  // Structured loggers put level/severity in the line; a bare `Error: …` has none.
  const errorLines = raw
    .split('\n')
    .filter((line) => /^error\b|"level":"(error|fatal|panic)"|\berror\b:/i.test(line.trim()));
  const chosen = errorLines.length ? errorLines.join('\n') : raw;

  return chosen.length > RELOAD_DETAIL_MAX ? `…${chosen.slice(-RELOAD_DETAIL_MAX)}` : chosen;
}

/**
 * Stable signature of an env map by name + value. `secret` is presentation-only.
 *
 * A reload can never apply an env change: the OCI spec's process env is built from
 * `config.env` when the task starts (containerManagerSpec.js), so a running process keeps
 * the environment it was exec'd with. Caddy shows why this matters — its Caddyfile refers
 * to the Cloudflare token as `{env.CLOUDFLARE_API_TOKEN}`, which the *running* server
 * resolves against its own environment, so `caddy reload` after adding the token yields a
 * silently token-less DNS-01 config. Callers must treat an env diff as restart-worthy.
 */
function envSig(env) {
  return JSON.stringify(
    Object.entries(env || {})
      .map(([key, entry]) => [key, entry && typeof entry === 'object' ? entry.value : entry])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  );
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
 * Full outbound masking for a container config: env secrets become
 * `{ value: null, secret: true, isSet }` and the app's appConfig is masked via
 * the app module. Every surface that returns container details (REST routes,
 * MCP tools) must pass the config through here.
 */
export function maskContainerConfigSecrets(config) {
  if (!config || !config.env || typeof config.env !== 'object') return maskAppSecrets(config);
  const env = {};
  for (const [k, v] of Object.entries(config.env)) {
    if (v?.secret) {
      env[k] = {
        value: null,
        secret: true,
        isSet: typeof v.value === 'string' && v.value.length > 0,
      };
    } else {
      env[k] = { value: v?.value ?? '' };
    }
  }
  return maskAppSecrets({ ...config, env });
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
 * When the reload itself rejects the new state (`APP_RELOAD_FAILED`), the
 * persisted config and mount file contents are rolled back to the previous
 * state before the error propagates — the app kept serving its old config,
 * so leaving the rejected one on disk would make the next restart/reboot
 * boot the container into a config its own app already refused.
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
  const envChanged = envSig(config.env) !== envSig(derived.env);

  const updateChanges = {
    env: derived.env || {},
    mounts: nextMounts,
    metadata: { ...config.metadata, appConfig: finalAppConfig },
  };
  if (Array.isArray(derived.devices)) {
    updateChanges.devices = derived.devices;
  }

  const task = await getTaskState(name);
  const isRunning = task && (task.status === 'RUNNING' || task.status === 'PAUSED');
  const reloadCmd = appModule.getReloadCommand?.();
  const willReload = isRunning && !!reloadCmd && !envChanged;

  // Snapshot every local file mount's backing content before persisting: the
  // update below overwrites files named in mountContents and deletes the
  // backing file of any file mount whose row disappears from the list. Only
  // needed when a reload will judge the new state — every other path keeps
  // the persisted config unconditionally. (Directory mounts have no capture
  // primitive; no app module derives a local dir mount from appConfig.)
  let prevFileContents = null;
  if (willReload) {
    prevFileContents = {};
    for (const m of oldMounts) {
      if (m.type !== 'file' || m.sourceId) continue;
      try {
        prevFileContents[m.name] = (await getMountFileTextContent(name, m.name)).content;
      } catch {
        /* no backing file on disk — nothing to restore for this mount */
      }
    }
  }

  await updateContainerConfig(name, updateChanges);

  if (derived.mountContents && Object.keys(derived.mountContents).length) {
    for (const [mountName, content] of Object.entries(derived.mountContents)) {
      await putMountFileTextContent(name, mountName, content);
    }
  }

  if (!isRunning) {
    return { requiresRestart: false };
  }
  // Skip the reload outright when the env changed. It cannot apply — the OCI process env is
  // fixed at task start — and attempting it is worse than useless: the persist above has
  // already written a config that refers to the new variable, which the running process then
  // resolves against an environment that lacks it. Adding Caddy's Cloudflare token this way yields
  //   provision dns.providers.cloudflare: API token '' appears invalid
  // and a hard APP_RELOAD_FAILED for a save that only ever needed a restart. Restarting
  // applies the new env and the new mount contents together — the only order that works.
  if (!reloadCmd || envChanged) {
    await updateContainerConfig(name, { pendingRestart: true });
    return { requiresRestart: true };
  }

  const appWantsRestart = !!appModule.requiresRestartForChange?.(oldAppConfig, validated);
  const stillNeedsRestart = appWantsRestart || mountLayoutChanged;

  try {
    const result = await execCommandInContainer(name, reloadCmd, { timeoutMs: 15000 });
    if (result.exitCode !== 0) {
      throw createAppError('APP_RELOAD_FAILED', `Reload failed (exit ${result.exitCode})`, reloadFailureDetail(result));
    }
    if (stillNeedsRestart) {
      await updateContainerConfig(name, { pendingRestart: true });
    }
    return { requiresRestart: stillNeedsRestart, reloaded: true };
  } catch (err) {
    if (err.code === 'APP_RELOAD_FAILED') {
      // The app rejected the new state and kept serving its previous config
      // (reload commands judge-then-apply). Restore the persisted config and
      // file contents to match; restoring the old mounts list also deletes
      // backing files the persist created for rejected-state-only mounts.
      try {
        const rollbackChanges = {
          env: config.env || {},
          mounts: oldMounts,
          metadata: config.metadata,
        };
        if (Array.isArray(derived.devices)) {
          rollbackChanges.devices = Array.isArray(config.devices) ? config.devices : [];
        }
        await updateContainerConfig(name, rollbackChanges);
        for (const [mountName, content] of Object.entries(prevFileContents)) {
          await putMountFileTextContent(name, mountName, content);
        }
      } catch (rollbackErr) {
        err.raw = `${err.raw}\nRollback to the previous config also failed (${rollbackErr.message}); `
          + 'the persisted config may not match the running app — re-save a known-good config.';
      }
      throw err;
    }
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
