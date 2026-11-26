/**
 * Importing an image archive (the tar `docker save` or `podman save` writes)
 * into containerd: the archive is streamed to the Transfer service over its
 * Streaming service, and each image it names is stored under `localhost/`.
 *
 * containerd cannot rename on import: an image is stored under the name its
 * archive carries, or under a name the import gives it. So the transfer stores
 * each image under a name of the import's own (IMAGE_IMPORT_NAME_PREFIX plus
 * the image's digest), and the archive's names come back in its progress
 * events; once every image is known to be for this host, each is created
 * under its `localhost/` name, and the import's own names are removed. No
 * image under the archive's own name is created or changed on the way.
 */
import { randomBytes } from 'node:crypto';
import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  containerError, containerState, getClient, callUnary, packProtoAny,
} from './containerManagerConnection.js';
import { openProgressStream, openFileSendStream } from './containerManagerTransferStreams.js';
import { readContent } from './containerManagerPull.js';
import { SNAPSHOTTER } from './containerManagerSnapshot.js';
import {
  HOST_PLATFORM, hostLinuxManifests, formatPlatform,
} from './containerManagerPlatform.js';
import {
  IMAGE_IMPORT_NAME_PREFIX, isImageImportWorkName, localImageNameFor, normalizeImageRef,
} from './containerImageRef.js';
import { ensureContainersDir, getContainersPath } from './containerPaths.js';
import { createStallWatchdog, stallMinutes } from '../../storage/index.js';

/**
 * No total bound: an import takes as long as its archive is big, but it is
 * stopped after IMPORT_STALL_MS without progress (CODING-RULES §6). Progress
 * is a window of bytes containerd grants for the archive, or one of its
 * progress events. Once the last byte is sent containerd unpacks the images
 * and reports nothing until it ends: the same bound holds for that.
 */
const IMPORT_STALL_MS = 5 * 60_000;
/** containerd sends `Completed import` before the transfer returns: its wait is short. */
const COMPLETED_EVENT_MS = 10_000;

/** containerd's own refusal of an archive that has no image for the filter's platform (images.ErrEmptyWalk). */
const FILTERED_OUT_TEXT = 'image might be filtered out';
const ANNOTATION_IMAGE_NAME = 'io.containerd.image.name';
const ANNOTATION_REF_NAME = 'org.opencontainers.image.ref.name';
const MEDIA_INDEX = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

const STAGING_PREFIX = '.image-import-';
const STAGING_SUFFIX = '.tar';
const STAGING_NAME_RE = /^\.image-import-[0-9a-f]{16}\.tar$/;

/**
 * A new path for an upload's archive, in the containers path: the caller
 * stages the archive there and hands it to storeImagesFromArchive, which removes
 * it, however the import ends.
 */
export async function newImageImportStagingPath() {
  if (!containerState.connected) throw containerError('NO_CONTAINERD', 'Not connected to containerd');
  await ensureContainersDir();
  return join(getContainersPath(), `${STAGING_PREFIX}${randomBytes(8).toString('hex')}${STAGING_SUFFIX}`);
}

/** A gRPC error's own text, without the status prefix grpc-js adds (`2 UNKNOWN: `). */
function containerdText(err) {
  return String(err?.raw ?? err?.message ?? '').replace(/^\d+ [A-Z_]+: /, '');
}

/** The full name an image carries in the archive, or null: one with no repository names none. */
function archiveImageName(annotations) {
  const name = annotations?.[ANNOTATION_IMAGE_NAME];
  if (name) return name;
  const ref = annotations?.[ANNOTATION_REF_NAME];
  // A ref name of a tag alone (`v1`) names no repository.
  return ref && /[/:@]/.test(ref) ? ref : null;
}

/**
 * The platforms the image `desc` holds, and whether one is this host's. An
 * index is for the host when one of its manifests is; a manifest, when its
 * config is.
 */
