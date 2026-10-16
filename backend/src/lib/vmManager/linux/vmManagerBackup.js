/**
 * VM backup and restore: createBackup, listBackups, restoreBackup.
 * Disk images are streamed gzip to destination (.gz); config files stay uncompressed.
 * The cloud-init seed ISO is derived data and is not backed up: the caller
 * rebuilds it from the restored cloud-init.json (restore's populateVMDir hook).
 * A disk on a backing chain (an overlay on a shared base image, or a snapshot
 * overlay made outside Wisp, e.g. by `virsh`) is first flattened into one
 * standalone qcow2, so every backup is self-contained.
 */
import { copyFile, mkdir, writeFile, readdir, readFile, access, constants, stat, rm, realpath, chmod } from 'node:fs/promises';
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
import { isOfflineState } from './libvirtConstants.js';
import { copyNvram } from './vmManagerNvram.js';
import { assertVMNameAvailable, createOwnVMDir, removeOwnVMDir } from './vmManagerCreate.js';
import { getBackingChain, copyAndConvert } from '../../storage/index.js';

const execFile = promisify(execFileCb);

// Layout: VM backups under <root>/vms/<vmName>/<timestamp>/, beside container
// backups under <root>/containers/<name>/<timestamp>/.
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
 * Stream source file through gzip to destination. Uses pipeline; reports progress if totalBytes and onProgress provided —
 * once per integer percent change (≤ 101 calls), not per chunk.
 */
