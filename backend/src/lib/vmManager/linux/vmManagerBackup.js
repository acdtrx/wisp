/**
 * VM backup and restore: createBackup, listBackups, restoreBackup.
 * Disk images and cloud-init ISO are streamed gzip to destination (.gz); config files stay uncompressed.
 */
import { copyFile, mkdir, writeFile, readdir, readFile, access, constants, stat, rm, rename, realpath, chmod } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { join, dirname, basename } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { connectionState, resolveDomain, getDomainState, getDomainXML, vmError, generateMAC } from './vmManagerConnection.js';
import { parseVMFromXML, parseDomainRaw, buildXml } from './vmManagerXml.js';
import { getVMBasePath } from './vmManagerPaths.js';
import { VIR_DOMAIN_STATE_SHUTOFF, VIR_DOMAIN_STATE_SHUTDOWN } from './libvirtConstants.js';
import { copyNvram } from './vmManagerNvram.js';
import { assertVMNameAvailable, createOwnVMDir, removeOwnVMDir } from './vmManagerCreate.js';

const execFile = promisify(execFileCb);

// New layout: VM backups under <root>/vms/. Mirrors container backups under
// <root>/containers/. listBackups still walks the legacy <root>/<vmName>/
// layout so backups taken before this change remain visible and restorable.
const VMS_BACKUP_DIRNAME = 'vms';
const CONTAINERS_BACKUP_DIRNAME = 'containers';

function backupTimestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

async function copyWithProgress(srcPath, dstPath, onProgress) {
  try {
    await execFile('cp', ['--reflink=auto', srcPath, dstPath]);
  } catch {
    /* reflink copy unsupported — fall back to full copy */
    await copyFile(srcPath, dstPath);
  }
  if (typeof onProgress === 'function') onProgress();
}

/**
 * Stream source file through gzip to destination. Uses pipeline; reports progress if totalBytes and onProgress provided.
 */
async function streamWithGzip(sourcePath, destPath, { totalBytes, onProgress } = {}) {
  const readStream = createReadStream(sourcePath);
  const gzip = createGzip();
  const writeStream = createWriteStream(destPath);

  if (typeof onProgress === 'function' && totalBytes != null && totalBytes > 0) {
    let readBytes = 0;
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        readBytes += chunk.length;
        const pct = Math.min(100, Math.round((readBytes / totalBytes) * 100));
        onProgress(pct);
        callback(null, chunk);
      },
    });
    await pipeline(readStream, progress, gzip, writeStream);
  } else {
    await pipeline(readStream, gzip, writeStream);
  }
}

/**
 * Copy from backup path to dest: try plain file first, then .gz with gunzip stream.
 */
async function copyOrGunzip(backupPath, logicalName, destPath, onProgress) {
  const plain = join(backupPath, logicalName);
  const gz = plain + '.gz';
  try {
    await access(plain, constants.R_OK);
    await copyWithProgress(plain, destPath, onProgress);
    return;
  } catch {
    /* plain file not found — try .gz below */
  }
  try {
    await access(gz, constants.R_OK);
  } catch (err) {
    throw vmError('BACKUP_INVALID', `Backup missing disk or image file: ${logicalName}`, err.message);
  }
  try {
    await pipeline(
      createReadStream(gz),
      createGunzip(),
      createWriteStream(destPath)
    );
  } catch (err) {
    throw vmError('BACKUP_INVALID', `Backup file ${logicalName}.gz could not be decompressed`, err.message);
  }
  if (typeof onProgress === 'function') onProgress();
}

/** True when at least one of the paths exists and is readable. */
async function anyReadable(paths) {
  for (const p of paths) {
    try {
      await access(p, constants.R_OK);
      return true;
    } catch {
      /* not present — try the next candidate */
    }
  }
  return false;
}

