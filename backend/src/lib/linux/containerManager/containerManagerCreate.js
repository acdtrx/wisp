/**
 * Container creation, deletion, and image pulling.
 * Create: image pull → snapshot → OCI spec → containerd container define (stopped). Start is separate (task + network).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';

import {
  containerError, containerState, getClient, callUnary, callStream, collectStream,
  packAny, packProtoAny,
} from './containerManagerConnection.js';
import { buildOCISpec } from './containerManagerSpec.js';
import { getContainersPath, getContainerDir, getContainerFilesDir } from './containerPaths.js';
import { createNewRun } from './containerManagerLogs.js';
import {
  setupNetwork, teardownNetwork, mergeNetworkLeaseIntoConfig,
  generateContainerMac, normalizeContainerMac, ensureContainerNetworkConfig,
  resolveContainerResolvConf,
} from './containerManagerNetwork.js';
import { getDefaultContainerParentBridge } from '../vmManager/vmManagerHost.js';
import { getTaskState, normalizeTaskStatus, cleanupTask } from './containerManagerLifecycle.js';
import {
  registerAddress, deregisterAddress, deregisterServicesForContainer, sanitizeHostname,
} from '../../mdnsManager.js';
import { registerAllContainerServices } from './containerManagerServices.js';
import { assertBindSourcesReady } from './containerManagerMounts.js';
import { getRawMounts } from '../../settings.js';
import { normalizeImageRef } from './containerImageRef.js';
import { getImageDigest } from './containerManagerImages.js';
import { isKnownApp, getAppModule, getAppEntry } from './apps/appRegistry.js';
import { writeContainerConfig, notifyContainerConfigWrite } from './containerManagerConfigIo.js';

const RUNTIME_NAME = 'io.containerd.runc.v2';
const SNAPSHOTTER = 'overlayfs';
const OCI_SPEC_TYPE_URL = 'types.containerd.io/opencontainers/runtime-spec/1/Spec';

const OCI_ARCH = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm' })[process.arch] || process.arch;

/** Map registry architecture strings to OCI-normalized values (matches common image indexes). */
function normalizeOCIArchitecture(arch) {
  if (!arch || typeof arch !== 'string') return '';
  const a = arch.toLowerCase();
  if (a === 'x86_64' || a === 'x86-64') return 'amd64';
  if (a === 'aarch64') return 'arm64';
  return a;
}

function formatPlatform(p) {
  if (!p?.os) return '';
  const os = p.os;
  const arch = p.architecture || '?';
  const v = p.variant ? `/${p.variant}` : '';
  return `${os}/${arch}${v}`;
}

/**
 * Higher = preferred when multiple descriptors match linux + host arch (variant tie-break).
 */
function variantPreference(platform) {
  if (!platform) return 0;
  const arch = normalizeOCIArchitecture(platform.architecture);
  const v = (platform.variant || '').toLowerCase();
  if (arch === 'arm64') {
    if (v === 'v8' || v === '') return 3;
    return 1;
  }
  if (arch === 'arm') {
    if (v === 'v7') return 3;
    if (v === 'v6') return 2;
    if (v === '') return 1;
    return 0;
  }
  return 1;
}

/**
 * Pick the child descriptor for this host from an OCI index / Docker manifest list.
 * Never falls back to an arbitrary first entry (avoids selecting Windows on multi-arch images).
 */
function selectLinuxManifestDescriptor(manifests) {
  const linux = manifests.filter((m) => {
    const p = m.platform;
    if (!p) return false;
    if ((p.os || '').toLowerCase() !== 'linux') return false;
    return normalizeOCIArchitecture(p.architecture) === OCI_ARCH;
  });
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
  linux.sort((a, b) => {
    const d = variantPreference(b.platform) - variantPreference(a.platform);
    if (d !== 0) return d;
    return String(a.digest || '').localeCompare(String(b.digest || ''));
  });
  return linux[0];
}

/**
 * After SIGKILL, wait until the task is STOPPED or gone — exponential backoff (no flat sleep).
 */
async function waitUntilTaskStoppedOrGone(name, maxTotalMs) {
  const deadline = Date.now() + maxTotalMs;
  let sleepMs = 100;
  while (Date.now() < deadline) {
    const task = await getTaskState(name);
    if (!task) return;
    const st = normalizeTaskStatus(task.status);
    if (st === 'STOPPED') return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(sleepMs, remaining)));
    sleepMs = Math.min(sleepMs * 2, 2000);
  }
}

