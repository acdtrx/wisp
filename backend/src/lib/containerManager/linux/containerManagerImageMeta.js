/**
 * The OCI image-meta sidecar: the image list's pinned "modified" times, and
 * the library digest of every ref, which the container list reads for its
 * `updateAvailable` without a containerd round trip.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { getContainersPath } from './containerPaths.js';
import { writeJsonAtomic } from '../../base/index.js';

/**
 * Sidecar pinning OCI image "modified" timestamps by digest.
 *
 * Why: containerd's Transfer service bumps `updatedAt` on every pull, including
 * idempotent re-pulls during update checks. Without a pin, every check resets
 * every image's displayed Modified timestamp to "just now". We remember the
 * first containerd `updatedAt` we see for each (ref, digest) and keep returning
 * it until the digest actually changes. Hidden file inside `containersPath` —
 * containerManager owns this directory after configure(), so the sidecar
 * lives with the manager's other private state. Cache only; if missing,
 * code returns `{}` and rebuilds on next pull.
 */
const OCI_META_FILE = '.oci-image-meta.json';

function imageMetaPath() {
  return join(getContainersPath(), OCI_META_FILE);
}

export async function readImageMeta() {
  try {
    const raw = await readFile(imageMetaPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // no meta file yet, or one cut short: no meta, written whole by the next pull
  }
}

/**
 * Current library digest for every ref recorded in the sidecar. Used to derive
 * per-container `updateAvailable` without a containerd roundtrip per container.
 * @returns {Promise<Map<string, string>>} ref → digest
 */
export async function readLibraryDigestMap() {
  const meta = await readImageMeta();
  const map = new Map();
  for (const [ref, entry] of Object.entries(meta)) {
    if (entry && typeof entry.digest === 'string' && entry.digest) {
      map.set(ref, entry.digest);
    }
  }
  return map;
}

export async function writeImageMeta(data) {
  try {
    await writeJsonAtomic(imageMetaPath(), data);
  } catch {
    /* best-effort: sidecar is a cache, not critical state */
  }
}

/* Single-writer lock around the read-modify-write sequence in listContainerImages
 * (and any future caller). `listContainerImages` is invoked concurrently from
 * the periodic update checker and the UI; without this lock two passes could
 * each read meta, drop different orphan keys, and clobber each other on write. */
let imageMetaWriteLock = Promise.resolve();
export async function withImageMetaWriteLock(fn) {
  const next = imageMetaWriteLock.then(fn);
  imageMetaWriteLock = next.catch(() => {
    /* lock chain must not reject — failure surfaced from the returned promise */
  });
  return next;
}
