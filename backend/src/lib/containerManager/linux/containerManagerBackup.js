/**
 * Container backup and restore.
 *
 * A backup is a single `data.tar.gz` of the container directory plus a
 * sibling `manifest.json` (uncompressed for inspection):
 *
 *   <dest>/containers/<name>/<timestamp>/
 *     ├── manifest.json
 *     └── data.tar.gz   (tar of container.json + files/ + runs/)
 *
 * The container's writable rootfs is ephemeral (re-prepared from the image
 * on every start — see `startExistingContainer`), so there's no analog to
 * a VM's qcow2 disk to capture. State that survives stop/start lives only
 * in Local mounts (`files/<mountName>/`), which travel with the dir.
 *
 * Running containers are backed up without stopping: the task is paused
 * (cgroup freezer) for the duration of the archive and resumed in a finally
 * block, giving a point-in-time capture. `manifest.origin` records whether
 * a backup was taken manually or by the scheduler (retention only ever
 * prunes scheduled backups).
 *
 * Restore creates an independent copy under a new name with a fresh MAC.
 * The image referenced in `container.json` is re-pulled if not already in
 * containerd's content store. Storage-sourced mounts are preserved
 * verbatim — `assertBindSourcesReady` surfaces any missing storage at
 * start time with a clear 503 (`CONTAINER_MOUNT_SOURCE_NOT_MOUNTED`),
 * which is the right place to address the host-specific config drift.
 */
import { spawn } from 'node:child_process';
import {
  access, constants, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { containerError, containerState, getClient, callUnary, packAny } from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir, getContainersPath } from './containerPaths.js';
import {
  getTaskState, normalizeTaskStatus, cleanupTask, pauseContainer, resumeContainer,
} from './containerManagerLifecycle.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { generateContainerMac, resolveContainerResolvConf } from './containerManagerNetwork.js';
import { validateContainerName } from './containerValidation.js';
import { pullImage } from './containerManagerCreate.js';
import { buildOCISpec } from './containerManagerSpec.js';
import { resolveDeviceSpecs } from './containerDeviceNode.js';
import { resolveMount } from './containerPaths.js';
import { getImageDigest } from './containerManagerImages.js';

const RUNTIME_NAME = 'io.containerd.runc.v2';
const SNAPSHOTTER = 'overlayfs';
const OCI_SPEC_TYPE_URL = 'types.containerd.io/opencontainers/runtime-spec/1/Spec';

/** Subdirectory under each backup root that holds container backups. Kept
 * separate from VM backups so the two can never collide on name + timestamp. */
const CONTAINERS_BACKUP_DIRNAME = 'containers';

function backupTimestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

async function dirTotalBytes(dirPath) {
  let total = 0;
  async function walk(p) {
    let entries;
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const s = await stat(full);
          total += s.size;
        } catch { /* ignore unreadable file */ }
      }
    }
  }
  await walk(dirPath);
  return total;
}

/**
 * tar -cf - <baseName> -C <parent> | gzip > <destPath>, with progress.
 * Tracks bytes flowing OUT of tar (uncompressed) so percent matches
 * the pre-walked totalBytes denominator.
 */
async function tarGzipDir(parent, baseName, destPath, totalBytes, onProgress) {
  const tar = spawn('tar', ['-cf', '-', '-C', parent, baseName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  tar.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  const counter = new Transform({
    transform(chunk, _enc, cb) {
      counter.bytes = (counter.bytes || 0) + chunk.length;
      if (typeof onProgress === 'function' && totalBytes > 0) {
        const pct = Math.min(100, Math.round((counter.bytes / totalBytes) * 100));
        onProgress(pct);
      }
      cb(null, chunk);
    },
  });

  const gzip = createGzip();
  const out = createWriteStream(destPath);

  const tarExitPromise = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code ?? signal}: ${stderrBuf.trim() || 'unknown'}`));
    });
  });

  await Promise.all([
    pipeline(tar.stdout, counter, gzip, out),
    tarExitPromise,
  ]);
}

/** Untar a gzipped archive into `destDir`. */
async function untarGzipTo(archivePath, destDir) {
  const tar = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  tar.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  await new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code ?? signal}: ${stderrBuf.trim() || 'unknown'}`));
    });
  });
}