/** Strip trailing slashes for stable prefix matching (root stays "/"). */
function normalizeBasePath(p) {
  if (p == null || typeof p !== 'string') return p;
  const s = p.replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

/** If path equals oldBase or lies under oldBase/, rewrite to newBase. */
function rewriteVmBasePrefix(pathStr, oldBase, newBase) {
  if (typeof pathStr !== 'string' || !pathStr) return pathStr;
  const o = normalizeBasePath(oldBase);
  const n = normalizeBasePath(newBase);
  if (!o || !n || o === n) return pathStr;
  if (pathStr === o) return n;
  if (pathStr.startsWith(o + '/')) return n + pathStr.slice(o.length);
  return pathStr;
}

/**
 * Rewrite all domain XML paths under the backed-up VM directory to the new VM directory.
 * @param {object} dom - parsed domain object (mutated)
 * @param {string} oldBase - absolute path prefix at backup time
 * @param {string} newBase - absolute path prefix for the restored VM
 */
function applyVmBasePrefixToDomain(dom, oldBase, newBase) {
  if (!dom || !oldBase || !newBase) return;
  const o = normalizeBasePath(oldBase);
  const n = normalizeBasePath(newBase);
  if (!o || !n || o === n) return;

  const disks = dom.devices?.disk;
  const diskList = Array.isArray(disks) ? disks : disks ? [disks] : [];
  for (const d of diskList) {
    const src = d.source;
    if (!src || typeof src !== 'object') continue;
    for (const key of ['@_file', '@_dev', '@_volume']) {
      if (src[key] != null && typeof src[key] === 'string') {
        src[key] = rewriteVmBasePrefix(src[key], o, n);
      }
    }
  }

  if (dom.os?.nvram != null) {
    const nv = dom.os.nvram;
    if (typeof nv === 'string') {
      dom.os.nvram = rewriteVmBasePrefix(nv, o, n);
    } else if (typeof nv === 'object' && nv['#text'] != null) {
      nv['#text'] = rewriteVmBasePrefix(String(nv['#text']), o, n);
    }
  }

  const loader = dom.os?.loader;
  if (loader && typeof loader === 'object' && loader['#text'] != null) {
    const t = String(loader['#text']);
    const rewritten = rewriteVmBasePrefix(t, o, n);
    if (rewritten !== t) loader['#text'] = rewritten;
  }
}

/**
 * @param {object | null} manifest
 * @param {object | null} config - parseVMFromXML result
 * @param {Array<{ oldPath: string }>} diskMapping
 * @returns {string | null}
 */
function resolveOldVmBasePath(manifest, config, diskMapping) {
  if (manifest?.vmBasePath && typeof manifest.vmBasePath === 'string') {
    return normalizeBasePath(manifest.vmBasePath);
  }
  if (manifest?.vmName && typeof manifest.vmName === 'string') {
    return normalizeBasePath(getVMBasePath(manifest.vmName));
  }
  if (config?.name && typeof config.name === 'string') {
    return normalizeBasePath(getVMBasePath(config.name));
  }
  if (diskMapping.length > 0 && diskMapping[0].oldPath) {
    return normalizeBasePath(dirname(diskMapping[0].oldPath));
  }
  return null;
}

/**
 * Create a point-in-time backup of a VM to destinationPath. VM must be stopped.
 * @param {string} vmName
 * @param {string} destinationPath - Absolute path (local or pre-mounted SMB)
 * @param {{ onProgress?: (event: { step: string, percent?: number, currentFile?: string }) => void,
 *           origin?: 'manual' | 'scheduled' }} options
 * @returns { Promise<{ path: string, timestamp: string }> }
 */
export async function createBackup(vmName, destinationPath, { onProgress, origin = 'manual' } = {}) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  if (!destinationPath || typeof destinationPath !== 'string' || !destinationPath.startsWith('/')) {
    throw vmError('BACKUP_DEST_NOT_FOUND', 'Invalid backup destination path');
  }
  try {
    await access(destinationPath, constants.R_OK | constants.W_OK);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw vmError('BACKUP_DEST_NOT_FOUND', `Backup destination not found: ${destinationPath}`, err.message);
    }
    throw vmError('BACKUP_DEST_NOT_WRITABLE', `Backup destination not writable: ${destinationPath}`, err.message);
  }

  const path = await resolveDomain(vmName);
  const state = await getDomainState(path);
  if (state.code !== VIR_DOMAIN_STATE_SHUTOFF && state.code !== VIR_DOMAIN_STATE_SHUTDOWN) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${vmName}" must be stopped to create a backup`);
  }

  const xml = await getDomainXML(path);
  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', `Failed to parse XML for VM "${vmName}"`);

  let nvramPath = null;
  const parsed = parseDomainRaw(xml);
  const nvramNode = parsed?.domain?.os?.nvram;
  if (nvramNode && typeof nvramNode === 'object' && nvramNode['#text']) {
    nvramPath = nvramNode['#text'].trim();
  } else if (nvramNode && typeof nvramNode === 'string') {
    nvramPath = nvramNode.trim();
  }
  if (!nvramPath) {
    const os = parsed?.domain?.os;
    const loaderNode = os?.loader;
    const pflashLoader = typeof loaderNode === 'object' && loaderNode['@_type'] === 'pflash';
    const nvramInXml = os?.nvram != null;
    if (pflashLoader || nvramInXml) {
      nvramPath = join(getVMBasePath(vmName), 'VARS.fd');
    }
  }

  const timestamp = backupTimestamp();
  // Layout: <dest>/vms/<vmName>/<timestamp>/. Symmetric with container backups
  // (<dest>/containers/<name>/<timestamp>/). Older Wisp versions used
  // <dest>/<vmName>/<timestamp>/ — listBackups still walks that path so legacy
  // backups remain restorable/deletable, but new backups always land under vms/.
  const vmBackupsDir = join(destinationPath, VMS_BACKUP_DIRNAME, vmName);
  await mkdir(vmBackupsDir, { recursive: true });
  const backupDir = join(vmBackupsDir, timestamp);
  // Non-recursive so this run provably owns the directory: the failure
  // cleanup below removes it, and must never remove a backup another run wrote.
  try {
    await mkdir(backupDir);
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw vmError('BACKUP_EXISTS', `A backup of "${vmName}" named ${timestamp} already exists at this destination — retry in a moment`);
    }
    throw err;
  }

  try {
    return await writeBackupContents({ vmName, xml, config, nvramPath, backupDir, timestamp, origin, onProgress });
  } catch (err) {
    // A partial directory has no manifest.json, so listBackups already skips
    // it; removing it also frees the space. If removal fails too (destination
    // gone mid-backup), the original error is what the caller needs.
    await rm(backupDir, { recursive: true, force: true }).catch((rmErr) => {
      connectionState.logger?.warn?.({ err: rmErr.message, backupDir }, '[vmManager] Failed to remove partial backup directory');
    });
    throw err;
  }
}

