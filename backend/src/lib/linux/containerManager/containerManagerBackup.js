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
 * Restore creates an independent copy under a new name with a fresh MAC.
 * The image referenced in `container.json` is re-pulled if not already in
 * containerd's content store. Storage-sourced mounts are preserved
 * verbatim — `assertBindSourcesReady` surfaces any missing storage at
 * start time with a clear 503 (`CONTAINER_MOUNT_SOURCE_NOT_MOUNTED`),
 * which is the right place to address the host-specific config drift.
 */
import { spawn } from 'node:child_process';
import {
  access, constants, mkdir, readFile, readdir, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { containerError, getClient, callUnary, packAny } from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir, getContainersPath } from './containerPaths.js';
import { getTaskState, normalizeTaskStatus, cleanupTask } from './containerManagerLifecycle.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { generateContainerMac, resolveContainerResolvConf } from './containerManagerNetwork.js';
import { validateContainerName } from '../../validation.js';
import { pullImage } from './containerManagerCreate.js';
import { buildOCISpec } from './containerManagerSpec.js';
import { resolveDeviceSpecs } from './containerDeviceNode.js';
import { getRawMounts } from '../../settings.js';
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

async function ensureContainerStopped(name) {
  const task = await getTaskState(name);
  if (!task) return;
  const st = normalizeTaskStatus(task.status);
  if (st === 'STOPPED') {
    await cleanupTask(name);
    return;
  }
  throw containerError(
    'CONTAINER_MUST_BE_STOPPED',
    `Container "${name}" must be stopped to create a backup (current state: ${st.toLowerCase()})`,
  );
}

/**
 * Create a backup of a stopped container at `<destinationPath>/containers/<name>/<timestamp>/`.
 *
 * @param {string} name
 * @param {string} destinationPath - existing backup root (already validated by route)
 * @param {{ onProgress?: (e: { step: string, percent?: number, currentFile?: string }) => void }} [options]
 * @returns {Promise<{ path: string, timestamp: string }>}
 */
export async function createContainerBackup(name, destinationPath, { onProgress } = {}) {
  if (!destinationPath || !destinationPath.startsWith('/')) {
    throw containerError('BACKUP_DEST_NOT_FOUND', 'Invalid backup destination path');
  }
  await ensureWritableDir(destinationPath);

  const config = await readContainerConfig(name);
  await ensureContainerStopped(name);

  const containerDir = getContainerDir(name);
  const containersRoot = getContainersPath();

  const timestamp = backupTimestamp();
  const backupDir = join(destinationPath, CONTAINERS_BACKUP_DIRNAME, name, timestamp);
  await mkdir(backupDir, { recursive: true });

  const emit = (step, data = {}) => {
    if (typeof onProgress === 'function') onProgress({ step, ...data });
  };

  emit('measuring', { percent: 0, currentFile: 'Measuring contents…' });
  const totalBytes = await dirTotalBytes(containerDir);

  const archivePath = join(backupDir, 'data.tar.gz');
  emit('archiving', { percent: 0, currentFile: `Archiving ${name}` });

  await tarGzipDir(
    containersRoot,
    name,
    archivePath,
    totalBytes,
    (pct) => emit('archiving', { percent: pct, currentFile: `Archiving ${name}` }),
  );

  let archiveBytes = 0;
  try { archiveBytes = (await stat(archivePath)).size; } catch { /* ignore */ }

  const manifest = {
    type: 'container',
    schemaVersion: 1,
    name,
    timestamp,
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
 * @param {Array<{ path: string, label: string }>} destinations
 * @param {string} [containerName] - optional filter
 * @returns {Promise<Array<{ name: string, timestamp: string, path: string, sizeBytes?: number, destinationLabel: string, image?: string | null }>>}
 */
export async function listContainerBackups(destinations, containerName = null) {
  const results = [];
  for (const dest of (Array.isArray(destinations) ? destinations : [])) {
    const basePath = dest && typeof dest.path === 'string' ? dest.path : null;
    const label = dest && typeof dest.label === 'string' ? dest.label : 'Backup';
    if (!basePath || !basePath.startsWith('/')) continue;

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
          path: backupPath,
          sizeBytes: typeof manifest.sizeBytes === 'number' ? manifest.sizeBytes : undefined,
          destinationLabel: label,
          image: manifest.image ?? null,
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

  /* Read manifest (presence already verified by listContainerBackups path) and archive. */
  const manifestPath = join(backupPath, 'manifest.json');
  const archivePath = join(backupPath, 'data.tar.gz');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw containerError('BACKUP_INVALID', `Backup missing manifest.json: ${backupPath}`, err.message);
  }
  if (manifest?.type !== 'container') {
    throw containerError('BACKUP_INVALID', `Not a container backup: ${backupPath}`);
  }
  try { await access(archivePath, constants.R_OK); } catch (err) {
    throw containerError('BACKUP_INVALID', `Backup missing data.tar.gz: ${backupPath}`, err.message);
  }

  /* Extract the tar into the containers root. The archive's top-level
   * entry is the *original* container name (we tarred `<name>` from
   * containersRoot). After extraction we rename the top-level directory
   * to `newName`. */
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

  /* The archive contains exactly one top-level directory — the source name. */
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

  /* Move the extracted dir up to its final path under the new name. */
  const finalDir = getContainerDir(newNameTrim);
  const { rename } = await import('node:fs/promises');
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

  /* Ensure the image is present in containerd. If not, pull it using the
   * canonical reference recorded in container.json. */
  const imageRef = config.image;
  if (imageRef) {
    let imagePresent = false;
    try {
      await callUnary(getClient('images'), 'get', { name: imageRef });
      imagePresent = true;
    } catch { /* not local — pull below */ }
    if (!imagePresent) {
      try {
        await pullImage(imageRef);
      } catch (err) {
        await rm(finalDir, { recursive: true, force: true }).catch(() => {});
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
        await writeContainerConfig(newNameTrim, config);
      }
    } catch { /* best-effort digest refresh */ }
  }

  /* Build a placeholder OCI spec and create the containerd container.
   * The spec is rebuilt on every start (`startExistingContainer`) so its
   * content here is non-load-bearing — but `Containers.Create` requires
   * a spec field, so emit a real one for cleanliness. */
  let imageConfig = {};
  try {
    /* getImageConfig is internal to containerManagerCreate; reuse its
     * effect by re-pulling metadata via the same code path. We don't
     * have an exported helper, so fall back to an empty image config —
     * buildOCISpec tolerates it for an unstarted container. */
  } catch { /* ignore */ }
  const filesDir = getContainerFilesDir(newNameTrim);
  const resolvConfPath = await resolveContainerResolvConf(config.network?.interface);
  const storageMounts = await getRawMounts();
  const { deviceSpecs, renderGid } = await resolveDeviceSpecs(config);
  const ociSpec = buildOCISpec(config, imageConfig, filesDir, {
    resolvConfPath, storageMounts, deviceSpecs, renderGid,
  });

  try {
    await callUnary(getClient('containers'), 'create', {
      container: {
        id: newNameTrim,
        image: imageRef || '',
        runtime: { name: RUNTIME_NAME },
        spec: packAny(OCI_SPEC_TYPE_URL, ociSpec),
        snapshotter: SNAPSHOTTER,
        snapshotKey: newNameTrim,
        labels: { 'wisp.managed': 'true' },
      },
    });
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

  return { name: newNameTrim, sourceName: manifest.name, image: imageRef };
}
