/**
 * A container's rootfs snapshot: prepared from the image's layers, its mounts
 * for the task, removed on start, failed start and delete.
 */
import { createHash } from 'node:crypto';

import { containerError, getClient, callUnary } from './containerManagerConnection.js';

/** Removing a large rootfs snapshot can take a while. */
export const SNAPSHOT_REMOVE_DEADLINE_MS = 2 * 60_000;
export const SNAPSHOTTER = 'overlayfs';

/**
 * Compute the chain ID from an array of layer diff IDs.
 * Matches containerd's identity.ChainID (opencontainers/image-spec/identity):
 *   ChainID([a])    = a
 *   ChainID([a, b]) = SHA256("sha256:<a> sha256:<b>")
 * Go's digest.Digest is the full "algorithm:hex" string; concatenation keeps prefixes.
 */
function computeChainID(diffIDs) {
  if (!diffIDs.length) return '';
  let chain = diffIDs[0];
  for (let i = 1; i < diffIDs.length; i++) {
    chain = `sha256:${createHash('sha256').update(`${chain} ${diffIDs[i]}`).digest('hex')}`;
  }
  return chain;
}

/**
 * Prepare a writable snapshot for a container.
 * The snapshot key is the container name; parent is the chain ID computed
 * from the image config's rootfs.diff_ids (matches containerd's committed snapshot keys).
 */
export async function prepareSnapshot(name, imageConfig) {
  const diffIDs = imageConfig?.rootfs?.diff_ids;
  if (!diffIDs?.length) {
    throw containerError('IMAGE_PULL_FAILED', 'Image has no layers (missing rootfs.diff_ids)');
  }

  const parent = computeChainID(diffIDs);

  const snapRes = await callUnary(getClient('snapshots'), 'prepare', {
    snapshotter: SNAPSHOTTER,
    key: name,
    parent,
    labels: {},
  });

  return snapshotMountsForTask(snapRes.mounts || []);
}

/**
 * Copy snapshot service mounts into plain objects for Tasks.Create.
 * Ensures `target` and `options` match the current Mount proto (containerd 2.x).
 */
function snapshotMountsForTask(mounts) {
  if (!Array.isArray(mounts)) return [];
  return mounts.map((m) => ({
    type: m.type ?? '',
    source: m.source ?? '',
    target: m.target ?? '',
    options: Array.isArray(m.options) ? [...m.options] : [],
  }));
}

/**
 * Try to get snapshot mounts if they already exist.
 */
export async function getSnapshotMounts(name) {
  try {
    const res = await callUnary(getClient('snapshots'), 'mounts', {
      snapshotter: SNAPSHOTTER,
      key: name,
    });
    return snapshotMountsForTask(res.mounts || []);
  } catch {
    return null; // no snapshot under this key yet: null is "make one" to the caller
  }
}
