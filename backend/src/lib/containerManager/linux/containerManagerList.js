/**
 * List containers by merging containerd state with on-disk container.json configs.
 * Maintains an in-memory cache refreshed on containerd events, container.json writes,
 * restart-policy schedule changes, and image-update completion. Owns the containerd events subscription, which
 * also feeds `/tasks/exit` to the restart policy.
 */
import { readdir } from 'node:fs/promises';

import {
  containerError,
  wrapContainerError,
  containerState,
  getClient,
  callStream,
  subscribeContainerdConnect,
  subscribeContainerdDisconnect,
  subscribeContainerdConnectFailed,
  retryConnect,
  NAMESPACE,
} from './containerManagerConnection.js';
import { getContainersPath } from './containerPaths.js';
import { getTaskState, containerTaskStatusToUi } from './containerManagerLifecycle.js';
import { processUptimeMsFromProc } from './procUptime.js';
import { pendingRestartInForce } from './containerManagerPendingRestart.js';
import { getRegisteredHostname } from '../../mdns/index.js';
import { readLibraryDigestMap } from './containerManagerImageMeta.js';
import { normalizeImageRef } from './containerImageRef.js';
import { readContainerConfig, subscribeContainerConfigWrite } from './containerManagerConfigIo.js';
import {
  handleTaskExitEvent,
  getScheduledRestart,
  subscribeScheduledRestartChange,
} from './containerManagerRestartPolicy.js';

/**
 * Derived `updateAvailable`: true when the container is running/paused AND
 * its stored `imageDigest` no longer matches the library's current digest
 * for its image ref. Not persisted — computed on every read from two sources
 * of truth (`container.imageDigest` and the image-meta sidecar).
 */
function deriveUpdateAvailable(config, state, libraryDigests) {
  if (state !== 'running' && state !== 'paused') return false;
  if (!config.imageDigest || !config.image) return false;
  const current = libraryDigests.get(config.image) ?? libraryDigests.get(normalizeImageRef(config.image));
  return !!current && current !== config.imageDigest;
}

/* ── Container list cache (event-driven) ────────────────────────────── */

/** The last list read whole, or null: not read yet, or the last read failed or
 *  the events stream broke, so the next listContainers() reads it again. */
let containerListCache = null;
/** What the subscribers were last told, by value (see announce); null: nothing yet. */
let lastAnnounced = null;
let readPromise = null;
let refreshQueued = false;
/** Resolvers waiting for a refresh that starts after they asked. */
let refreshWaiters = [];
let eventsStream = null;
const listChangeHandlers = new Set();

/** Containerd event topics that change the image store (GET /api/containers/images). */
const IMAGE_TOPICS = new Set(['/images/create', '/images/update', '/images/delete']);

/** Notified after containerd reports an image created, updated or deleted in
 *  Wisp's namespace — every writer, a pull, a delete or `ctr` from outside. No
 *  replay: a cue to list the images again. */
const imagesChangeHandlers = new Set();

export function subscribeImagesChange(handler) {
  imagesChangeHandlers.add(handler);
  return () => imagesChangeHandlers.delete(handler);
}

function announceImagesChange() {
  for (const handler of imagesChangeHandlers) {
    try {
      handler();
    } catch (err) {
      containerState.logger?.warn?.({ err: err?.message || err }, '[containerManager] images-change handler threw');
    }
  }
}

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

/**
 * Build the list from the container directories plus each task's state: the
 * whole list, or it throws — NO_CONTAINERD when not connected, INTERNAL_ERROR
 * for an unreadable containers root, a config's or a task lookup's own error.
 * A missing root is no containers; a directory without a `container.json` is
 * not a container (mid-create, or the `files/` a delete kept).
 */
async function fetchContainerListFromDisk() {
  if (!containerState.connected) {
    throw containerError('NO_CONTAINERD', 'Not connected to containerd');
  }
  const basePath = getContainersPath();
  let dirs;
  try {
    dirs = await readdir(basePath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw wrapContainerError('INTERNAL_ERROR', `Cannot read the containers directory ${basePath}`, err);
  }

  const results = [];
  const libraryDigests = await readLibraryDigestMap();

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    let config;
    try {
      config = await readContainerConfig(name);
    } catch (err) {
      if (err.code === 'CONTAINER_NOT_FOUND') continue;
      throw err;
    }

    const task = await getTaskState(name);
    const state = task ? containerTaskStatusToUi(task) : 'stopped';
    const pid = task ? Number(task.pid) || 0 : 0;

    results.push({
      name,
      uuid: config.uuid ?? null,
      type: 'container',
      image: config.image || '',
      state,
      iconId: config.iconId ?? null,
      autoBackup: config.autoBackup === true,
      updateAvailable: deriveUpdateAvailable(config, state, libraryDigests),
      scheduledRestart: getScheduledRestart(name),
      pendingRestart: await pendingRestartInForce(config, pid),
    });
  }

  return results;
}

