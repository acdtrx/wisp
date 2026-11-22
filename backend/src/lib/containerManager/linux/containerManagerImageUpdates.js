/**
 * OCI image update checker.
 *
 * Bulk or per-image: re-pulls every image via the Transfer service (idempotent — containerd
 * skips layer downloads when the digest matches). Update availability is never persisted on
 * containers — it's derived at read time from (`container.imageDigest` != current library digest)
 * + (task RUNNING/PAUSED). This module just reports how many containers WOULD now show the flag
 * so the UI can surface counts. Every check ends by refreshing the image-meta sidecar (the
 * library digests `updateAvailable` is derived from) and the container list cache, so
 * every caller surfaces the result the same way.
 */

import { containerError, containerState } from './containerManagerConnection.js';
import {
  listContainerImages, getImageDigest,
} from './containerManagerImages.js';
import { pullImage } from './containerManagerPull.js';
import { getTaskState, normalizeTaskStatus } from './containerManagerLifecycle.js';
import { refreshContainerListCache, findContainersUsingImage } from './containerManagerList.js';
import { readContainerConfig } from './containerManagerConfigIo.js';

export { getImageDigest };

/** The image update check runs on this platform (the hourly trigger arms only where it does). */
export const supportsImageUpdateChecks = true;

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
  const config = await readContainerConfig(name);
  if (!config.imageDigest || config.imageDigest === newDigest) return false;
  const task = await getTaskState(name);
  if (!task) return false;
  const st = normalizeTaskStatus(task.status);
  return st === 'RUNNING' || st === 'PAUSED';
}

const SKIPPED = Symbol('skipped');

/**
 * One digest read of a check. A failure skips the image (reported as `skipped`, with
 * the error as its `cause`), except an unreachable containerd, which ends the whole
 * check with its error.
 * @returns {Promise<string | null | typeof SKIPPED>}
 */
async function readDigestForCheck(ref, onProgress) {
  try {
    return await getImageDigest(ref);
  } catch (err) {
    if (err?.code === 'NO_CONTAINERD') throw err;
    onProgress?.({ step: 'skipped', ref, cause: err });
    return SKIPPED;
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

  const before = await readDigestForCheck(ref, onProgress);
  if (before === SKIPPED) return { changed: false, flaggedCount: 0 };

  try {
    await pullImage(ref, () => {});
  } catch (err) {
    onProgress?.({ step: 'skipped', ref, cause: err });
    return { changed: false, flaggedCount: 0 };
  }

  const after = await readDigestForCheck(ref, onProgress);
  if (after === SKIPPED) return { changed: false, flaggedCount: 0 };
  if (!after || after === before) {
    onProgress?.({ step: 'unchanged', ref });
    return { changed: false, flaggedCount: 0 };
  }

  onProgress?.({ step: 'updated', ref, oldDigest: before, newDigest: after });

  // The image changed; which containers it flags is read from the list and
  // their configs. A read that fails skips the count, with its cause.
  let flaggedCount = 0;
  try {
    for (const name of await findContainersUsingImage(ref)) {
      if (await containerFlaggedForDigest(name, after)) {
        flaggedCount += 1;
        onProgress?.({ step: 'flagged-container', name });
      }
    }
  } catch (err) {
    onProgress?.({ step: 'skipped', ref, cause: err });
  }
  return { changed: true, flaggedCount };
}

/**
 * Publish a finished check: re-read containerd's digests into the image-meta
 * sidecar, then rebuild the container list cache (which fires list-change → SSE)
 * from it. Awaited so callers that read `listContainers()` next see the result.
 */
async function publishCheckResult() {
  try {
    await listContainerImages();
  } catch (err) {
    /* containerd unreachable after the pulls — the sidecar keeps its previous digests */
    containerState.logger?.warn?.({ err: err?.message || String(err) }, 'Image-meta refresh after update check failed');
  }
  await refreshContainerListCache();
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

  await publishCheckResult();

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
  await publishCheckResult();

  lastCheckedAt = new Date().toISOString();

  return {
    checked: 1,
    updated: res.changed ? 1 : 0,
    flaggedContainers: res.flaggedCount,
    lastCheckedAt,
  };
}
