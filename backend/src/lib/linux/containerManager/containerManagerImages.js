/**
 * List and delete OCI images in containerd (wisp namespace).
 */
import { dirname, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { getClient, callUnary, containerError } from './containerManagerConnection.js';
import { getContainersPath } from './containerPaths.js';
import { CONFIG_PATH } from '../../config.js';
import { writeJsonAtomic } from '../../atomicJson.js';
import { normalizeImageRef } from './containerImageRef.js';
import { compressedBlobSizeForImageName } from './containerManagerOciSize.js';

/**
 * Sidecar pinning OCI image "modified" timestamps by digest.
 *
 * Why: containerd's Transfer service bumps `updatedAt` on every pull, including
 * idempotent re-pulls during update checks. Without a pin, every check resets
 * every image's displayed Modified timestamp to "just now". We remember the
 * first containerd `updatedAt` we see for each (ref, digest) and keep returning
 * it until the digest actually changes. Lives next to wisp-config.json —
 * OCI images are independent of containers, so the file does not belong under
 * containersPath.
 */
const OCI_META_FILE = 'oci-image-meta.json';

function imageMetaPath() {
  return join(dirname(CONFIG_PATH), OCI_META_FILE);
}

async function readImageMeta() {
  try {
    const raw = await readFile(imageMetaPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
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

async function writeImageMeta(data) {
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
async function withImageMetaWriteLock(fn) {
  const next = imageMetaWriteLock.then(fn);
  imageMetaWriteLock = next.catch(() => {
    /* lock chain must not reject — failure surfaced from the returned promise */
  });
  return next;
}

/** @param {unknown} v */
function intFromProtoLong(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  return Number(v);
}

/** google.protobuf.Timestamp from gRPC (field names camelCase when keepCase: false). */
function protoTimestampToIso(ts) {
  if (!ts || typeof ts !== 'object') return null;
  const sec = intFromProtoLong(ts.seconds);
  const nanos = intFromProtoLong(ts.nanos) || 0;
  if (!Number.isFinite(sec)) return null;
  return new Date(sec * 1000 + nanos / 1e6).toISOString();
}

/**
 * Top-level manifest/index digest containerd currently holds for this reference.
 * @returns {Promise<string | null>} null when the image is not locally present.
 */
export async function getImageDigest(imageRef) {
  try {
    const res = await callUnary(getClient('images'), 'get', { name: imageRef });
    return res.image?.target?.digest || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<Array<{ name: string, digest: string, size: number, updated: string }>>}
 */
export async function listContainerImages() {
  const res = await callUnary(getClient('images'), 'list', { filters: [] });
  const images = res.images || [];

  return withImageMetaWriteLock(async () => {
    const meta = await readImageMeta();
    let metaChanged = false;

    const rows = await Promise.all(
      images.map(async (img) => {
        const target = img.target || {};
        const name = img.name || '';
        const digest = target.digest || '';
        const updatedAt = img.updatedAt ?? img.updated_at;
        const createdAt = img.createdAt ?? img.created_at;
        const containerdUpdated =
          protoTimestampToIso(updatedAt) ||
          protoTimestampToIso(createdAt) ||
          null;

        /** Use the pinned timestamp when the digest still matches — otherwise adopt containerd's value. */
        let updated = containerdUpdated;
        const entry = meta[name];
        if (entry && entry.digest === digest && entry.updatedAt) {
          updated = entry.updatedAt;
        } else if (digest) {
          meta[name] = { digest, updatedAt: containerdUpdated };
          metaChanged = true;
        }

        /** Descriptor `target.size` is the top-level manifest/index JSON blob — a few KB. Prefer summed layer + config sizes. */
        const compressedTotal = await compressedBlobSizeForImageName(name);
        const size =
          compressedTotal != null ? compressedTotal : Number(target.size) || 0;
        return {
          name,
          digest,
          size,
          /** ISO 8601 or null if containerd sent no timestamps */
          updated,
        };
      }),
    );

    const currentNames = new Set(images.map((i) => i.name).filter(Boolean));
    for (const key of Object.keys(meta)) {
      if (!currentNames.has(key)) {
        delete meta[key];
        metaChanged = true;
      }
    }
    if (metaChanged) await writeImageMeta(meta);

    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  });
}

export async function findContainersUsingImage(normalizedRef) {
  const basePath = getContainersPath();
  let dirs;
  try {
    dirs = await readdir(basePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const users = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    try {
      const raw = await readFile(join(basePath, name, 'container.json'), 'utf8');
      const config = JSON.parse(raw);
      const img = config.image;
      if (!img || typeof img !== 'string') continue;
      if (normalizeImageRef(img) === normalizedRef) {
        users.push(name);
      }
    } catch {
      /* skip malformed dirs */
    }
  }
  return users;
}

/**
 * Delete an image from containerd by reference. Blocks if any Wisp container still references it.
 */
export async function deleteContainerImage(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) {
    throw containerError('INVALID_CONTAINER_IMAGE_REF', 'Image reference is required');
  }
  const normalized = normalizeImageRef(ref.trim());

  const users = await findContainersUsingImage(normalized);
  if (users.length > 0) {
    const list = users.join(', ');
    throw containerError(
      'CONTAINER_IMAGE_IN_USE',
      `Image is in use by container(s): ${list}`,
      list,
    );
  }

  try {
    await callUnary(getClient('images'), 'delete', { name: normalized, sync: true });
  } catch (err) {
    if (err?.code === 'CONTAINER_NOT_FOUND') {
      throw containerError(
        'CONTAINER_IMAGE_NOT_FOUND',
        `Image not found: ${normalized}`,
        err.raw ?? err.message,
      );
    }
    throw err;
  }
}
