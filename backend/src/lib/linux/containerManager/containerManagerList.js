/**
 * List containers by merging containerd state with on-disk container.json configs.
 */
import { join } from 'node:path';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';

import {
  containerError, containerState, getClient, callUnary,
} from './containerManagerConnection.js';
import { getContainersPath, getContainerDir } from './containerPaths.js';
import { getTaskState, containerTaskStatusToUi } from './containerManagerLifecycle.js';
import {
  persistContainerIpFromNetnsIfMissing,
  ensureContainerNetworkConfig,
  normalizeContainerMac,
} from './containerManagerNetwork.js';
import { processUptimeMsFromProc } from '../host/linuxProcUptime.js';
import { getRegisteredHostname, registerAddress, sanitizeHostname } from '../../mdnsManager.js';
import { readLibraryDigestMap } from './containerManagerImages.js';
import { normalizeImageRef } from './containerImageRef.js';

/**
 * Derived `updateAvailable`: true when the container is running/paused AND
 * its stored `imageDigest` no longer matches the library's current digest
 * for its image ref. Not persisted — computed on every read from two sources
 * of truth (`container.imageDigest` and the image-meta sidecar).
 */
function deriveUpdateAvailable(config, state, libraryDigests) {
  if (state !== 'running' && state !== 'paused') return false;
  if (!config.imageDigest || !config.image) return false;
  const current = libraryDigests.get(normalizeImageRef(config.image));
  return !!current && current !== config.imageDigest;
}

/**
 * List all containers (summary for the left panel list).
 * Merges on-disk config with live task state from containerd.
 */
export async function listContainers() {

  const basePath = getContainersPath();
  let dirs;
  try {
    dirs = await readdir(basePath, { withFileTypes: true });
  } catch {
    /* containers root missing or unreadable — treat as empty list */
    return [];
  }

  const results = [];
  const libraryDigests = await readLibraryDigestMap();

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    try {
      const configPath = join(basePath, name, 'container.json');
      const raw = await readFile(configPath, 'utf8');
      const config = JSON.parse(raw);

      let state = 'stopped';
      let pid = 0;
      try {
        const task = await getTaskState(name);
        if (task) {
          state = containerTaskStatusToUi(task);
          pid = Number(task.pid) || 0;
        }
      } catch {
        // No task — container is stopped
      }

      let uptime = 0;
      if (state === 'running') {
        const fromProc = pid ? await processUptimeMsFromProc(pid) : null;
        if (fromProc != null) {
          uptime = fromProc;
        } else if (containerState.containerStartTimes.has(name)) {
          uptime = Date.now() - containerState.containerStartTimes.get(name);
        }
      }

      results.push({
        name,
        type: 'container',
        image: config.image || '',
        state,
        pid,
        cpuLimit: config.cpuLimit ?? null,
        memoryLimitMiB: config.memoryLimitMiB ?? null,
        restartPolicy: config.restartPolicy || 'never',
        autostart: config.autostart ?? false,
        uptime,
        iconId: config.iconId ?? null,
        updateAvailable: deriveUpdateAvailable(config, state, libraryDigests),
        pendingRestart: config.pendingRestart === true,
      });
    } catch {
      // Skip malformed container dirs
    }
  }

  return results;
}

/**
 * Number of containers in the running state (for host stats bar).
 */
export async function getRunningContainerCount() {
  const list = await listContainers();
  return list.filter((c) => c.state === 'running').length;
}

/**
 * Normalize the on-disk env shape. Legacy container.json stored env as a flat
 * { KEY: "value" } dict; the target shape is { KEY: { value, secret? } }. If any
 * entry is still a bare string, convert it in place and report `changed: true`
 * so the caller can write the file back once.
 */
function ensureContainerEnvShape(config) {
  if (!config.env || typeof config.env !== 'object') {
    config.env = {};
    return false;
  }
  let changed = false;
  for (const [k, v] of Object.entries(config.env)) {
    if (typeof v === 'string') {
      config.env[k] = { value: v };
      changed = true;
    } else if (!v || typeof v !== 'object') {
      config.env[k] = { value: String(v ?? '') };
      changed = true;
    }
  }
  return changed;
}

/**
 * Get the full config for a single container (for detail view).
 */
export async function getContainerConfig(name) {
  const dir = getContainerDir(name);
  const configPath = join(dir, 'container.json');
  let config;
  try {
    const raw = await readFile(configPath, 'utf8');
    config = JSON.parse(raw);
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
  }

  if (ensureContainerEnvShape(config)) {
    try {
      await writeFile(configPath, JSON.stringify(config, null, 2));
    } catch {
      /* keep in-memory normalization if rewrite failed */
    }
  }

  if (config.network?.type !== 'bridge' || !normalizeContainerMac(config.network?.mac)) {
    try {
      config = await ensureContainerNetworkConfig(name, config);
    } catch {
      /* keep config as-is if rewrite failed */
    }
  }

  let state = 'stopped';
  let pid = 0;
  try {
    const task = await getTaskState(name);
    if (task) {
      state = containerTaskStatusToUi(task);
      pid = Number(task.pid) || 0;
    }
  } catch {
    // Stopped
  }

  let uptime = 0;
  if (state === 'running') {
    const fromProc = pid ? await processUptimeMsFromProc(pid) : null;
    if (fromProc != null) {
      uptime = fromProc;
    } else if (containerState.containerStartTimes.has(name)) {
      uptime = Date.now() - containerState.containerStartTimes.get(name);
    }
  }

  let merged = config;
  if (state === 'running') {
    try {
      merged = await persistContainerIpFromNetnsIfMissing(name, merged, pid);
    } catch {
      /* netns missing or helper failed — return config without ip */
    }
  }

  const localDns = merged.localDns === true;
  if (state === 'running' && localDns && merged.network?.ip) {
    await registerAddress(name, sanitizeHostname(name), merged.network.ip);
  }

  const libraryDigests = await readLibraryDigestMap();

  return {
    ...merged,
    localDns,
    mdnsHostname: localDns ? getRegisteredHostname(name) : null,
    state,
    pid,
    uptime,
    type: 'container',
    updateAvailable: deriveUpdateAvailable(merged, state, libraryDigests),
  };
}
