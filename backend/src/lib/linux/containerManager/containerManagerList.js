/**
 * List containers by merging containerd state with on-disk container.json configs.
 */
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

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
 * Get the full config for a single container (for detail view).
 */
export async function getContainerConfig(name) {
  const dir = getContainerDir(name);
  let config;
  try {
    const raw = await readFile(join(dir, 'container.json'), 'utf8');
    config = JSON.parse(raw);
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${name}" not found`);
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

  return {
    ...merged,
    localDns,
    mdnsHostname: localDns ? getRegisteredHostname(name) : null,
    state,
    pid,
    uptime,
    type: 'container',
  };
}
