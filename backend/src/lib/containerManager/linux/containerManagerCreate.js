/**
 * Container creation: the name check, the container directory, the image
 * (pulled when not local), container.json and the containerd definition
 * (stopped — no task). Start is containerManagerStart.js.
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { containerError, getClient, callUnary, packAny } from './containerManagerConnection.js';
import { buildOCISpec, OCI_SPEC_TYPE_URL } from './containerManagerSpec.js';
import { getContainersPath, getContainerDir, getContainerFilesDir, resolveMount } from './containerPaths.js';
import { generateContainerMac, resolveContainerResolvConf } from './containerManagerNetwork.js';
import { getDefaultContainerParentBridge } from '../../networking/index.js';
import { resolveDeviceSpecs } from './containerDeviceNode.js';
import { getImageDigest, resolveContainerImageRef } from './containerManagerImages.js';
import { writeContainerConfig } from './containerManagerConfigIo.js';
import { validateAndNormalizeMounts } from './containerManagerMounts.js';
import { validateAndNormalizeDevices } from './containerManagerDevices.js';
import { pullImage, getImageConfig } from './containerManagerPull.js';
import { SNAPSHOTTER, prepareSnapshot, getSnapshotMounts } from './containerManagerSnapshot.js';

const RUNTIME_NAME = 'io.containerd.runc.v2';

/**
 * The name checks a create makes first, quick and without side effects:
 * INVALID_CONTAINER_NAME, and CONTAINER_EXISTS when containerd or the
 * containers directory already has the name.
 */
export async function assertContainerNameAvailable(name) {
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    throw containerError('INVALID_CONTAINER_NAME', 'Container name must be alphanumeric (with . _ -), 1-63 chars');
  }
  try {
    await callUnary(getClient('containers'), 'get', { id: name });
    throw containerError('CONTAINER_EXISTS', `Container "${name}" already exists`);
  } catch (err) {
    if (err.code !== 'CONTAINER_NOT_FOUND') throw err;
  }
  try {
    await stat(getContainerDir(name));
    // No absolute path in the detail: the route redacts paths, and MCP shows it as is.
    throw containerError(
      'CONTAINER_EXISTS',
      `Container directory for "${name}" already exists`,
      `The directory "${name}" under the containers path is left over from a deleted container (kept files?) — move or remove it, or pick another name`,
    );
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Create a new container: pull image, create snapshot, define in containerd (stopped — no task).
 * @param {object} spec - Container spec from the API (create flow uses name + image only)
 * @param {function} onStep - Progress callback
 * @returns {{ name: string }}
 */
export async function createContainer(spec, onStep) {
  const { name } = spec;
  if (!name || typeof name !== 'string') {
    throw containerError('INVALID_CONTAINER_NAME', 'Container name is required');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) {
    throw containerError('INVALID_CONTAINER_NAME', 'Container name must be alphanumeric (with . _ -), 1-63 chars');
  }

  onStep?.({ step: 'validating' });

  // Check if container already exists
  try {
    await callUnary(getClient('containers'), 'get', { id: name });
    throw containerError('CONTAINER_EXISTS', `Container "${name}" already exists`);
  } catch (err) {
    if (err.code !== 'CONTAINER_NOT_FOUND') throw err;
  }

  // Claim the container directory. A non-recursive mkdir refuses an existing one —
  // typically files/ kept by a delete without "delete files" — so create never adopts,
  // overwrites, or (on a later failure) removes a directory it didn't make.
  const containerDir = getContainerDir(name);
  const filesDir = getContainerFilesDir(name);
  await mkdir(getContainersPath(), { recursive: true });
  try {
    // Owner-only: container.json holds secret env values in plaintext, and
    // nothing but the backend reads the directory — containerd/runc (root)
    // bind-mount files/ and open runs/ themselves, and a container sees only
    // its mount points, never this directory.
    await mkdir(containerDir, 0o700);
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw containerError(
        'CONTAINER_EXISTS',
        `Container directory for "${name}" already exists`,
        `${containerDir} is left over from a deleted container (kept files?) — move or remove it, or pick another name`,
      );
    }
    throw err;
  }

  let resolvedDigest;
  try {
    resolvedDigest = await defineNewContainer(spec, filesDir, onStep);
  } catch (err) {
    // This call created containerDir above, so it is ours to remove.
    await rm(containerDir, { recursive: true, force: true });
    throw err;
  }

  // Not `done`: only the caller's job completion emits the terminal step — a
  // caller may still have work to do (an app container writes its config files).
  onStep?.({ step: 'created', name, imageDigest: resolvedDigest || null });
  return { name };
}

/**
 * The body of createContainer once its directory is claimed: resolve/pull the image,
 * write container.json, prepare the snapshot, define the container in containerd.
 * Throws on any failure; the caller removes the directory it created.
 * @returns {Promise<string|null>} resolved image digest
 */