/**
 * Write every backup file into the (empty, caller-owned) backupDir;
 * manifest.json goes last and is what marks the backup complete.
 * Completion is the resolved promise — no `done` progress event.
 */
async function writeBackupContents({ vmName, xml, config, nvramPath, backupDir, timestamp, origin, onProgress }) {
  const emit = (step, data = {}) => {
    if (typeof onProgress === 'function') onProgress({ step, ...data });
  };

  const disks = (config.disks || []).filter((d) => d.device === 'disk' && d.source);
  const totalItems = disks.length + (nvramPath ? 1 : 0) + 3; // +3 for domain.xml, cloud-init.iso and cloud-init.json
  let done = 0;

  emit('domain', { percent: 0, currentFile: 'Saving domain.xml' });
  await writeFile(join(backupDir, 'domain.xml'), xml);
  done += 1;
  emit('domain', { percent: Math.round((done / totalItems) * 100), currentFile: 'Saving domain.xml' });

  for (const disk of disks) {
    const fileName = basename(disk.source);
    const basePercent = (done / totalItems) * 100;
    const rangePercent = (1 / totalItems) * 100;
    emit('disk', { percent: Math.round(basePercent), currentFile: `Copying ${fileName}` });
    const destGz = join(backupDir, fileName + '.gz');
    let totalBytes;
    try {
      const st = await stat(disk.source);
      totalBytes = st.size;
    } catch {
      /* stat failed — progress bar works without total */
      totalBytes = null;
    }
    await streamWithGzip(disk.source, destGz, {
      totalBytes,
      onProgress: (pct) => {
        const overall = Math.round(basePercent + (pct / 100) * rangePercent);
        emit('disk', { percent: overall, currentFile: `Copying ${fileName}` });
      },
    });
    done += 1;
    emit('disk', { percent: Math.round((done / totalItems) * 100), currentFile: fileName });
  }

  const vmBase = getVMBasePath(vmName);
  if (nvramPath) {
    emit('nvram', { percent: Math.round((done / totalItems) * 100), currentFile: 'Copying NVRAM' });
    // allowMissing skips a legitimately-absent NVRAM (XML declared, disk empty); other failures surface.
    await copyNvram(nvramPath, join(backupDir, 'VARS.fd'), { allowMissing: true });
    done += 1;
    emit('nvram', { percent: Math.round((done / totalItems) * 100), currentFile: 'NVRAM' });
  }

  const cloudInitIso = join(vmBase, 'cloud-init.iso');
  const cloudInitJson = join(vmBase, 'cloud-init.json');
  emit('cloudinit', { percent: Math.round((done / totalItems) * 100), currentFile: 'Copying cloud-init' });
  try {
    await access(cloudInitIso, constants.R_OK);
    let isoTotalBytes;
    try {
      isoTotalBytes = (await stat(cloudInitIso)).size;
    } catch {
      isoTotalBytes = null; /* stat optional for progress */
    }
    await streamWithGzip(cloudInitIso, join(backupDir, 'cloud-init.iso.gz'), {
      totalBytes: isoTotalBytes,
      onProgress: (pct) => emit('cloudinit', { percent: Math.round((done / totalItems) * 100 + (pct / 100) * (1 / totalItems) * 100), currentFile: 'Copying cloud-init.iso' }),
    });
  } catch {
    /* optional — cloud-init ISO not present for this VM */
  }
  done += 1;
  try {
    await access(cloudInitJson, constants.R_OK);
    await copyWithProgress(cloudInitJson, join(backupDir, 'cloud-init.json'), () => {});
  } catch {
    /* optional — cloud-init JSON not present for this VM */
  }
  done += 1;
  emit('cloudinit', { percent: Math.round((done / totalItems) * 100), currentFile: 'Cloud-init' });

  emit('manifest', { percent: Math.round((done / totalItems) * 100), currentFile: 'Finalizing backup' });
  let totalBytes = 0;
  try {
    const entries = await readdir(backupDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        const s = await stat(join(backupDir, e.name));
        totalBytes += s.size;
      }
    }
  } catch {
    /* manifest size is best-effort if directory walk fails */
  }

  let vmBasePathForManifest = vmBase;
  try {
    vmBasePathForManifest = await realpath(vmBase);
  } catch {
    /* VM directory not resolvable — use configured path string */
  }

  const manifest = {
    vmName,
    timestamp,
    origin: origin === 'scheduled' ? 'scheduled' : 'manual',
    vmBasePath: vmBasePathForManifest,
    disks: disks.map((d) => ({ slot: d.slot, file: basename(d.source) })),
    sizeBytes: totalBytes,
  };
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  emit('manifest', { percent: 100, currentFile: 'Backup complete' });
  return { path: backupDir, timestamp };
}