async function ensureWritableDir(p) {
  try {
    await access(p, constants.R_OK | constants.W_OK);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw containerError('BACKUP_DEST_NOT_FOUND', `Backup destination not found: ${p}`, err.message);
    }
    throw containerError('BACKUP_DEST_NOT_WRITABLE', `Backup destination not writable: ${p}`, err.message);
  }
}

/**
 * Prepare the container's task for a consistent archive and report whether
 * this call paused it. A RUNNING task is frozen (cgroup freezer) so nothing
 * writes to the container dir while tar reads it — a point-in-time capture
 * equivalent to a power cut, which apps recover from by design. A STOPPED
 * task is deleted as before; CREATED / no-task dirs are already quiescent.
 * An already-PAUSED task is left as found (we didn't pause it, we won't
 * resume it). Transient states are rejected — retry when they settle.
 */
async function freezeForBackup(name) {
  const task = await getTaskState(name);
  if (!task) return false;
  const st = normalizeTaskStatus(task.status);
  if (st === 'STOPPED') {
    await cleanupTask(name);
    return false;
  }
  if (st === 'CREATED' || st === 'PAUSED') return false;
  if (st === 'RUNNING') {
    await pauseContainer(name);
    return true;
  }
  throw containerError(
    'CONTAINER_TASK_TRANSIENT',
    `Container "${name}" is in a transient state (${st.toLowerCase()}) — retry in a moment`,
  );
}

/**
 * Create a backup of a container at `<destinationPath>/containers/<name>/<timestamp>/`.
 * A running container is paused for the duration of the archive and resumed
 * automatically; stopped containers are archived cold.
 *
 * @param {string} name
 * @param {string} destinationPath - existing backup root (already validated by route)
 * @param {{ onProgress?: (e: { step: string, percent?: number, currentFile?: string }) => void,
 *           origin?: 'manual' | 'scheduled' }} [options]
 * @returns {Promise<{ path: string, timestamp: string }>}
 */