/**
 * Tell the subscribers a read's outcome — the list, or null for an error —
 * only when it differs from what they were last told: a list unequal by value,
 * a list after an error or an error after a list, or another error. A read
 * that gives the same answer tells nobody, so a subscriber whose own work
 * fails cannot set off read after read.
 */
function announce(list, err) {
  const key = err
    ? `error ${err.code}\n${err.message}\n${err.raw ?? ''}`
    : `list ${JSON.stringify(list)}`;
  if (key === lastAnnounced) return;
  lastAnnounced = key;
  for (const h of listChangeHandlers) {
    try { h(list); } catch (hErr) { containerState.logger?.warn?.({ err: hErr?.message || hErr }, '[containerManager] list-change handler threw'); }
  }
}

/** The list is stale: the next listContainers() reads it. Tells nobody. */
function markContainerListStale() {
  containerListCache = null;
}

/**
 * Read the list: one read at a time, shared by every caller that asks
 * meanwhile (a subscriber that asks while it is told joins the same read). A
 * read that succeeds becomes the cache; one that fails leaves the list stale.
 */
function readContainerList() {
  if (!readPromise) {
    const waiters = refreshWaiters;
    refreshWaiters = [];
    refreshQueued = false;
    readPromise = fetchContainerListFromDisk()
      .then((list) => { containerListCache = list; announce(list, null); return list; })
      .catch((err) => { markContainerListStale(); announce(null, err); throw err; })
      .finally(() => {
        readPromise = null;
        for (const resolve of waiters) resolve();
        if (refreshQueued) readContainerList().catch(logRefreshFailure);
      });
  }
  return readPromise;
}

function logRefreshFailure(err) {
  containerState.logger?.warn?.({ err: err.message }, '[containerManager] container list refresh failed');
}

/**
 * Refresh the list cache. A call while a read is in flight queues exactly
 * one follow-up. The returned promise resolves once a read that started
 * after this call has finished (never rejects — failures are logged), so a
 * caller that awaits it reads its own writes through `listContainers()`.
 */
export function refreshContainerListCache() {
  // No cache without the events stream (listContainers reads disk on every call).
  if (!containerState.watchEvents) return Promise.resolve();
  const done = new Promise((resolve) => { refreshWaiters.push(resolve); });
  if (readPromise) {
    refreshQueued = true;
  } else {
    readContainerList().catch(logRefreshFailure);
  }
  return done;
}

// Stream-level errors (e.g. `UNAVAILABLE: Connection dropped`) don't trigger
// the gRPC channel-level disconnect handler, so without an explicit reconnect
// the subscription stays dead until backend restart and the list cache goes
// deaf to every subsequent lifecycle event. The same loop retries a connect
// that failed (containerd down when Wisp started): it is the one reconnect.
const EVENTS_RECONNECT_INITIAL_MS = 1000;
const EVENTS_RECONNECT_MAX_MS = 30000;
let eventsReconnectDelayMs = EVENTS_RECONNECT_INITIAL_MS;
let eventsReconnectTimer = null;

function scheduleEventsReconnect() {
  if (eventsReconnectTimer || !containerState.clients || !containerState.watchEvents) return;
  const delay = eventsReconnectDelayMs;
  eventsReconnectDelayMs = Math.min(eventsReconnectDelayMs * 2, EVENTS_RECONNECT_MAX_MS);
  eventsReconnectTimer = setTimeout(() => {
    eventsReconnectTimer = null;
    if (!containerState.connected) {
      // A connect that succeeds runs the connect subscribers below, which
      // start the stream and read the list.
      retryConnect().catch((err) => {
        containerState.logger?.warn?.({ err: err?.message || String(err) }, 'containerd connect failed — retrying');
        scheduleEventsReconnect();
      });
      return;
    }
    startEventsStream();
    // Catch up on anything that happened during the gap: the list, and the image
    // store (no image event reached us meanwhile).
    refreshContainerListCache();
    announceImagesChange();
  }, delay);
}

function clearEventsReconnect() {
  if (eventsReconnectTimer) {
    clearTimeout(eventsReconnectTimer);
    eventsReconnectTimer = null;
  }
  eventsReconnectDelayMs = EVENTS_RECONNECT_INITIAL_MS;
}