async function streamWithGzip(sourcePath, destPath, { totalBytes, onProgress } = {}) {
  const readStream = createReadStream(sourcePath);
  const gzip = createGzip();
  const writeStream = createWriteStream(destPath);

  if (typeof onProgress === 'function' && totalBytes != null && totalBytes > 0) {
    let readBytes = 0;
    let lastPct = -1;
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        readBytes += chunk.length;
        const pct = Math.min(100, Math.round((readBytes / totalBytes) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
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
  if (!isOfflineState(state.code)) {
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
  // Layout: <dest>/vms/<vmName>/<timestamp>/ (see VMS_BACKUP_DIRNAME).
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
 * What each disk slot backs up as. A disk whose image has a backing chain is
 * flattened (the full chain merged into one standalone qcow2) and saved under
 * the chain base's file name — the slot's own disk, e.g. `disk0.qcow2` rather
 * than a snapshot's `disk0.<snapshot>` overlay. Every other disk is
 * copied as-is under its own name.
 * @returns {Promise<Array<{ slot: string, source: string, format: string, flatten: boolean, fileName: string, basePath: string }>>}
 */
async function planDiskBackups(disks) {
  const plans = [];
  for (const disk of disks) {
    // The domain's <driver type> is the image format libvirt opens it as (no
    // driver type means raw to libvirt too); never let qemu-img probe it.
    const format = disk.driverType || 'raw';
    const chain = await getBackingChain(disk.source, { format });
    const flatten = chain.length > 1;
    const basePath = flatten ? chain[chain.length - 1].filename : disk.source;
    plans.push({ slot: disk.slot, source: disk.source, format, flatten, fileName: basename(basePath), basePath });
  }
  // Each disk lands at <backupDir>/<fileName>.gz; two slots resolving to one
  // name (two overlays on one base image) would overwrite each other.
  const seen = new Set();
  for (const p of plans) {
    if (seen.has(p.fileName)) {
      throw vmError('CONFIG_ERROR', `Two disks would be backed up as the same file "${p.fileName}" — the backup can't hold both`);
    }
    seen.add(p.fileName);
  }
  return plans;
}

/**
 * The domain XML as it must be restored when some disks were flattened: each
 * such disk points at its standalone file (the chain base's path, so restore's
 * VM-directory path rewrite applies as for any disk) as a qcow2 file, with no
 * `<backingStore>` — the backed-up image has none.
 */
function domainXmlWithFlattenedDisks(xml, flattenedPlans) {
  const parsed = parseDomainRaw(xml);
  const bySlot = new Map(flattenedPlans.map((p) => [p.slot, p]));
  for (const d of parsed?.domain?.devices?.disk || []) {
    if ((d['@_device'] || 'disk') !== 'disk') continue;
    const plan = bySlot.get(d.target?.['@_dev']);
    if (!plan) continue;
    const source = d.source && typeof d.source === 'object' ? d.source : {};
    delete source['@_dev'];
    delete source['@_volume'];
    delete source['@_pool'];
    source['@_file'] = plan.basePath;
    d.source = source;
    d['@_type'] = 'file';
    d.driver = { ...(d.driver && typeof d.driver === 'object' ? d.driver : { '@_name': 'qemu' }), '@_type': 'qcow2' };
    delete d.backingStore;
  }
  try {
    return buildXml(parsed);
  } catch (err) {
    throw vmError('CONFIG_ERROR', 'Failed to build the backup domain XML', err.message);
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
  const diskPlans = await planDiskBackups(disks);
  const totalItems = disks.length + (nvramPath ? 1 : 0) + 2; // +2 for domain.xml and cloud-init.json
  let done = 0;

  emit('domain', { percent: 0, currentFile: 'Saving domain.xml' });
  // A flattened disk is restored as its standalone file, so the saved XML
  // names that file instead of the overlay (restore reads disk names from it).
  const flattened = diskPlans.filter((p) => p.flatten);
  const backupXml = flattened.length > 0 ? domainXmlWithFlattenedDisks(xml, flattened) : xml;
  await writeFile(join(backupDir, 'domain.xml'), backupXml);
  done += 1;
  emit('domain', { percent: Math.round((done / totalItems) * 100), currentFile: 'Saving domain.xml' });

  for (const plan of diskPlans) {
    const { fileName } = plan;
    const basePercent = (done / totalItems) * 100;
    const rangePercent = (1 / totalItems) * 100;
    // Once per integer change of the job's percent, whatever the source's tick rate.
    let lastOverall = -1;
    const report = (subPercent, currentFile) => {
      const overall = Math.round(basePercent + (subPercent / 100) * rangePercent);
      if (overall === lastOverall) return;
      lastOverall = overall;
      emit('disk', { percent: overall, currentFile });
    };
    const destGz = join(backupDir, fileName + '.gz');

    if (plan.flatten) {
      // qemu-img can't write qcow2 to a pipe: flatten into a scratch file inside
      // this run's backupDir (removed below; createBackup's failure cleanup
      // removes it with the directory), then gzip that. Flatten owns the first
      // half of this disk's progress range, compression the second.
      const flatPath = join(backupDir, `${fileName}.flatten`);
      report(0, `Flattening ${fileName}`);
      await copyAndConvert(plan.source, flatPath, (pct) => report(pct / 2, `Flattening ${fileName}`), { srcFormat: plan.format });
      await streamWithGzip(flatPath, destGz, {
        totalBytes: (await stat(flatPath)).size,
        onProgress: (pct) => report(50 + pct / 2, `Copying ${fileName}`),
      });
      await rm(flatPath);
    } else {
      report(0, `Copying ${fileName}`);
      let totalBytes;
      try {
        const st = await stat(plan.source);
        totalBytes = st.size;
      } catch {
        /* stat failed — progress bar works without total */
        totalBytes = null;
      }
      await streamWithGzip(plan.source, destGz, {
        totalBytes,
        onProgress: (pct) => report(pct, `Copying ${fileName}`),
      });
    }
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

  // cloud-init.json only: the seed ISO is rebuilt from it on restore. (The ISO
  // also can't be read reliably — libvirt chowns the read-only CD-ROM image to
  // its qemu user on VM start and never restores read-only images on stop, and
  // the ISO is 0600.) Absent means the VM never had cloud-init; any other
  // failure fails the backup. Both copy paths keep the source's 0600 mode.
  emit('cloudinit', { percent: Math.round((done / totalItems) * 100), currentFile: 'Copying cloud-init' });
  try {
    await copyWithProgress(join(vmBase, 'cloud-init.json'), join(backupDir, 'cloud-init.json'), () => {});
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
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
    disks: diskPlans.map((p) => ({ slot: p.slot, file: p.fileName })),
    sizeBytes: totalBytes,
  };
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  emit('manifest', { percent: 100, currentFile: 'Backup complete' });
  return { path: backupDir, timestamp };
}

/**
 * List backups from one or more destination roots (`<root>/vms/<vmName>/<timestamp>/`).
 * Optionally filter by vmName.
 *
 * @param {Array<{ id: string, path: string, label: string }>} destinations - Caller-supplied roots; `id` is opaque (the route layer maps it to/from the API's `destinationId`).
 * @param {string} [vmName] - If set, only return backups for this VM
 * @returns { Promise<Array<{ vmName: string, timestamp: string, destinationId: string, destinationLabel: string, path: string, sizeBytes?: number }>> } - `path` is internal; routes drop it before serializing.
 */
export async function listBackups(destinations, vmName = null) {
  const results = [];
  const list = Array.isArray(destinations) ? destinations : [];

  /** Read one VM's backup directory, push valid backup entries. */
  async function scanVmDir({ vmDirPath, name, destId, label }) {
    let timestamps;
    try {
      timestamps = await readdir(vmDirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const tsEnt of timestamps) {
      if (!tsEnt.isDirectory()) continue;
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

    const vmsRoot = join(basePath, VMS_BACKUP_DIRNAME);
    let vmDirs;
    try {
      vmDirs = await readdir(vmsRoot, { withFileTypes: true });
    } catch {
      continue; /* vms/ subdir absent (nothing backed up yet) or destination unreadable */
    }
    for (const dirent of vmDirs) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      if (vmName != null && vmName !== '' && name !== vmName) continue;
      await scanVmDir({ vmDirPath: join(vmsRoot, name), name, destId, label });
    }
  }
  return results.sort((a, b) => {
    const d = (a.vmName || '').localeCompare(b.vmName || '');
    return d !== 0 ? d : (b.timestamp || '').localeCompare(a.timestamp || '');
  });
}

/**
 * Resolve `(rootPath, vmName, timestamp)` to the absolute backup directory
 * `<root>/vms/<name>/<ts>/`. Throws BACKUP_NOT_FOUND if it does not exist.
 * Routes use this before calling restoreBackup / deleteBackup so the layout
 * stays inside vmManager.
 *
 * @param {string} rootPath - Configured backup destination root
 * @param {string} vmName
 * @param {string} timestamp
 * @returns {Promise<string>} absolute backup directory
 */
export async function resolveVmBackupDir(rootPath, vmName, timestamp) {
  const dir = join(rootPath, VMS_BACKUP_DIRNAME, vmName, timestamp);
  try {
    await access(dir, constants.R_OK);
  } catch {
    throw vmError('BACKUP_NOT_FOUND', `Backup not found for ${vmName} @ ${timestamp}`);
  }
  return dir;
}

/**
 * Delete a backup directory. Path must be under one of the allowed roots.
 * @param {string} backupPath - Full path to the backup directory (<root>/vms/<vmName>/<timestamp>)
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
 * Copy a backup's payload (disks, NVRAM, cloud-init.json) into destBase.
 * @returns {Promise<Array<{ oldPath: string, newPath: string }>>} disk mapping for XML path rewrites
 */
async function copyBackupPayload(backupPath, config, destBase) {
  const disks = (config.disks || []).filter((d) => d.device === 'disk' && d.source);

  const diskMapping = [];
  for (const disk of disks) {
    const logicalName = basename(disk.source);
    const newDiskPath = join(destBase, logicalName);
    await copyOrGunzip(backupPath, logicalName, newDiskPath);
    diskMapping.push({ oldPath: disk.source, newPath: newDiskPath });
  }

  // allowMissing skips BIOS-only and older silent-skip backups; permission/IO failures surface.
  await copyNvram(join(backupPath, 'VARS.fd'), join(destBase, 'VARS.fd'), { allowMissing: true });

  // cloud-init.json carries the password hash and lands in the group-readable
  // per-VM dir, so it gets the 0600 the live write path applies (a JSON from an
  // older backup keeps whatever mode it had). Optional — absent when the VM had
  // no cloud-init — but once present a failed copy fails the restore. A
  // cloud-init.iso(.gz) in an older backup is ignored: the seed ISO is rebuilt
  // from this JSON by the caller's populateVMDir.
  const cloudInitJsonSrc = join(backupPath, 'cloud-init.json');
  const cloudInitJsonDest = join(destBase, 'cloud-init.json');
  if (await anyReadable([cloudInitJsonSrc])) {
    await copyWithProgress(cloudInitJsonSrc, cloudInitJsonDest, () => {});
    await chmod(cloudInitJsonDest, 0o600);
  }

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
 * @param {string} backupPath - Full path to the backup directory (<root>/vms/<vmName>/<timestamp>)
 * @param {string} newVmName
 * @param {{ populateVMDir?: (vmDir: string, ctx: { xml: string }) => Promise<void> }} [opts]
 *   populateVMDir: writes caller-owned files a backup does not hold (e.g. the
 *   cloud-init seed ISO) into the new VM directory once the payload is in
 *   place, before the domain is defined; `xml` is the domain XML about to be
 *   defined. A throw rolls the restore back like any other failure.
 * @returns { Promise<{ name: string }> }
 */
export async function restoreBackup(backupPath, newVmName, { populateVMDir } = {}) {
  await assertVMNameAvailable(newVmName);

  const { xml, manifest } = await readBackupDomain(backupPath);
  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', 'Failed to parse backup domain.xml');

  const newBase = normalizeBasePath(await createOwnVMDir(newVmName));
  try {
    await restorePayloadAndDefine(backupPath, newVmName, newBase, { xml, manifest, config, populateVMDir });
  } catch (err) {
    // newBase was created exclusively above — removing it undoes the restore.
    await removeOwnVMDir(newBase);
    throw err;
  }

  return { name: newVmName };
}

/** restoreBackup body after the new VM directory exists; any throw leaves cleanup to the caller. */
async function restorePayloadAndDefine(backupPath, newVmName, newBase, { xml, manifest, config, populateVMDir }) {
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

  if (populateVMDir) await populateVMDir(newBase, { xml: newXml });

  try {
    await connectionState.connectIface.DomainDefineXML(newXml);
  } catch (err) {
    throw vmError('BACKUP_RESTORE_FAILED', `Failed to define restored VM "${newVmName}"`, err.message);
  }
}