export async function createContainerBackup(name, destinationPath, { onProgress, origin = 'manual' } = {}) {
  if (!destinationPath || !destinationPath.startsWith('/')) {
    throw containerError('BACKUP_DEST_NOT_FOUND', 'Invalid backup destination path');
  }
  await ensureWritableDir(destinationPath);

  const config = await readContainerConfig(name);

  const containerDir = getContainerDir(name);
  const containersRoot = getContainersPath();

  const timestamp = backupTimestamp();
  const backupDir = join(destinationPath, CONTAINERS_BACKUP_DIRNAME, name, timestamp);
  await mkdir(backupDir, { recursive: true });

  const emit = (step, data = {}) => {
    if (typeof onProgress === 'function') onProgress({ step, ...data });
  };

  /* Freeze as late as possible — destination validation and dir creation
   * above run while the container is still live, keeping the paused window
   * to just measure + tar. */
  let totalBytes = 0;
  const archivePath = join(backupDir, 'data.tar.gz');
  try {
    emit('pausing', { percent: 0, currentFile: 'Pausing container…' });
    const wePaused = await freezeForBackup(name);
    try {
      emit('measuring', { percent: 0, currentFile: 'Measuring contents…' });
      totalBytes = await dirTotalBytes(containerDir);

      emit('archiving', { percent: 0, currentFile: `Archiving ${name}` });
      await tarGzipDir(
        containersRoot,
        name,
        archivePath,
        totalBytes,
        (pct) => emit('archiving', { percent: pct, currentFile: `Archiving ${name}` }),
      );
    } finally {
      if (wePaused) {
        emit('resuming', { currentFile: 'Resuming container…' });
        try {
          await resumeContainer(name);
        } catch (err) {
          /* The task may have been killed/deleted while frozen; the archive is
           * still valid and a tar failure must not be masked — log and move on. */
          containerState.logger?.warn?.(
            { err, container: name },
            'Failed to resume container after backup',
          );
        }
      }
    }
  } catch (err) {
    /* Don't leave an empty/partial backup dir behind (it would be skipped by
     * listings but still consume disk). */
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  let archiveBytes = 0;
  try { archiveBytes = (await stat(archivePath)).size; } catch { /* ignore */ }

  const manifest = {
    type: 'container',
    schemaVersion: 1,
    name,
    timestamp,
    origin: origin === 'scheduled' ? 'scheduled' : 'manual',
    image: config.image || null,
    imageDigest: config.imageDigest || null,
    sourceBytes: totalBytes,
    archiveBytes,
    sizeBytes: archiveBytes,
  };
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  emit('done', { percent: 100, currentFile: 'Backup complete', path: backupDir });
  return { path: backupDir, timestamp };
}

/**
 * List container backups under each destination's `containers/` subdirectory.
 *
 * @param {Array<{ id: string, path: string, label: string }>} destinations - Caller-supplied roots; `id` is opaque (the route layer maps it to/from the API's `destinationId`).
 * @param {string} [containerName] - optional filter
 * @returns {Promise<Array<{ name: string, timestamp: string, destinationId: string, destinationLabel: string, path: string, sizeBytes?: number, image?: string | null }>>} - `path` is internal; routes drop it before serializing.
 */
export async function listContainerBackups(destinations, containerName = null) {
  const results = [];
  for (const dest of (Array.isArray(destinations) ? destinations : [])) {
    const basePath = dest && typeof dest.path === 'string' ? dest.path : null;
    const label = dest && typeof dest.label === 'string' ? dest.label : 'Backup';
    const destId = dest && typeof dest.id === 'string' ? dest.id : null;
    if (!basePath || !basePath.startsWith('/') || !destId) continue;

    const containersRoot = join(basePath, CONTAINERS_BACKUP_DIRNAME);
    let nameDirs;
    try {
      nameDirs = await readdir(containersRoot, { withFileTypes: true });
    } catch {
      /* No containers/ subdir at this destination — nothing to list. */
      continue;
    }

    for (const nd of nameDirs) {
      if (!nd.isDirectory()) continue;
      const cName = nd.name;
      if (containerName != null && containerName !== '' && cName !== containerName) continue;

      const cPath = join(containersRoot, cName);
      let timestamps;
      try {
        timestamps = await readdir(cPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ts of timestamps) {
        if (!ts.isDirectory()) continue;
        const backupPath = join(cPath, ts.name);
        const manifestPath = join(backupPath, 'manifest.json');
        let manifest = null;
        try {
          const raw = await readFile(manifestPath, 'utf8');
          manifest = JSON.parse(raw);
        } catch {
          /* Not a valid container backup dir — skip silently. */
          continue;
        }
        if (manifest?.type !== 'container') continue;

        results.push({
          name: cName,
          timestamp: ts.name,
          destinationId: destId,
          destinationLabel: label,
          path: backupPath,
          sizeBytes: typeof manifest.sizeBytes === 'number' ? manifest.sizeBytes : undefined,
          image: manifest.image ?? null,
          /* Backups predating the origin field are treated as manual so
           * retention pruning never touches them. */
          origin: manifest.origin === 'scheduled' ? 'scheduled' : 'manual',
        });
      }
    }
  }
  return results.sort((a, b) => {
    const d = a.name.localeCompare(b.name);
    return d !== 0 ? d : (b.timestamp || '').localeCompare(a.timestamp || '');
  });
}

/**
 * Delete a container backup directory. Path must resolve under one of `allowedRoots`.
 */
export async function deleteContainerBackup(backupPath, allowedRoots) {
  if (!backupPath || !backupPath.startsWith('/')) {
    throw containerError('BACKUP_INVALID', 'Invalid backup path');
  }
  const roots = Array.isArray(allowedRoots) ? allowedRoots.filter((r) => r && r.startsWith('/')) : [];
  const normalized = backupPath.replace(/\/+$/, '') || backupPath;

  let resolvedBackup;
  try {
    resolvedBackup = await realpath(normalized);
  } catch (err) {
    if (err.code === 'ENOENT') throw containerError('BACKUP_NOT_FOUND', 'Backup not found');
    throw containerError('BACKUP_INVALID', 'Cannot resolve backup path', err.message);
  }
  const resolvedRoots = await Promise.all(roots.map((r) =>
    realpath(r.replace(/\/+$/, '') || r).catch(() => null)));

  const underRoot = resolvedRoots.some((r) => r && (resolvedBackup === r || resolvedBackup.startsWith(`${r}/`)));
  if (!underRoot) {
    throw containerError('BACKUP_INVALID', 'Backup path is not under a configured destination');
  }
  await rm(resolvedBackup, { recursive: true, force: true });
}

/** Read and type-check a container backup's manifest; verify the archive is readable. */
async function readContainerBackupManifest(backupPath) {
  const archivePath = join(backupPath, 'data.tar.gz');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'));
  } catch (err) {
    throw containerError('BACKUP_INVALID', `Backup missing manifest.json: ${backupPath}`, err.message);
  }
  if (manifest?.type !== 'container') {
    throw containerError('BACKUP_INVALID', `Not a container backup: ${backupPath}`);
  }
  try { await access(archivePath, constants.R_OK); } catch (err) {
    throw containerError('BACKUP_INVALID', `Backup missing data.tar.gz: ${backupPath}`, err.message);
  }
  return { manifest, archivePath };
}

/**
 * Extract the backup archive into a staging directory under the containers
 * root and verify it holds exactly one top-level directory (the source
 * container name). Caller owns removing stagingDir when done.
 */
async function extractArchiveToStaging(archivePath) {
  const containersRoot = getContainersPath();
  await mkdir(containersRoot, { recursive: true });

  const stagingName = `.restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagingDir = join(containersRoot, stagingName);
  await mkdir(stagingDir, { recursive: true });

  try {
    await untarGzipTo(archivePath, stagingDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_RESTORE_FAILED', `Failed to extract backup: ${err.message}`);
  }

  let extractedTop;
  try {
    const entries = await readdir(stagingDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length !== 1) {
      throw new Error(`expected exactly one top-level directory in archive, got ${dirs.length}`);
    }
    extractedTop = dirs[0].name;
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_INVALID', `Unexpected archive layout: ${err.message}`);
  }
  return { stagingDir, extractedTop };
}

/**
 * Ensure the image referenced by `config` is present in containerd (pull if
 * missing — throws IMAGE_PULL_FAILED) and best-effort refresh the persisted
 * digest to whatever containerd now holds.
 */
async function ensureImageAndDigest(name, config) {
  const imageRef = config.image;
  if (!imageRef) return;
  let imagePresent = false;
  try {
    await callUnary(getClient('images'), 'get', { name: imageRef });
    imagePresent = true;
  } catch { /* not local — pull below */ }
  if (!imagePresent) {
    try {
      await pullImage(imageRef);
    } catch (err) {
      throw containerError('IMAGE_PULL_FAILED', `Failed to pull image "${imageRef}" during restore`, err.message);
    }
  }
  /* Refresh imageDigest to whatever's now in containerd (may differ from
   * the manifest's digest if the registry has moved on). */
  try {
    const digest = await getImageDigest(imageRef);
    if (digest) {
      config.imageDigest = digest;
      config.imagePulledAt = new Date().toISOString();
      await writeContainerConfig(name, config);
    }
  } catch { /* best-effort digest refresh */ }
}

/**
 * Create the containerd container record for a restored container. The OCI
 * spec here is a placeholder — it is rebuilt on every start
 * (`startExistingContainer`) — but `Containers.Create` requires a spec
 * field, so emit a real one for cleanliness.
 */
async function createContainerdRecord(name, config) {
  const filesDir = getContainerFilesDir(name);
  const resolvConfPath = await resolveContainerResolvConf(config.network?.interface);
  const { deviceSpecs, renderGid } = await resolveDeviceSpecs(config);
  const ociSpec = buildOCISpec(config, {}, filesDir, {
    resolvConfPath, resolveMount, deviceSpecs, renderGid,
  });

  await callUnary(getClient('containers'), 'create', {
    container: {
      id: name,
      image: config.image || '',
      runtime: { name: RUNTIME_NAME },
      spec: packAny(OCI_SPEC_TYPE_URL, ociSpec),
      snapshotter: SNAPSHOTTER,
      snapshotKey: name,
      labels: { 'wisp.managed': 'true' },
    },
  });
}

/**
 * Restore a container backup as a brand-new container with `newName`.
 * Container directory is recreated from the archive; container.json is
 * rewritten with the new name and a fresh MAC; image is pulled if
 * missing; containerd container record is created (snapshot is prepared
 * lazily on first start, like a normal stopped container).
 */
export async function restoreContainerBackup(backupPath, newName) {
  validateContainerName(newName);
  const newNameTrim = newName.trim();

  /* Pre-flight: target name must be free both on disk and in containerd. */
  try {
    await access(getContainerDir(newNameTrim));
    throw containerError('CONTAINER_EXISTS', `Container directory for "${newNameTrim}" already exists`);
  } catch (err) {
    if (err.code === 'CONTAINER_EXISTS') throw err;
    /* ENOENT — good */
  }
  try {
    await callUnary(getClient('containers'), 'get', { id: newNameTrim });
    throw containerError('CONTAINER_EXISTS', `Container "${newNameTrim}" already exists in containerd`);
  } catch (err) {
    if (err.code === 'CONTAINER_EXISTS') throw err;
    /* NOT_FOUND — good */
  }

  const { manifest, archivePath } = await readContainerBackupManifest(backupPath);

  /* Extract the tar into the containers root. The archive's top-level
   * entry is the *original* container name (we tarred `<name>` from
   * containersRoot). After extraction we rename the top-level directory
   * to `newName`. */
  const { stagingDir, extractedTop } = await extractArchiveToStaging(archivePath);

  const finalDir = getContainerDir(newNameTrim);
  try {
    await rename(join(stagingDir, extractedTop), finalDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_RESTORE_FAILED', `Failed to place restored container directory: ${err.message}`);
  }
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});

  /* Rewrite container.json with the new name and a fresh MAC. */
  let config;
  try {
    config = JSON.parse(await readFile(join(finalDir, 'container.json'), 'utf8'));
  } catch (err) {
    /* Roll back the directory placement so the user can retry cleanly. */
    await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_INVALID', `Backup container.json missing or invalid: ${err.message}`);
  }
  config.name = newNameTrim;
  if (!config.network || typeof config.network !== 'object') config.network = { type: 'bridge' };
  config.network.mac = generateContainerMac();
  /* Drop any persisted DHCP lease — it belonged to the old MAC. */
  if (config.network.ip) delete config.network.ip;

  await writeContainerConfig(newNameTrim, config);

  try {
    await ensureImageAndDigest(newNameTrim, config);
  } catch (err) {
    await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  try {
    await createContainerdRecord(newNameTrim, config);
  } catch (err) {
    /* Container record creation failed — clean up the directory so the
     * user can retry with a different name. */
    await rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw containerError(
      'BACKUP_RESTORE_FAILED',
      `Failed to register restored container "${newNameTrim}" in containerd`,
      err.raw || err.message,
    );
  }

  return { name: newNameTrim, sourceName: manifest.name, image: config.image || null };
}

/**
 * Restore a container backup over the live container it was taken from
 * ("restore in place"). The target is identified by the backup's manifest
 * name, must still exist on disk, and must be stopped — the container
 * directory is swapped under whatever would be reading it otherwise.
 *
 * Identity is preserved: same name, same MAC (and therefore the same DHCP
 * lease), same containerd record (kept if present, recreated if missing —
 * the rootfs snapshot is re-prepared from the image on next start either
 * way). The archived container.json replaces the live one wholesale, so
 * config edits made after the backup was taken revert with it.
 */
export async function restoreContainerBackupInPlace(backupPath, { onProgress } = {}) {
  const emit = (step, data = {}) => {
    if (typeof onProgress === 'function') onProgress({ step, ...data });
  };

  const { manifest, archivePath } = await readContainerBackupManifest(backupPath);
  const name = manifest.name;
  validateContainerName(name);

  const finalDir = getContainerDir(name);
  try {
    await access(finalDir);
  } catch (err) {
    throw containerError(
      'CONTAINER_NOT_FOUND',
      `Container "${name}" no longer exists — restore the backup as a new container instead`,
      err.message,
    );
  }

  /* Must be stopped: the directory is about to be swapped out from under
   * any running rootfs mounts, and a paused task would resume onto files
   * that no longer exist. */
  const task = await getTaskState(name);
  if (task) {
    const st = normalizeTaskStatus(task.status);
    if (st === 'STOPPED') {
      await cleanupTask(name);
    } else if (st !== 'CREATED') {
      throw containerError('CONTAINER_MUST_BE_STOPPED', `Container "${name}" must be stopped to restore in place`);
    }
  }

  emit('extracting', { percent: 10, currentFile: 'Extracting archive' });
  const { stagingDir, extractedTop } = await extractArchiveToStaging(archivePath);
  if (extractedTop !== name) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_INVALID', `Archive top-level directory "${extractedTop}" does not match container "${name}"`);
  }

  /* Validate the staged container.json before touching the live directory. */
  let config;
  try {
    config = JSON.parse(await readFile(join(stagingDir, extractedTop, 'container.json'), 'utf8'));
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_INVALID', `Backup container.json missing or invalid: ${err.message}`);
  }
  config.name = name;

  /* Swap: move the live dir aside, move the staged dir in, then drop the
   * old dir. If the second rename fails the old dir is moved back. */
  emit('swapping', { percent: 60, currentFile: 'Replacing container directory' });
  const containersRoot = getContainersPath();
  const oldDir = join(containersRoot, `.replaced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await rename(finalDir, oldDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_RESTORE_FAILED', `Failed to move current container directory aside: ${err.message}`);
  }
  try {
    await rename(join(stagingDir, extractedTop), finalDir);
  } catch (err) {
    await rename(oldDir, finalDir).catch(() => {
      /* rollback failed too — oldDir still holds the pre-restore data for manual recovery */
    });
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw containerError('BACKUP_RESTORE_FAILED', `Failed to place restored container directory: ${err.message}`);
  }
  await rm(oldDir, { recursive: true, force: true }).catch(() => {});
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});

  /* Write-through so config normalization and the config-write notification
   * fire (list caches, UI refresh). */
  await writeContainerConfig(name, config);

  emit('registering', { percent: 85, currentFile: 'Ensuring image and container record' });
  /* Restored data stays in place even if these fail — the error surfaces
   * and a later start / retry can finish the job. */
  await ensureImageAndDigest(name, config);
  let recordExists = true;
  try {
    await callUnary(getClient('containers'), 'get', { id: name });
  } catch { recordExists = false; /* NOT_FOUND — recreate below */ }
  if (!recordExists) {
    try {
      await createContainerdRecord(name, config);
    } catch (err) {
      throw containerError(
        'BACKUP_RESTORE_FAILED',
        `Failed to register restored container "${name}" in containerd`,
        err.raw || err.message,
      );
    }
  }

  emit('done', { percent: 100, currentFile: 'Restore complete' });
  return { name, image: config.image || null };
}