function startEventsStream() {
  if (eventsStream || !containerState.connected || !containerState.watchEvents) return;
  try {
    eventsStream = callStream(getClient('events'), 'subscribe', { filters: [] });
    eventsStream.on('data', (envelope) => {
      // First event after a (re)subscribe proves the stream is healthy.
      eventsReconnectDelayMs = EVENTS_RECONNECT_INITIAL_MS;
      if (envelope?.topic && LIST_AFFECTING_TOPICS.has(envelope.topic)) {
        refreshContainerListCache();
      }
      if (envelope?.topic === '/tasks/exit') handleTaskExitEvent(envelope.event);
      if (IMAGE_TOPICS.has(envelope?.topic) && (!envelope.namespace || envelope.namespace === NAMESPACE)) {
        announceImagesChange();
      }
    });
    eventsStream.on('error', (err) => {
      containerState.logger?.warn?.({ err: err?.message || String(err) }, 'containerd events stream error — will reconnect');
      stopEventsStream();
      // containerd may be gone: the list is read again by whoever next asks for
      // it (with a tab open, the host stats every 5 s).
      markContainerListStale();
      scheduleEventsReconnect();
    });
    eventsStream.on('end', () => {
      eventsStream = null;
      scheduleEventsReconnect();
    });
  } catch (err) {
    containerState.logger?.warn?.({ err: err?.message || String(err) }, 'containerd events subscribe failed — will reconnect');
    eventsStream = null;
    scheduleEventsReconnect();
  }
}

function stopEventsStream() {
  if (!eventsStream) return;
  try { eventsStream.cancel(); } catch { /* already cancelled */ }
  eventsStream = null;
}

subscribeContainerdConnect(() => {
  clearEventsReconnect();
  startEventsStream();
  refreshContainerListCache();
  announceImagesChange(); // image events missed while containerd was away
});
subscribeContainerdConnectFailed(scheduleEventsReconnect);
subscribeContainerdDisconnect(() => {
  clearEventsReconnect();
  stopEventsStream();
  markContainerListStale();
  lastAnnounced = null;
});
subscribeContainerConfigWrite(refreshContainerListCache);
subscribeScheduledRestartChange(refreshContainerListCache);

/**
 * Subscribe to the container list's changes: `handler(list)` when a read gives
 * a list other than the one last announced, `handler(null)` when it fails where
 * the last announcement was a list or another error. Returns an unsubscribe.
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
  // Without the events stream nothing keeps the cache coherent — read disk each time.
  if (!containerState.watchEvents) return fetchContainerListFromDisk();
  return containerListCache ?? readContainerList();
}

/**
 * Number of containers in the running state (for host stats bar).
 */
export async function getRunningContainerCount() {
  const list = await listContainers();
  return list.filter((c) => c.state === 'running').length;
}

/**
 * Containers whose mounts reference a storage-mount entry by id: a host mount
 * delete refuses while any container still has `mounts[*].sourceId ===
 * mountId` (its next start would bind a missing source). Reads the container
 * list and each config; a read that fails throws, so the delete is refused
 * rather than reading the failure as "nobody uses it".
 */
export async function findContainersUsingStorageMount(mountId) {
  const refs = [];
  for (const entry of await listContainers()) {
    const config = await readContainerConfig(entry.name);
    const mounts = Array.isArray(config?.mounts) ? config.mounts : [];
    if (mounts.some((m) => m && m.sourceId === mountId)) refs.push(entry.name);
  }
  return refs;
}

/**
 * Containers whose image is `imageName` — an image name exactly as containerd
 * lists it. A container.json image matches when it is that name verbatim (how
 * create stores it, including local-only names like `myapp:v1`) or normalizes
 * to it (a hand-written short ref). Reads the container list and each config;
 * a read that fails throws.
 */
export async function findContainersUsingImage(imageName) {
  const users = [];
  for (const entry of await listContainers()) {
    const img = (await readContainerConfig(entry.name)).image;
    if (typeof img !== 'string' || !img) continue;
    if (img === imageName || normalizeImageRef(img) === imageName) users.push(entry.name);
  }
  return users;
}

/**
 * Get the full config for a single container (for detail view). Writes nothing:
 * the stored config plus runtime state.
 */
export async function getContainerConfig(name) {
  const config = await readContainerConfig(name);

  const task = await getTaskState(name);
  const state = task ? containerTaskStatusToUi(task) : 'stopped';
  const pid = task ? Number(task.pid) || 0 : 0;

  let uptime = 0;
  if (state === 'running') {
    const fromProc = pid ? await processUptimeMsFromProc(pid) : null;
    if (fromProc != null) {
      uptime = fromProc;
    } else if (containerState.containerStartTimes.has(name)) {
      uptime = Date.now() - containerState.containerStartTimes.get(name);
    }
  }

  if (!(await pendingRestartInForce(config, pid))) delete config.pendingRestart;

  const localDns = config.localDns === true;

  const libraryDigests = await readLibraryDigestMap();

  return {
    ...config,
    localDns,
    mdnsHostname: localDns ? getRegisteredHostname(name) : null,
    state,
    pid,
    uptime,
    type: 'container',
    updateAvailable: deriveUpdateAvailable(config, state, libraryDigests),
    scheduledRestart: getScheduledRestart(name),
  };
}
