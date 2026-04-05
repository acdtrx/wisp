/**
 * List and delete OCI images in containerd (wisp namespace).
 */
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

import { getClient, callUnary, containerError } from './containerManagerConnection.js';
import { getContainersPath } from './containerPaths.js';
import { normalizeImageRef } from './containerImageRef.js';
import { compressedBlobSizeForImageName } from './containerManagerOciSize.js';

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
 * @returns {Promise<Array<{ name: string, digest: string, size: number, updated: string }>>}
 */
export async function listContainerImages() {
  const res = await callUnary(getClient('images'), 'list', { filters: [] });
  const images = res.images || [];
  const rows = await Promise.all(
    images.map(async (img) => {
      const target = img.target || {};
      const name = img.name || '';
      const updatedAt = img.updatedAt ?? img.updated_at;
      const createdAt = img.createdAt ?? img.created_at;
      const updated =
        protoTimestampToIso(updatedAt) ||
        protoTimestampToIso(createdAt) ||
        null;
      /** Descriptor `target.size` is the top-level manifest/index JSON blob — a few KB. Prefer summed layer + config sizes. */
      const compressedTotal = await compressedBlobSizeForImageName(name);
      const size =
        compressedTotal != null ? compressedTotal : Number(target.size) || 0;
      return {
        name,
        digest: target.digest || '',
        size,
        /** ISO 8601 or null if containerd sent no timestamps */
        updated,
      };
    }),
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

async function findContainersUsingImage(normalizedRef) {
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