/**
 * List backups from one or more destination roots. Optionally filter by vmName.
 * Walks both layouts:
 *   - new: <root>/vms/<vmName>/<timestamp>/
 *   - legacy: <root>/<vmName>/<timestamp>/   (skipping `vms/` and `containers/`)
 * Dedupes by (destinationId, vmName, timestamp), preferring the new layout.
 *
 * @param {Array<{ id: string, path: string, label: string }>} destinations - Caller-supplied roots; `id` is opaque (the route layer maps it to/from the API's `destinationId`).
 * @param {string} [vmName] - If set, only return backups for this VM
 * @returns { Promise<Array<{ vmName: string, timestamp: string, destinationId: string, destinationLabel: string, path: string, sizeBytes?: number }>> } - `path` is internal; routes drop it before serializing.
 */
export async function listBackups(destinations, vmName = null) {
  const results = [];
  const seen = new Set();
  const list = Array.isArray(destinations) ? destinations : [];

  /** Read one VM's directory under either layout, push valid backup entries. */
  async function scanVmDir({ vmDirPath, name, destId, label }) {
    let timestamps;
    try {
      timestamps = await readdir(vmDirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const tsEnt of timestamps) {
      if (!tsEnt.isDirectory()) continue;
      const dedupeKey = `${destId}\0${name}\0${tsEnt.name}`;
      if (seen.has(dedupeKey)) continue;
      const backupPath = join(vmDirPath, tsEnt.name);
      let manifest;
      try {
        manifest = await readBackupManifest(backupPath);
      } catch {
        /* no readable manifest.json — incomplete (or foreign) dir, not a backup */
        continue;
      }
      const sizeBytes = manifest.sizeBytes;
      /* Backups predating the origin field list as manual. */
      const origin = manifest.origin === 'scheduled' ? 'scheduled' : 'manual';
      seen.add(dedupeKey);
      results.push({
        vmName: name,
        timestamp: tsEnt.name,
        destinationId: destId,
        destinationLabel: label,
        path: backupPath,
        sizeBytes,
        origin,
      });
    }
  }

  for (const dest of list) {
    const basePath = dest && typeof dest.path === 'string' ? dest.path : null;
    const label = dest && typeof dest.label === 'string' ? dest.label : 'Backup';
    const destId = dest && typeof dest.id === 'string' ? dest.id : null;
    if (!basePath || !basePath.startsWith('/') || !destId) continue;

    // 1. New layout: <root>/vms/<name>/<ts>/. Scanned first so dedupe prefers it.
    const vmsRoot = join(basePath, VMS_BACKUP_DIRNAME);
    let newDirs;
    try {
      newDirs = await readdir(vmsRoot, { withFileTypes: true });
    } catch {
      newDirs = null; /* vms/ subdir absent — fine, nothing here yet */
    }
    if (newDirs) {
      for (const dirent of newDirs) {
        if (!dirent.isDirectory()) continue;
        const name = dirent.name;
        if (vmName != null && vmName !== '' && name !== vmName) continue;
        await scanVmDir({ vmDirPath: join(vmsRoot, name), name, destId, label });
      }
    }

    // 2. Legacy layout: <root>/<name>/<ts>/, skipping vms/ and containers/.
    let legacyDirs;
    try {
      legacyDirs = await readdir(basePath, { withFileTypes: true });
    } catch {
      continue; /* destination unreadable */
    }
    for (const dirent of legacyDirs) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      if (name === VMS_BACKUP_DIRNAME || name === CONTAINERS_BACKUP_DIRNAME) continue;
      if (vmName != null && vmName !== '' && name !== vmName) continue;
      await scanVmDir({ vmDirPath: join(basePath, name), name, destId, label });
    }
  }
  return results.sort((a, b) => {
    const d = (a.vmName || '').localeCompare(b.vmName || '');
    return d !== 0 ? d : (b.timestamp || '').localeCompare(a.timestamp || '');
  });
}

