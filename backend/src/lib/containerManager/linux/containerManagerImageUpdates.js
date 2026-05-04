/**
 * OCI image update checker.
 *
 * Bulk or per-image: re-pulls every image via the Transfer service (idempotent — containerd
 * skips layer downloads when the digest matches). Update availability is never persisted on
 * containers — it's derived at read time from (`container.imageDigest` != current library digest)
 * + (task RUNNING/PAUSED). This module just reports how many containers WOULD now show the flag
 * so the UI can surface counts.
 *
 * Mirrors the `osUpdates` background-check pattern.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';
import {
  listContainerImages, findContainersUsingImage, getImageDigest,
} from './containerManagerImages.js';
import { pullImage } from './containerManagerCreate.js';
import { getTaskState, normalizeTaskStatus } from './containerManagerLifecycle.js';

export { getImageDigest };

/** Cached summary — returned by GET /api/containers/images/update-status. */
let lastCheckedAt = null;
let lastImagesChecked = 0;
let lastImagesUpdated = 0;

export function getImageUpdateStatus() {
  return {
    lastCheckedAt,
    imagesChecked: lastImagesChecked,
    imagesUpdated: lastImagesUpdated,
  };
}

/**
 * Would this container show an update badge given a new library digest?
 * True when the container is running/paused AND its stored `imageDigest`
 * differs from the new digest. Read-only — nothing is persisted.
 */
async function containerFlaggedForDigest(name, newDigest) {
  const configPath = join(getContainerDir(name), 'container.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return false;
  }
  if (!config.imageDigest || config.imageDigest === newDigest) return false;
  try {
    const task = await getTaskState(name);
    if (!task) return false;
    const st = normalizeTaskStatus(task.status);
    return st === 'RUNNING' || st === 'PAUSED';
  } catch {
    return false;
  }
}

/**
 * Pull a single ref and report how many containers would now show an update badge.
 * Internal; does not update cached summary, does not write to container.json.
 * @param {string} ref
 * @param {(ev: object) => void} [onProgress]
 * @param {{ index: number, total: number }} position
 * @returns {Promise<{ changed: boolean, flaggedCount: number }>}
 */
async function checkOneImage(ref, onProgress, position) {
  onProgress?.({ step: 'checking', ref, index: position.index, total: position.total });

  const before = await getImageDigest(ref);

  try {
    await pullImage(ref, () => {});
  } catch (err) {
    onProgress?.({ step: 'skipped', ref, reason: err?.message || 'pull failed' });
    return { changed: false, flaggedCount: 0 };
  }

  const after = await getImageDigest(ref);
  if (!after || after === before) {
    onProgress?.({ step: 'unchanged', ref });
    return { changed: false, flaggedCount: 0 };
  }

  onProgress?.({ step: 'updated', ref, oldDigest: before, newDigest: after });

  let flaggedCount = 0;
  const users = await findContainersUsingImage(ref);
  for (const name of users) {
    if (await containerFlaggedForDigest(name, after)) {
      flaggedCount += 1;
      onProgress?.({ step: 'flagged-container', name });
    }
  }
  return { changed: true, flaggedCount };
}

/**
 * Bulk check: iterate every image in the library, pull each, flag affected containers.
 * @param {(ev: object) => void} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ checked: number, updated: number, flaggedContainers: number, lastCheckedAt: string }>}
 */
export async function checkAllImagesForUpdates(onProgress, signal) {
  const images = await listContainerImages();
  const total = images.length;
  let updatedCount = 0;
  let flaggedContainers = 0;

  for (let i = 0; i < images.length; i += 1) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const ref = images[i].name;
    const res = await checkOneImage(ref, onProgress, { index: i + 1, total });
    if (res.changed) updatedCount += 1;
    flaggedContainers += res.flaggedCount;
  }

  lastCheckedAt = new Date().toISOString();
  lastImagesChecked = total;
  lastImagesUpdated = updatedCount;

  return {
    checked: total,
    updated: updatedCount,
    flaggedContainers,
    lastCheckedAt,
  };
}

/**
 * Single-image variant (per-row "Check this image" action).
 * @param {string} ref
 * @param {(ev: object) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
export async function checkSingleImageForUpdates(ref, onProgress, signal) {
  if (!ref || typeof ref !== 'string') {
    throw containerError('INVALID_CONTAINER_IMAGE_REF', 'Image reference is required');
  }
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

  const res = await checkOneImage(ref, onProgress, { index: 1, total: 1 });

  lastCheckedAt = new Date().toISOString();

  return {
    checked: 1,
    updated: res.changed ? 1 : 0,
    flaggedContainers: res.flaggedCount,
    lastCheckedAt,
  };
}

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 60 * 60 * 1000;

let intervalId = null;
let initialTimeoutId = null;

/** AbortController for the in-flight background sweep — cancelled on SIGTERM. */
let activeBackgroundCheckAbort = null;

export function startImageUpdateChecker(log) {
  if (intervalId != null) return;

  function runCheck() {
    const ac = new AbortController();
    activeBackgroundCheckAbort = ac;
    checkAllImagesForUpdates(() => {}, ac.signal)
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        if (log) log.warn({ err: err?.message || String(err) }, 'Background image update check failed');
      })
      .finally(() => {
        if (activeBackgroundCheckAbort === ac) activeBackgroundCheckAbort = null;
      });
  }

  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    runCheck();
  }, INITIAL_DELAY_MS);
  intervalId = setInterval(runCheck, INTERVAL_MS);
}

export function stopImageUpdateChecker() {
  if (initialTimeoutId != null) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (activeBackgroundCheckAbort != null) {
    try {
      activeBackgroundCheckAbort.abort();
    } catch { /* sync; ignore */ }
    activeBackgroundCheckAbort = null;
  }
}