/** containerd-shim-runc-v2 `file://` stdio URI — appends stdout/stderr (see process/io.go). */
function taskLogStdioUri(logPath) {
  return pathToFileURL(logPath).href;
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

  await callUnary(getClient('transfer'), 'transfer', {
    source,
    destination,
    options: {},
  });

  onStep?.({ step: 'pulled', detail: `Image ${ref} pulled` });
  return ref;
}

/**
 * Read a blob from containerd's content store by digest.
 */
async function readContent(digest) {
  const chunks = await collectStream(
    callStream(getClient('content'), 'read', { digest }),
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
async function getImageConfig(imageRef) {
  const manifest = await resolveManifest(imageRef);
  if (!manifest?.config?.digest) return {};
  return JSON.parse((await readContent(manifest.config.digest)).toString('utf8'));
}

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
async function prepareSnapshot(name, imageConfig) {
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
async function getSnapshotMounts(name) {
  try {
    const res = await callUnary(getClient('snapshots'), 'mounts', {
      snapshotter: SNAPSHOTTER,
      key: name,
    });
    return snapshotMountsForTask(res.mounts || []);
  } catch {
    return null;
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
    if (err.code === 'CONTAINER_EXISTS') throw err;
    // NOT_FOUND is expected — continue
  }

  // Create container directory
  const containerDir = getContainerDir(name);
  const filesDir = getContainerFilesDir(name);
  await mkdir(filesDir, { recursive: true });

  // If the literal ref is already in containerd (e.g. from `ctr -n wisp image import`
  // or an exact match picked from the image library), skip normalization + pull and use
  // it verbatim. This is the only way to handle local-only refs like `myapp:v1` — the
  // normalize step would otherwise rewrite them to `docker.io/library/…` and the
  // registry pull would fail.
  let imageRef = null;
  try {
    await callUnary(getClient('images'), 'get', { name: spec.image });
    imageRef = spec.image;
    onStep?.({ step: 'using-local', detail: `Using local image ${imageRef}` });
  } catch {
    /* not local by literal name — fall through to normalized registry pull */
  }

  if (!imageRef) {
    imageRef = normalizeImageRef(spec.image);

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
      await rm(containerDir, { recursive: true, force: true });
      throw containerError('IMAGE_PULL_FAILED', `Failed to pull image "${imageRef}"`, err.message);
    }
  }

  // Get image config for defaults
  let imageConfig = {};
  try {
    imageConfig = await getImageConfig(imageRef);
  } catch (err) {
    if (err.code === 'IMAGE_PULL_FAILED') {
      await rm(containerDir, { recursive: true, force: true });
      throw err;
    }
    // Use empty config — user must provide command
  }

  const imgCfg = imageConfig.config || imageConfig || {};
  const exposedPorts = imgCfg.ExposedPorts ? Object.keys(imgCfg.ExposedPorts).sort() : [];

  // Build container.json (create accepts name + image only; network defaults here)
  let network = { type: 'bridge' };
  if (network.mac != null && String(network.mac).trim() !== '') {
    const n = normalizeContainerMac(network.mac);
    if (!n) throw containerError('INVALID_CONTAINER_MAC', 'Invalid MAC address format');
    network.mac = n;
  } else {
    network.mac = generateContainerMac();
  }
  try {
    const parent = await getDefaultContainerParentBridge();
    if (parent) network.interface = parent;
  } catch {
    /* no default bridge — omit interface (setupNetwork will reject on start) */
  }
  delete network.vlan;

  let config = {
    name,
    image: imageRef,
    command: null,
    exposedPorts,
    cpuLimit: null,
    memoryLimitMiB: null,
    restartPolicy: 'unless-stopped',
    autostart: false,
    localDns: true,
    env: {},
    mounts: [],
    network,
    createdAt: new Date().toISOString(),
  };
  const iconTrim = spec.iconId != null && spec.iconId !== '' ? String(spec.iconId).trim() : '';
  if (iconTrim) config.iconId = iconTrim;

  // App container: validate, store appConfig, generate derived env/mounts/files
  if (spec.app) {
    if (!isKnownApp(spec.app)) {
      await rm(containerDir, { recursive: true, force: true });
      throw containerError('UNKNOWN_APP_TYPE', `Unknown app type "${spec.app}"`);
    }
    const appEntry = getAppEntry(spec.app);
    const appModule = appEntry.module;
    const appConfig = spec.appConfig
      ? appModule.validateAppConfig(spec.appConfig, null)
      : appModule.getDefaultAppConfig({ containerName: name });
    config.app = spec.app;
    config.appConfig = appConfig;

    // Apps that bind privileged ports / setuid / write to root-owned image dirs declare
    // `requiresRoot: true` in the registry; honour it without making the user toggle General.
    if (appEntry.requiresRoot) {
      config.runAsRoot = true;
    }

    // Seed mDNS service entries from the registry so common protocols (e.g. _smb._tcp for
    // tiny-samba) advertise out of the box. Done at create only — after that the user owns
    // the services list via the Services section.
    if (Array.isArray(appEntry.defaultServices) && appEntry.defaultServices.length > 0) {
      config.services = appEntry.defaultServices.map((s) => ({
        port: s.port,
        type: s.type,
        txt: { ...(s.txt || {}) },
      }));
    }

    const derived = await appModule.generateDerivedConfig(appConfig);
    if (derived.appConfig) config.appConfig = derived.appConfig;
    if (derived.env) config.env = derived.env;
    if (derived.mounts) config.mounts = derived.mounts;

    // Write mount file contents after persisting config (filesDir already exists)
    if (derived.mountContents) {
      for (const [mountName, content] of Object.entries(derived.mountContents)) {
        await writeFile(join(filesDir, mountName), content, 'utf8');
      }
    }
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
  const storageMounts = await getRawMounts();
  const ociSpec = buildOCISpec(config, imageConfig, filesDir, { resolvConfPath, storageMounts });

  // Prepare snapshot (required before containerd Containers.Create)
  try {
    await prepareSnapshot(name, imageConfig);
  } catch (err) {
    const existing = await getSnapshotMounts(name);
    if (!existing) {
      await rm(containerDir, { recursive: true, force: true });
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
    if (err.code !== 'CONTAINER_EXISTS') {
      await rm(containerDir, { recursive: true, force: true });
      throw err;
    }
  }

  onStep?.({ step: 'done', name, imageDigest: resolvedDigest || null });
  return { name };
}

/**
 * Start an existing (stopped) container by creating a new task.
 * Called from containerManagerLifecycle when no task exists.
 */
export async function startExistingContainer(name) {
  const containerDir = getContainerDir(name);
  const filesDir = getContainerFilesDir(name);

  // Read container.json
  let config;
  try {
    const raw = await readFile(join(containerDir, 'container.json'), 'utf8');
    config = JSON.parse(raw);
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container config not found for "${name}"`);
  }

  config = await ensureContainerNetworkConfig(name, config);

  // Clear pending restart flag — the container is (re)starting now
  if (config.pendingRestart) delete config.pendingRestart;

  // Remove any stale task (STOPPED still exists until Delete; Create would fail
  // with "already exists"). cleanupTask also finalizes the prior log run if
  // one was still open, so the run picker shows it as ended rather than
  // perpetually "Running…".
  await cleanupTask(name);

  // Get image config. If the image was removed under us (e.g.
  // `ctr -n wisp image rm <ref>`), auto-pull it once and retry — the
  // container's image reference is canonical, so re-pulling restores
  // exactly what was there before. Anything else is treated as a transient
  // read failure and we continue with an empty imageConfig (existing
  // behavior — prepareSnapshot below will still throw if rootfs is missing).
  let imageConfig = {};
  try {
    imageConfig = await getImageConfig(config.image);
  } catch (err) {
    if (err.code === 'IMAGE_PULL_FAILED') throw err;
    if (err.code === 'CONTAINER_NOT_FOUND' || err.code === 'CONTAINER_IMAGE_NOT_FOUND') {
      containerState.logger?.info(
        { image: config.image, container: name },
        'Image missing on start; auto-pulling',
      );
      await pullImage(config.image);
      imageConfig = await getImageConfig(config.image);
    }
    /* other read failures fall through with empty imageConfig */
  }

  // Rootfs is ephemeral: on every start, discard the existing snapshot and re-prepare
  // from the current library image. State persists only through bind mounts.
  try {
    await callUnary(getClient('snapshots'), 'remove', { snapshotter: SNAPSHOTTER, key: name });
  } catch { /* no snapshot yet (first-ever start) — prepareSnapshot below creates it */ }

  const currentDigest = await getImageDigest(config.image);
  if (currentDigest && config.imageDigest !== currentDigest) {
    config.imageDigest = currentDigest;
    config.imagePulledAt = new Date().toISOString();
  }

  // Rebuild OCI spec
  const resolvConfPath = await resolveContainerResolvConf(config.network?.interface);
  const storageMounts = await getRawMounts();
  const ociSpec = buildOCISpec(config, imageConfig, filesDir, { resolvConfPath, storageMounts });

  // Update the container spec in containerd
  await callUnary(getClient('containers'), 'update', {
    container: {
      id: name,
      spec: packAny(OCI_SPEC_TYPE_URL, ociSpec),
    },
    updateMask: { paths: ['spec'] },
  });

  const mounts = await prepareSnapshot(name, imageConfig);

  await assertBindSourcesReady(name, config, filesDir, storageMounts);

  // Set up networking
  try {
    const lease = await setupNetwork(name, config.network);
    if (lease) {
      config = await mergeNetworkLeaseIntoConfig(name, config, lease);
      if (config.localDns) {
        await registerAddress(name, sanitizeHostname(name), config.network?.ip);
        await registerAllContainerServices(name, config);
      }
    }
  } catch (err) {
    containerState.logger?.warn(
      { err: err.message, raw: err.raw, container: name },
      'Network setup failed during container start',
    );
  }

  // Allocate a fresh log run (per-start file under runs/<runId>.log + sidecar).
  // The shim opens the path via file:// and appends stdout+stderr. Retention
  // keeps only the newest N runs, pruned inside createNewRun.
  const { logPath } = await createNewRun(name, { imageDigest: config.imageDigest || null });

  await writeContainerConfig(name, config);

  const logUri = taskLogStdioUri(logPath);

  await callUnary(getClient('tasks'), 'create', {
    containerId: name,
    rootfs: mounts,
    stdout: logUri,
    stderr: logUri,
  });
  await callUnary(getClient('tasks'), 'start', { containerId: name });
}

/**
 * Delete a container: stop task, remove snapshot, remove containerd definition, delete files.
 */
export async function deleteContainer(name, deleteFiles = true) {
  // Stop task if running
  try {
    const task = await callUnary(getClient('tasks'), 'get', { containerId: name });
    const st = normalizeTaskStatus(task.process?.status);
    if (st === 'RUNNING' || st === 'PAUSED') {
      await callUnary(getClient('tasks'), 'kill', { containerId: name, signal: 9, all: true });
      await waitUntilTaskStoppedOrGone(name, 15000);
    }
    await callUnary(getClient('tasks'), 'delete', { containerId: name });
  } catch {
    // No task
  }
  /* Deregister mDNS *after* the task is gone so we never have a window where
   * `<name>.local` resolves to nothing while the container is still serving;
   * the brief overlap where the name still resolves to a tearing-down
   * container is preferable to "name gone, container still answering". */
  await deregisterServicesForContainer(name);
  await deregisterAddress(name);

  // Tear down networking
  try {
    const containerDir = getContainerDir(name);
    const raw = await readFile(join(containerDir, 'container.json'), 'utf8');
    const config = JSON.parse(raw);
    await teardownNetwork(name, config.network);
  } catch { /* best effort */ }

  // Remove snapshot
  try {
    await callUnary(getClient('snapshots'), 'remove', { snapshotter: SNAPSHOTTER, key: name });
  } catch {
    // Snapshot may not exist
  }

  // Remove container from containerd
  try {
    await callUnary(getClient('containers'), 'delete', { id: name });
  } catch {
    // Container may not exist in containerd
  }

  containerState.containerStartTimes.delete(name);

  // Remove local files
  if (deleteFiles) {
    const containerDir = getContainerDir(name);
    await rm(containerDir, { recursive: true, force: true });
  }

  // The earlier containerd /containers/delete event already triggered a cache
  // refresh, but at that moment the container.json file was still on disk so
  // the cache picked it up. Refresh again now that rm has actually run.
  notifyContainerConfigWrite(name);
}