/**
 * Resolve `(rootPath, vmName, timestamp)` to the absolute backup directory,
 * checking the new layout (`<root>/vms/<name>/<ts>/`) first and falling back
 * to the legacy layout (`<root>/<name>/<ts>/`). Throws BACKUP_NOT_FOUND if
 * neither exists. Routes use this before calling restoreBackup / deleteBackup
 * so the layout choice stays inside vmManager.
 *
 * @param {string} rootPath - Configured backup destination root
 * @param {string} vmName
 * @param {string} timestamp
 * @returns {Promise<string>} absolute backup directory
 */
export async function resolveVmBackupDir(rootPath, vmName, timestamp) {
  const candidates = [
    join(rootPath, VMS_BACKUP_DIRNAME, vmName, timestamp),
    join(rootPath, vmName, timestamp),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      /* try next candidate */
    }
  }
  throw vmError('BACKUP_NOT_FOUND', `Backup not found for ${vmName} @ ${timestamp}`);
}

/**
 * Delete a backup directory. Path must be under one of the allowed roots.
 * @param {string} backupPath - Full path to the backup directory (e.g. .../vmName/timestamp)
 * @param {string[]} allowedRoots - Allowed destination roots (same as used for listing)
 */
export async function deleteBackup(backupPath, allowedRoots) {
  if (!backupPath || typeof backupPath !== 'string' || !backupPath.startsWith('/')) {
    throw vmError('BACKUP_INVALID', 'Invalid backup path');
  }
  const roots = Array.isArray(allowedRoots) ? allowedRoots.filter((r) => r && typeof r === 'string' && r.startsWith('/')) : [];
  const normalized = backupPath.replace(/\/+$/, '') || backupPath;
  let resolvedBackup;
  try {
    resolvedBackup = await realpath(normalized);
  } catch (err) {
    if (err.code === 'ENOENT') throw vmError('BACKUP_NOT_FOUND', 'Backup not found');
    throw vmError('BACKUP_INVALID', 'Cannot resolve backup path', err.message);
  }
  const resolvedRoots = await Promise.all(
    roots.map((r) =>
      realpath((r || '').replace(/\/+$/, '') || r).catch(() => {
        /* root path missing or not resolvable — exclude from prefix check */
        return null;
      })
    )
  );
  const underRoot = resolvedRoots.some(
    (resolvedRoot) => resolvedRoot && (resolvedBackup === resolvedRoot || resolvedBackup.startsWith(resolvedRoot + '/'))
  );
  if (!underRoot) {
    throw vmError('BACKUP_INVALID', 'Backup path is not under a configured destination');
  }
  // A single backup is always below a destination's sub-roots; never remove a
  // destination root itself or its vms/ / containers/ namespace (independent
  // of how well the caller validated the name and timestamp segments).
  const isDestinationRoot = resolvedRoots.some((resolvedRoot) => resolvedRoot && (
    resolvedBackup === resolvedRoot
    || resolvedBackup === join(resolvedRoot, VMS_BACKUP_DIRNAME)
    || resolvedBackup === join(resolvedRoot, CONTAINERS_BACKUP_DIRNAME)
  ));
  if (isDestinationRoot) {
    throw vmError('BACKUP_INVALID', 'Refusing to delete a backup destination root');
  }
  try {
    await access(resolvedBackup, constants.R_OK | constants.W_OK);
  } catch (err) {
    if (err.code === 'ENOENT') throw vmError('BACKUP_NOT_FOUND', 'Backup not found');
    throw vmError('BACKUP_INVALID', 'Cannot access backup path', err.message);
  }
  await rm(resolvedBackup, { recursive: true, force: true });
}