async function imagePlatforms(desc) {
  const doc = JSON.parse((await readContent(desc.digest)).toString('utf8'));
  if (MEDIA_INDEX.has(desc.mediaType) || Array.isArray(doc.manifests)) {
    const manifests = doc.manifests || [];
    const platforms = manifests
      .map((m) => m.platform)
      .filter((p) => p?.os && p.os !== 'unknown')
      .map(formatPlatform);
    return { platforms, forHost: hostLinuxManifests(manifests).length > 0 };
  }
  const config = JSON.parse((await readContent(doc.config.digest)).toString('utf8'));
  const platform = { os: config.os, architecture: config.architecture, variant: config.variant };
  return {
    platforms: platform.os ? [formatPlatform(platform)] : [],
    forHost: hostLinuxManifests([{ platform }]).length > 0,
  };
}

/** Delete every image under `prefix`: an import's own names. */
async function removeImagesUnder(prefix) {
  const { images = [] } = await callUnary(getClient('images'), 'list', { filters: [] });
  for (const { name } of images) {
    if (!name?.startsWith(prefix)) continue;
    try {
      await callUnary(getClient('images'), 'delete', { name, sync: false });
    } catch (err) {
      if (err.code !== 'CONTAINER_NOT_FOUND') throw err;
    }
  }
}

/** Create the image `name` on `target`, or point the one by that name at it. */
async function storeImage(name, target) {
  const image = { name, target: { mediaType: target.mediaType, digest: target.digest, size: target.size } };
  try {
    await callUnary(getClient('images'), 'create', { image });
  } catch (err) {
    if (err.code !== 'CONTAINER_EXISTS') throw err;
    await callUnary(getClient('images'), 'update', { image, updateMask: { paths: ['target'] } });
  }
}

/**
 * Run the transfer: stream the archive, store its images under `workPrefix`.
 * Resolves with the `saved` progress events of the images that name one.
 */
async function transferArchive(archivePath, workPrefix, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const watchdog = createStallWatchdog({
    stallMs: IMPORT_STALL_MS,
    onStall: () => controller.abort(
      containerError('CONTAINERD_ERROR', `The image import made no progress for ${stallMinutes(IMPORT_STALL_MS)} and was stopped`),
    ),
  });

  const saved = [];
  const completed = Promise.withResolvers();
  let progress = null;
  let sender = null;
  let fh = null;
  try {
    fh = await open(archivePath, 'r');
    progress = await openProgressStream((ev) => {
      watchdog.poke();
      if (ev?.event === 'saved' && ev.name?.startsWith(workPrefix)) saved.push(ev);
      if (ev?.event === 'Completed import') completed.resolve();
    });
    sender = await openFileSendStream(fh, () => watchdog.poke());

    const source = packProtoAny('containerd.types.transfer.ImageImportStream', { stream: sender.id, mediaType: '' });
    const destination = packProtoAny('containerd.types.transfer.ImageStore', {
      platforms: [HOST_PLATFORM],
      unpacks: [{ platform: HOST_PLATFORM, snapshotter: SNAPSHOTTER }],
      // No name of the archive's matches the prefix: each image is stored
      // under the prefix and its digest only.
      extraReferences: [{ name: workPrefix, isPrefix: true, addDigest: true }],
    });
    try {
      await callUnary(getClient('transfer'), 'transfer', {
        source, destination, options: { progress: progress.id },
      }, { deadlineMs: null, signal: controller.signal });
    } catch (err) {
      // containerd may stop reading before the archive's end: the sender
      // would wait on a window that never comes.
      sender.close();
      await sender.sent.catch(() => { /* the transfer's own error says what failed */ });
      throw archiveRefusal(err, controller.signal);
    }
    try {
      await sender.sent;
    } catch (err) {
      throw containerError('CONTAINERD_ERROR', 'The image archive could not be sent to containerd', err.message);
    }

    // `saved` events precede `Completed import` on the one stream: once it is
    // here, every name is.
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(containerError('CONTAINERD_ERROR', 'containerd did not report the images it imported')), COMPLETED_EVENT_MS);
    });
    try {
      await Promise.race([completed.promise, late]);
    } finally {
      clearTimeout(timer);
    }
    return saved;
  } finally {
    watchdog.stop();
    signal?.removeEventListener('abort', onAbort);
    sender?.close();
    progress?.close();
    await fh?.close();
  }
}

