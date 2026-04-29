/**
 * List containers by merging containerd state with on-disk container.json configs.
 * Maintains an in-memory cache refreshed on containerd events, container.json writes,
 * and image-update completion (see Stage 3 of the SSE refactor).
 */
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';

import {
  containerState,
  getClient,
  callStream,
  subscribeContainerdConnect,
  subscribeContainerdDisconnect,
} from './containerManagerConnection.js';
import { getContainersPath } from './containerPaths.js';
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
import {
  readContainerConfig,
  writeContainerConfig,
  subscribeContainerConfigWrite,
} from './containerManagerConfigIo.js';

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

/* ── Container list cache (event-driven) ────────────────────────────── */

let containerListCache = null;
let refreshPromise = null;
let refreshQueued = false;
let eventsStream = null;
const listChangeHandlers = new Set();

/** Containerd event topics that affect what listContainers returns. */
const LIST_AFFECTING_TOPICS = new Set([
  '/tasks/start',
  '/tasks/exit',
  '/tasks/oom',
  '/tasks/delete',
  '/tasks/paused',
  '/tasks/resumed',
  '/containers/create',
  '/containers/update',
  '/containers/delete',
]);

async function fetchContainerListFromDisk() {
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
      try {
        const task = await getTaskState(name);
        if (task) state = containerTaskStatusToUi(task);
      } catch {
        // No task — container is stopped
      }

      results.push({
        name,
        type: 'container',
        image: config.image || '',
        state,
        iconId: config.iconId ?? null,
        updateAvailable: deriveUpdateAvailable(config, state, libraryDigests),
      });
    } catch {
      // Skip malformed container dirs
    }
  }

  return results;
}

function fireListChange() {
  for (const h of listChangeHandlers) {
    try { h(containerListCache); } catch (err) { console.warn('[containerManager] list-change handler threw:', err?.message || err); }
  }
}

function refreshContainerListCache() {
  if (refreshPromise) {
    refreshQueued = true;
    return;
  }
  refreshQueued = false;
  refreshPromise = fetchContainerListFromDisk()
    .then((list) => { containerListCache = list; fireListChange(); })
    .catch((err) => { console.warn('[containerManager] container list cache refresh failed:', err.message); })
    .finally(() => {
      refreshPromise = null;
      if (refreshQueued) refreshContainerListCache();
    });
}

function invalidateContainerListCache() {
  containerListCache = null;
  fireListChange();
}

function startEventsStream() {
  if (eventsStream || !containerState.connected) return;
  try {
    eventsStream = callStream(getClient('events'), 'subscribe', { filters: [] });
    eventsStream.on('data', (envelope) => {
      if (envelope?.topic && LIST_AFFECTING_TOPICS.has(envelope.topic)) {
        refreshContainerListCache();
      }
    });
    eventsStream.on('error', (err) => {
      /* Stream broke — cleanup; the disconnect handler (or next reconnect) will rebuild. */
      containerState.logger?.warn?.({ err: err?.message || String(err) }, 'containerd events stream error');
      stopEventsStream();
    });
    eventsStream.on('end', () => { eventsStream = null; });
  } catch (err) {
    containerState.logger?.warn?.({ err: err?.message || String(err) }, 'containerd events subscribe failed');
    eventsStream = null;
  }
}

function stopEventsStream() {
  if (!eventsStream) return;
  try { eventsStream.cancel(); } catch { /* already cancelled */ }
  eventsStream = null;
}

subscribeContainerdConnect(() => {
  startEventsStream();
  refreshContainerListCache();
});
subscribeContainerdDisconnect(() => {
  stopEventsStream();
  invalidateContainerListCache();
});
subscribeContainerConfigWrite(refreshContainerListCache);

/**
 * Subscribe to container list cache changes. Handler fires after each successful
 * refresh (with the new list) and on disconnect (with null). Returns an unsubscribe.
 */
export function subscribeContainerListChange(handler) {
  listChangeHandlers.add(handler);
  return () => listChangeHandlers.delete(handler);
}

/**
 * List all containers (summary for the left panel list).
 * Returns only fields rendered by the sidebar; runtime details (pid, uptime,
 * resource limits, etc.) are served by getContainerConfig and the per-container
 * stats SSE — fetching them per-tick here is wasted work.
 */
export async function listContainers() {
  if (containerListCache === null) {
    containerListCache = await fetchContainerListFromDisk();
  }
  return containerListCache;
}

/**
 * Number of containers in the running state (for host stats bar).
 */
export async function getRunningContainerCount() {
  const list = await listContainers();
  return list.filter((c) => c.state === 'running').length;
}

/**
 * Find containers whose mounts reference a storage-mount entry by id. Used by
 * settings.removeMount to refuse deletion when any container still has a
 * `mounts[*].sourceId === mountId` (which would leave the container with a
 * dangling source on next start). Returns container names.
 */
export async function findContainersUsingStorageMount(mountId) {
  if (!mountId || typeof mountId !== 'string') return [];
  const refs = [];
  const list = await listContainers();
  for (const entry of list) {
    let config;
    try {
      config = await readContainerConfig(entry.name);
    } catch {
      /* skip containers whose config we can't read — best-effort scan */
      continue;
    }
    const mounts = Array.isArray(config?.mounts) ? config.mounts : [];
    if (mounts.some((m) => m && m.sourceId === mountId)) {
      refs.push(entry.name);
    }
  }
  return refs;
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
  let config = await readContainerConfig(name);

  if (ensureContainerEnvShape(config)) {
    try {
      await writeContainerConfig(name, config);
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