async function defineNewContainer(spec, filesDir, onStep) {
  const { name } = spec;
  await mkdir(filesDir);

  // If the literal ref is already in containerd (e.g. from `ctr -n wisp image import`
  // or an exact match picked from the image library), skip the pull and use it
  // verbatim. This is the only way to handle local-only refs like `myapp:v1` — the
  // normalized `docker.io/library/…` name would fail the registry pull.
  const { ref: imageRef, local } = await resolveContainerImageRef(spec.image);
  if (local) {
    onStep?.({ step: 'using-local', detail: `Using local image ${imageRef}` });
  } else {
    // Pull image (periodic progress — containerd transfer has no %; elapsed time helps long pulls)
    try {
      const pullStarted = Date.now();
      onStep?.({ step: 'pulling', detail: `Pulling ${imageRef}…` });
      const pullProgressTimer = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - pullStarted) / 1000);
        onStep?.({
          step: 'pulling',
          detail: `Pulling ${imageRef}… (${elapsedSec}s elapsed)`,
          elapsedSec,
        });
      }, 15000);
      try {
        await pullImage(imageRef, onStep);
      } finally {
        clearInterval(pullProgressTimer);
      }
    } catch (err) {
      throw containerError('IMAGE_PULL_FAILED', `Failed to pull image "${imageRef}"`, err.message);
    }
  }

  // Get image config for defaults
  let imageConfig = {};
  try {
    imageConfig = await getImageConfig(imageRef);
  } catch (err) {
    if (err.code === 'IMAGE_PULL_FAILED') throw err;
    // Use empty config — user must provide command
  }

  const imgCfg = imageConfig.config || imageConfig || {};
  const exposedPorts = imgCfg.ExposedPorts ? Object.keys(imgCfg.ExposedPorts).sort() : [];

  // Build container.json (create accepts name + image only; network defaults here)
  const network = { type: 'bridge', mac: generateContainerMac() };
  try {
    const parent = await getDefaultContainerParentBridge();
    if (parent) network.interface = parent;
  } catch {
    /* no default bridge — omit interface (setupNetwork will reject on start) */
  }

  let config = {
    name,
    uuid: randomUUID(),
    image: imageRef,
    command: null,
    exposedPorts,
    cpuLimit: null,
    memoryLimitMiB: null,
    restartPolicy: 'unless-stopped',
    autostart: false,
    autoBackup: false,
    localDns: true,
    env: {},
    mounts: [],
    devices: [],
    network,
    createdAt: new Date().toISOString(),
  };
  const iconTrim = spec.iconId != null && spec.iconId !== '' ? String(spec.iconId).trim() : '';
  if (iconTrim) config.iconId = iconTrim;

  // Generic spec fields — set whatever the caller passed. containerApps populates
  // these when creating an app container; future external callers might do the same.
  if (spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)) {
    config.env = spec.env;
  }
  if (Array.isArray(spec.mounts) && spec.mounts.length) {
    config.mounts = validateAndNormalizeMounts(spec.mounts, resolveMount);
  }
  if (Array.isArray(spec.devices) && spec.devices.length) {
    config.devices = validateAndNormalizeDevices(spec.devices);
  }
  if (Array.isArray(spec.services) && spec.services.length) {
    config.services = spec.services.map((s) => ({
      port: s.port,
      type: s.type,
      txt: { ...(s.txt || {}) },
    }));
  }
  if (spec.runAsRoot === true) {
    config.runAsRoot = true;
  }
  if (spec.metadata && typeof spec.metadata === 'object' && !Array.isArray(spec.metadata)) {
    config.metadata = spec.metadata;
  }

  const resolvedDigest = await getImageDigest(imageRef);
  if (resolvedDigest) {
    config.imageDigest = resolvedDigest;
    config.imagePulledAt = new Date().toISOString();
  }

  await writeContainerConfig(name, config);

  onStep?.({ step: 'creating', detail: 'Creating container…' });

  // Build OCI spec
  const resolvConfPath = await resolveContainerResolvConf(config.network?.interface);
  const { deviceSpecs, renderGid } = await resolveDeviceSpecs(config);
  const ociSpec = buildOCISpec(config, imageConfig, filesDir, {
    resolvConfPath, resolveMount, deviceSpecs, renderGid,
  });

  // Prepare snapshot (required before containerd Containers.Create)
  try {
    await prepareSnapshot(name, imageConfig);
  } catch (err) {
    const existing = await getSnapshotMounts(name);
    if (!existing) {
      throw containerError('CONTAINERD_ERROR', `Failed to prepare snapshot for "${name}"`, err.message);
    }
  }

  // Define container in containerd
  try {
    await callUnary(getClient('containers'), 'create', {
      container: {
        id: name,
        image: imageRef,
        runtime: { name: RUNTIME_NAME },
        spec: packAny(OCI_SPEC_TYPE_URL, ociSpec),
        snapshotter: SNAPSHOTTER,
        snapshotKey: name,
        labels: { 'wisp.managed': 'true' },
      },
    });
  } catch (err) {
    if (err.code !== 'CONTAINER_EXISTS') throw err;
  }

  return resolvedDigest;
}