/** What a failed transfer says about the archive: Wisp's own code for containerd's refusal. */
function archiveRefusal(err, signal) {
  if (signal.aborted || err?.code === 'NO_CONTAINERD') return err;
  const text = containerdText(err);
  if (text.includes(FILTERED_OUT_TEXT)) {
    return containerError(
      'CONTAINER_IMAGE_PLATFORM_MISMATCH',
      `The archive holds no image for ${formatPlatform(HOST_PLATFORM)}`,
    );
  }
  return containerError('CONTAINER_IMAGE_ARCHIVE_INVALID', 'The upload is not an image archive containerd can import', text);
}

/**
 * Import the archive at `archivePath`, and remove it, however the import ends.
 * Every image it names is stored under its `localhost/` name (an image already
 * there is replaced); every one must be for this host, or none is stored.
 * Resolves `{ images: [{ name, digest }] }`, in the archive's order.
 * @param {string} archivePath
 * @param {{ signal?: AbortSignal }} [opts]
 */
export async function storeImagesFromArchive(archivePath, { signal } = {}) {
  const workPrefix = `${IMAGE_IMPORT_NAME_PREFIX}${randomBytes(8).toString('hex')}`;
  try {
    const saved = await transferArchive(archivePath, workPrefix, signal);

    const named = [];
    for (const ev of saved) {
      const archiveName = archiveImageName(ev.desc?.annotations);
      if (!archiveName) continue;
      named.push({ archiveName, name: localImageNameFor(archiveName), desc: ev.desc });
    }
    if (named.length === 0) {
      throw containerError('CONTAINER_IMAGE_ARCHIVE_UNNAMED', 'The archive names no image');
    }

    for (const { archiveName, name, desc } of named) {
      if (isImageImportWorkName(name)) {
        throw containerError('CONTAINER_IMAGE_ARCHIVE_INVALID', `The archive names ${archiveName}, a name Wisp keeps for its imports`);
      }
      const { platforms, forHost } = await imagePlatforms(desc);
      if (!forHost) {
        const host = formatPlatform(HOST_PLATFORM);
        throw containerError(
          'CONTAINER_IMAGE_PLATFORM_MISMATCH',
          platforms.length
            ? `${normalizeImageRef(archiveName)} is for ${platforms.join(', ')}, not ${host}`
            : `${normalizeImageRef(archiveName)} states no platform: it is not for ${host}`,
        );
      }
    }

    const images = [];
    const stored = new Set();
    for (const { name, desc } of named) {
      if (stored.has(name)) continue;
      stored.add(name);
      await storeImage(name, desc);
      images.push({ name, digest: desc.digest });
    }
    return { images };
  } finally {
    await removeImagesUnder(workPrefix).catch((err) => {
      containerState.logger?.warn?.({ err: err?.message || String(err), prefix: workPrefix }, 'Could not remove an image import\'s own names: the next start removes them');
    });
    await unlink(archivePath).catch((err) => {
      if (err.code !== 'ENOENT') containerState.logger?.warn?.({ err: err.message, file: archivePath }, 'Could not remove an image upload\'s staging file');
    });
  }
}

/**
 * What an import that a crash cut short left: its staging files in the
 * containers path, and images under the import's own names. Logs and goes on:
 * a leftover that stays is removed at the next start.
 */
export async function removeImageImportLeftoversAtBackendBoot(log) {
  const dir = getContainersPath();
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn({ err, dir }, 'Could not read the containers directory to remove image upload leftovers');
  }
  for (const entry of entries) {
    if (!STAGING_NAME_RE.test(entry)) continue;
    try {
      await unlink(join(dir, entry));
      log.warn({ file: join(dir, entry) }, 'Removed an image upload\'s staging file left by an earlier run');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn({ err, file: join(dir, entry) }, 'Could not remove an image upload\'s staging file');
    }
  }
  if (!containerState.connected) return;
  try {
    await removeImagesUnder(IMAGE_IMPORT_NAME_PREFIX);
  } catch (err) {
    log.warn({ err }, 'Could not remove the images an interrupted image import left');
  }
}
