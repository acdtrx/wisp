/**
 * Image pulls and the image's own description: the Transfer pull, the manifest
 * resolution to this host's Linux platform, and the image config.
 */
import { randomBytes } from 'node:crypto';

import {
  containerError, getClient, callUnary, callStream, callBidi, collectStream, STREAM_DEADLINE_MS, packProtoAny, unpackAny,
} from './containerManagerConnection.js';
import { normalizeImageRef } from './containerImageRef.js';
import { createStallWatchdog, stallMinutes } from '../../storage/index.js';
import { SNAPSHOTTER } from './containerManagerSnapshot.js';
import { OCI_ARCH, hostLinuxManifests } from './containerManagerPlatform.js';

/**
 * An image pull runs as long as the image is big: no total bound, but it is
 * stopped after PULL_STALL_MS without progress (CODING-RULES §6). Progress is
 * the transfer service's own progress stream: bytes fetched, bytes extracted.
 */
const PULL_STALL_MS = 5 * 60_000;
/** Opening the progress stream is one round trip. */
const PROGRESS_STREAM_OPEN_MS = 30_000;

function formatPlatform(p) {
  if (!p?.os) return '';
  const os = p.os;
  const arch = p.architecture || '?';
  const v = p.variant ? `/${p.variant}` : '';
  return `${os}/${arch}${v}`;
}

/**
 * Pick the child descriptor for this host from an OCI index / Docker manifest list.
 * Never falls back to an arbitrary first entry (avoids selecting Windows on multi-arch images).
 */
function selectLinuxManifestDescriptor(manifests) {
  const linux = hostLinuxManifests(manifests);
  if (linux.length === 0) {
    const available = manifests
      .map((m) => formatPlatform(m.platform))
      .filter(Boolean);
    const hint = available.length ? available.join(', ') : 'no platform metadata on index';
    throw containerError(
      'IMAGE_PULL_FAILED',
      `No Linux image manifest for ${OCI_ARCH} in this image. Available platforms: ${hint}`,
    );
  }
  return linux[0];
}

/**
 * Pull an OCI image using the Transfer gRPC service (containerd 2.0+).
 * Source/destination are proto messages packed into google.protobuf.Any
 * with binary protobuf encoding (containerd's typeurl uses proto.Marshal).
 */
export async function pullImage(imageRef, onStep) {
  const ref = normalizeImageRef(imageRef);
  onStep?.({ step: 'pulling', detail: `Pulling ${ref}…` });

  const source = packProtoAny('containerd.types.transfer.OCIRegistry', {
    reference: ref,
  });

  const hostPlatform =
    OCI_ARCH === 'arm64'
      ? { os: 'linux', architecture: OCI_ARCH, variant: 'v8' }
      : { os: 'linux', architecture: OCI_ARCH };

  const destination = packProtoAny('containerd.types.transfer.ImageStore', {
    name: ref,
    platforms: [hostPlatform],
    unpacks: [{
      platform: hostPlatform,
      snapshotter: SNAPSHOTTER,
    }],
  });

  const controller = new AbortController();
  const watchdog = createStallWatchdog({
    stallMs: PULL_STALL_MS,
    onStall: () => controller.abort(
      containerError('IMAGE_PULL_FAILED', `Pulling ${ref} made no progress for ${stallMinutes(PULL_STALL_MS)} and was stopped`),
    ),
  });
  let progress = null;
  try {
    // containerd re-sends an extracting layer's progress every tick, changed or
    // not: only a new step or a moved byte count is progress.
    const seen = new Map();
    progress = await openProgressStream((ev) => {
      const key = `${ev?.name ?? ''}|${ev?.event ?? ''}`;
      const value = String(ev?.progress ?? '');
      if (seen.get(key) === value) return;
      seen.set(key, value);
      watchdog.poke();
    });
    await callUnary(getClient('transfer'), 'transfer', {
      source,
      destination,
      options: { progress: progress.id },
    }, { deadlineMs: null, signal: controller.signal });
  } finally {
    watchdog.stop();
    progress?.close();
  }

  onStep?.({ step: 'pulled', detail: `Image ${ref} pulled` });
  return ref;
}

/**
 * Open a transfer progress stream (containerd's Streaming service): its id
 * goes into the transfer's options, and `onEvent` gets each progress event.
 * Resolves once containerd acknowledges the stream.
 */
function openProgressStream(onEvent) {
  const id = `wisp-pull-${randomBytes(8).toString('hex')}`;
  const stream = callBidi(getClient('streaming'), 'stream');
  const close = () => { try { stream.cancel(); } catch { /* a stream that already ended refuses the cancel: it is ended either way */ } };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(containerError('CONTAINERD_ERROR', `containerd did not open the pull progress stream within ${PROGRESS_STREAM_OPEN_MS / 1000} s`));
    }, PROGRESS_STREAM_OPEN_MS);
    stream.once('error', (err) => {
      clearTimeout(timer);
      reject(containerError('CONTAINERD_ERROR', 'Could not open the pull progress stream', err.message));
    });
    stream.once('data', () => { // the ack: the stream is ready
      clearTimeout(timer);
      stream.on('data', (any) => onEvent(unpackAny(any)));
      stream.removeAllListeners('error');
      stream.on('error', () => { /* ends with the pull: a lost stream only loses progress */ });
      resolve({ id, close });
    });
    stream.write(packProtoAny('containerd.services.streaming.v1.StreamInit', { id }));
  });
}

/**
 * Read a blob from containerd's content store by digest.
 */
async function readContent(digest) {
  const chunks = await collectStream(
    callStream(getClient('content'), 'read', { digest }, { deadlineMs: STREAM_DEADLINE_MS }),
  );
  return Buffer.concat(chunks.map((c) => c.data));
}

/**
 * Resolve an image reference to this host's Linux image manifest.
 * Walks OCI index / Docker manifest list (and nested indexes) — never uses manifests[0] as fallback.
 */
async function resolveManifest(imageRef) {
  const imgRes = await callUnary(getClient('images'), 'get', { name: imageRef });
  const digest = imgRes.image?.target?.digest;
  if (!digest) return null;

  let parsed = JSON.parse((await readContent(digest)).toString('utf8'));
  const maxDepth = 8;
  let depth = 0;

  while (parsed.manifests && depth < maxDepth) {
    const entry = selectLinuxManifestDescriptor(parsed.manifests);
    if (!entry?.digest) return null;
    parsed = JSON.parse((await readContent(entry.digest)).toString('utf8'));
    depth += 1;
  }

  if (parsed.manifests) {
    throw containerError(
      'IMAGE_PULL_FAILED',
      'Could not resolve image manifest: index nesting too deep or unresolved platform list',
    );
  }

  return parsed;
}

/**
 * Get the OCI image config (Entrypoint, Cmd, Env, WorkingDir, rootfs, etc.)
 * by reading the config blob from the content store.
 */
export async function getImageConfig(imageRef) {
  const manifest = await resolveManifest(imageRef);
  if (!manifest?.config?.digest) return {};
  return JSON.parse((await readContent(manifest.config.digest)).toString('utf8'));
}