/**
 * Parse a backup's manifest.json. createBackup writes it last, so its presence
 * is what makes a directory a complete backup — listing and restore both
 * require it.
 */
async function readBackupManifest(backupPath) {
  const manifest = JSON.parse(await readFile(join(backupPath, 'manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest.json is not an object');
  return manifest;
}

/** Read a backup's manifest.json and domain.xml (both required). */
async function readBackupDomain(backupPath) {
  let manifest;
  try {
    manifest = await readBackupManifest(backupPath);
  } catch (err) {
    throw vmError('BACKUP_INVALID', `Backup is incomplete (no valid manifest.json): ${backupPath}`, err.message);
  }
  let xml;
  try {
    xml = await readFile(join(backupPath, 'domain.xml'), 'utf8');
  } catch (err) {
    throw vmError('BACKUP_INVALID', `Backup missing domain.xml: ${backupPath}`, err.message);
  }
  return { xml, manifest };
}

/**
 * Copy a backup's payload (disks, NVRAM, cloud-init) into destBase.
 * @returns {Promise<Array<{ oldPath: string, newPath: string }>>} disk mapping for XML path rewrites
 */
async function copyBackupPayload(backupPath, config, destBase, { onProgress } = {}) {
  const disks = (config.disks || []).filter((d) => d.device === 'disk' && d.source);
  const totalItems = disks.length + 2; // +1 NVRAM, +1 cloud-init pair
  let done = 0;
  const emit = (step, currentFile) => {
    if (typeof onProgress === 'function') {
      onProgress({ step, percent: Math.round((done / totalItems) * 100), currentFile });
    }
  };

  const diskMapping = [];
  for (const disk of disks) {
    const logicalName = basename(disk.source);
    emit('disk', `Restoring ${logicalName}`);
    const newDiskPath = join(destBase, logicalName);
    await copyOrGunzip(backupPath, logicalName, newDiskPath);
    diskMapping.push({ oldPath: disk.source, newPath: newDiskPath });
    done += 1;
    emit('disk', logicalName);
  }

  emit('nvram', 'Restoring NVRAM');
  // allowMissing skips BIOS-only and older silent-skip backups; permission/IO failures surface.
  await copyNvram(join(backupPath, 'VARS.fd'), join(destBase, 'VARS.fd'), { allowMissing: true });
  done += 1;

  // Both cloud-init files carry the password hash and land in the group-readable
  // per-VM dir, so they get the same 0600 the live write paths apply. The gunzip
  // path creates the ISO with the default mode, and a JSON copied from an older
  // backup keeps whatever mode it had — chmod after placing either one.
  emit('cloudinit', 'Restoring cloud-init');
  // Both are optional (absent when the VM had no cloud-init), but once present
  // a failed copy fails the restore — a half-written ISO must never be placed.
  const cloudInitIsoDest = join(destBase, 'cloud-init.iso');
  if (await anyReadable([join(backupPath, 'cloud-init.iso'), join(backupPath, 'cloud-init.iso.gz')])) {
    await copyOrGunzip(backupPath, 'cloud-init.iso', cloudInitIsoDest);
    await chmod(cloudInitIsoDest, 0o600);
  }
  const cloudInitJsonSrc = join(backupPath, 'cloud-init.json');
  const cloudInitJsonDest = join(destBase, 'cloud-init.json');
  if (await anyReadable([cloudInitJsonSrc])) {
    await copyWithProgress(cloudInitJsonSrc, cloudInitJsonDest, () => {});
    await chmod(cloudInitJsonDest, 0o600);
  }
  done += 1;
  emit('cloudinit', 'Cloud-init');

  return diskMapping;
}

/**
 * Rewrite every path in the parsed domain that referenced the backed-up VM
 * directory (prefix rewrite via manifest.vmBasePath) plus any disk that lived
 * outside it (e.g. image library), which the per-disk mapping covers.
 */
function rewriteRestoredDomainPaths(dom, { manifest, config, diskMapping, newBase }) {
  const oldBase = resolveOldVmBasePath(manifest, config, diskMapping);
  if (oldBase) {
    applyVmBasePrefixToDomain(dom, oldBase, newBase);
  }

  const diskList = Array.isArray(dom.devices?.disk) ? dom.devices.disk : dom.devices?.disk ? [dom.devices.disk] : [];
  for (const d of diskList) {
    const src = d.source;
    if (!src || typeof src !== 'object') continue;
    for (const { oldPath, newPath } of diskMapping) {
      if (src['@_file'] === oldPath) src['@_file'] = newPath;
      if (src['@_dev'] === oldPath) src['@_dev'] = newPath;
      if (src['@_volume'] === oldPath) src['@_volume'] = newPath;
    }
  }
}

/**
 * Restore a backup as a new VM.
 * @param {string} backupPath - Full path to the backup directory (e.g. .../vmName/timestamp)
 * @param {string} newVmName
 * @returns { Promise<{ name: string }> }
 */
export async function restoreBackup(backupPath, newVmName) {
  await assertVMNameAvailable(newVmName);

  const { xml, manifest } = await readBackupDomain(backupPath);
  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', 'Failed to parse backup domain.xml');

  const newBase = normalizeBasePath(await createOwnVMDir(newVmName));
  try {
    await restorePayloadAndDefine(backupPath, newVmName, newBase, { xml, manifest, config });
  } catch (err) {
    // newBase was created exclusively above — removing it undoes the restore.
    await removeOwnVMDir(newBase);
    throw err;
  }

  return { name: newVmName };
}

/** restoreBackup body after the new VM directory exists; any throw leaves cleanup to the caller. */
async function restorePayloadAndDefine(backupPath, newVmName, newBase, { xml, manifest, config }) {
  const diskMapping = await copyBackupPayload(backupPath, config, newBase);

  const parsed = parseDomainRaw(xml);
  const dom = parsed.domain;
  if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse backup domain XML');

  dom.name = newVmName;
  dom.uuid = randomUUID();

  rewriteRestoredDomainPaths(dom, { manifest, config, diskMapping, newBase });

  const ifaces = dom.devices?.interface;
  if (Array.isArray(ifaces)) {
    for (const iface of ifaces) {
      if (iface.mac) iface.mac['@_address'] = generateMAC();
    }
  } else if (ifaces && ifaces.mac) {
    ifaces.mac['@_address'] = generateMAC();
  }

  let newXml;
  try {
    newXml = buildXml(parsed);
  } catch (err) {
    throw vmError('CONFIG_ERROR', 'Failed to build restored domain XML', err.message);
  }

  try {
    await connectionState.connectIface.DomainDefineXML(newXml);
  } catch (err) {
    throw vmError('BACKUP_RESTORE_FAILED', `Failed to define restored VM "${newVmName}"`, err.message);
  }
}

/**
 * Restore a backup over the live VM it was taken from ("restore in place").
 *
 * The target VM is identified by the backup itself (manifest.vmName, falling
 * back to the domain XML name), must exist, and must be stopped. Disks,
 * NVRAM, and cloud-init files are copied back into the VM's current
 * directory, and the backed-up domain XML is re-defined over the live
 * definition. Identity semantics:
 *   - name and UUID stay those of the live domain (the UUID only differs
 *     when a same-named VM was deleted and recreated since the backup —
 *     adopting the live UUID keeps DomainDefineXML from rejecting the
 *     name/uuid mismatch);
 *   - MAC addresses, hardware config, and disk contents revert to the
 *     backup's state;
 *   - disks that lived outside the VM directory at backup time (e.g. image
 *     library) are restored into the VM directory and remapped, same as
 *     restore-as-new — the outside file is never overwritten.
 * Files in the VM directory that the backup does not reference (e.g. a disk
 * added after the backup was taken) are left in place, orphaned.
 *
 * The payload is decompressed into a staging dir inside the VM directory and
 * renamed over the live files only after every file staged, so a corrupt or
 * truncated backup leaves the live disks byte-identical. The domain is
 * redefined last.
 *
 * @param {string} backupPath - Full path to the backup directory
 * @param {{ onProgress?: (event: { step: string, percent?: number, currentFile?: string }) => void }} options
 * @returns { Promise<{ name: string }> }
 */
export async function restoreBackupInPlace(backupPath, { onProgress } = {}) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  const { xml, manifest } = await readBackupDomain(backupPath);
  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', 'Failed to parse backup domain.xml');

  const name = typeof manifest?.vmName === 'string' && manifest.vmName ? manifest.vmName : config.name;
  if (!name) throw vmError('BACKUP_INVALID', 'Backup does not identify its VM');

  const path = await resolveDomain(name);
  const state = await getDomainState(path);
  if (state.code !== VIR_DOMAIN_STATE_SHUTOFF && state.code !== VIR_DOMAIN_STATE_SHUTDOWN) {
    throw vmError('VM_MUST_BE_OFFLINE', `VM "${name}" must be stopped to restore in place`);
  }

  let currentUuid = null;
  try {
    const current = parseDomainRaw(await getDomainXML(path));
    currentUuid = typeof current?.domain?.uuid === 'string' ? current.domain.uuid : null;
  } catch {
    /* current XML unreadable — keep the backup's UUID (same-VM case works) */
  }

  const emit = (step, data = {}) => {
    if (typeof onProgress === 'function') onProgress({ step, ...data });
  };

  const newBase = normalizeBasePath(getVMBasePath(name));
  await mkdir(newBase, { recursive: true });

  // Stage the whole payload in a sibling dir on the same filesystem, so a
  // failed or truncated decompress never touches a live disk; the live files
  // are replaced by rename only once every file staged successfully.
  const stagingDir = join(newBase, `.restore-${randomUUID()}`);
  await mkdir(stagingDir);

  let newXml;
  try {
    /* Payload copy owns 0–90% of the progress range; swap + define take the rest. */
    const stagedMapping = await copyBackupPayload(backupPath, config, stagingDir, {
      onProgress: (ev) => emit(ev.step, { percent: Math.round((ev.percent ?? 0) * 0.9), currentFile: ev.currentFile }),
    });
    const diskMapping = stagedMapping.map(({ oldPath, newPath }) => ({ oldPath, newPath: join(newBase, basename(newPath)) }));

    const parsed = parseDomainRaw(xml);
    const dom = parsed.domain;
    if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse backup domain XML');

    dom.name = name;
    if (currentUuid) dom.uuid = currentUuid;

    rewriteRestoredDomainPaths(dom, { manifest, config, diskMapping, newBase });

    try {
      newXml = buildXml(parsed);
    } catch (err) {
      throw vmError('CONFIG_ERROR', 'Failed to build restored domain XML', err.message);
    }

    emit('swap', { percent: 90, currentFile: 'Replacing disks' });
    for (const entry of await readdir(stagingDir)) {
      await rename(join(stagingDir, entry), join(newBase, entry));
    }
  } finally {
    // Empty after a successful swap. On any failure before the swap this
    // discards the staged files and the live ones were never touched.
    await rm(stagingDir, { recursive: true, force: true }).catch((rmErr) => {
      connectionState.logger?.warn?.({ err: rmErr.message, stagingDir }, '[vmManager] Failed to remove restore staging directory');
    });
  }

  emit('define', { percent: 95, currentFile: 'Applying domain configuration' });
  try {
    await connectionState.connectIface.DomainDefineXML(newXml);
  } catch (err) {
    throw vmError('BACKUP_RESTORE_FAILED', `Failed to redefine VM "${name}" from backup (disks were restored)`, err.message);
  }

  return { name };
}
