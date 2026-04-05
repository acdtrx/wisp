/**
 * VM backup and restore: createBackup, listBackups, restoreBackup.
 * Disk images and cloud-init ISO are streamed gzip to destination (.gz); config files stay uncompressed.
 */
import { copyFile, mkdir, writeFile, readdir, readFile, access, constants, stat, rm, realpath } from 'node:fs/promises';
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
import { getVMBasePath } from '../../paths.js';
import { VIR_DOMAIN_STATE_SHUTOFF, VIR_DOMAIN_STATE_SHUTDOWN } from './libvirtConstants.js';

const execFile = promisify(execFileCb);

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
    await pipeline(
      createReadStream(gz),
      createGunzip(),
      createWriteStream(destPath)
    );
    if (typeof onProgress === 'function') onProgress();
  } catch (err) {
    throw vmError('BACKUP_INVALID', `Backup missing disk or image file: ${logicalName}`, err.message);
  }
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
 * @param {{ onProgress?: (event: { step: string, percent?: number, currentFile?: string }) => void }} options
 * @returns { Promise<{ path: string, timestamp: string }> }
 */
export async function createBackup(vmName, destinationPath, { onProgress } = {}) {
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
  const backupDir = join(destinationPath, vmName, timestamp);
  await mkdir(backupDir, { recursive: true });

  const emit = (step, data = {}) => {
    if (typeof onProgress === 'function') onProgress({ step, ...data });
  };

  const disks = (config.disks || []).filter((d) => d.device === 'disk' && d.source);
  const totalItems = disks.length + (nvramPath ? 1 : 0) + 2; // +2 for cloud-init.iso and cloud-init.json
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
    try {
      await access(nvramPath, constants.R_OK);
      await copyWithProgress(nvramPath, join(backupDir, 'VARS.fd'), () => {});
    } catch {
      /* NVRAM file missing — VM may not use UEFI vars on disk */
    }
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
    vmBasePath: vmBasePathForManifest,
    disks: disks.map((d) => ({ slot: d.slot, file: basename(d.source) })),
    sizeBytes: totalBytes,
  };
  await writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  emit('done', { percent: 100, currentFile: 'Backup complete', path: backupDir });
  return { path: backupDir, timestamp };
}

/**
 * List backups from one or more destination roots. Optionally filter by vmName.
 * @param {Array<{ path: string, label: string }>} destinations - Absolute paths with display labels (e.g. Local, SMB name)
 * @param {string} [vmName] - If set, only return backups for this VM
 * @returns { Promise<Array<{ vmName: string, timestamp: string, path: string, sizeBytes?: number, destinationLabel: string }>> }
 */
export async function listBackups(destinations, vmName = null) {
  const results = [];
  const list = Array.isArray(destinations) ? destinations : [];
  for (const dest of list) {
    const basePath = dest && typeof dest.path === 'string' ? dest.path : dest;
    const label = dest && typeof dest.label === 'string' ? dest.label : 'Backup';
    if (!basePath || !basePath.startsWith('/')) continue;
    let vmDirs;
    try {
      vmDirs = await readdir(basePath, { withFileTypes: true });
    } catch {
      /* destination unreadable — skip this root */
      continue;
    }
    for (const dirent of vmDirs) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      if (vmName != null && vmName !== '' && name !== vmName) continue;
      const vmPath = join(basePath, name);
      let timestamps;
      try {
        timestamps = await readdir(vmPath, { withFileTypes: true });
      } catch {
        /* VM directory unreadable */
        continue;
      }
      for (const tsEnt of timestamps) {
        if (!tsEnt.isDirectory()) continue;
        const backupPath = join(vmPath, tsEnt.name);
        const manifestPath = join(backupPath, 'manifest.json');
        const domainPath = join(backupPath, 'domain.xml');
        let sizeBytes;
        try {
          const raw = await readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(raw);
          sizeBytes = manifest.sizeBytes;
        } catch {
          try {
            await access(domainPath, constants.R_OK);
          } catch {
            /* not a valid backup dir */
            continue;
          }
        }
        results.push({
          vmName: name,
          timestamp: tsEnt.name,
          path: backupPath,
          sizeBytes,
          destinationLabel: label,
        });
      }
    }
  }
  return results.sort((a, b) => {
    const d = (a.vmName || '').localeCompare(b.vmName || '');
    return d !== 0 ? d : (b.timestamp || '').localeCompare(a.timestamp || '');
  });
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
  try {
    await access(resolvedBackup, constants.R_OK | constants.W_OK);
  } catch (err) {
    if (err.code === 'ENOENT') throw vmError('BACKUP_NOT_FOUND', 'Backup not found');
    throw vmError('BACKUP_INVALID', 'Cannot access backup path', err.message);
  }
  await rm(resolvedBackup, { recursive: true, force: true });
}

/**
 * Restore a backup as a new VM.
 * @param {string} backupPath - Full path to the backup directory (e.g. .../vmName/timestamp)
 * @param {string} newVmName
 * @returns { Promise<{ name: string }> }
 */
export async function restoreBackup(backupPath, newVmName) {
  if (!connectionState.connectIface) throw vmError('NO_CONNECTION', 'Not connected to libvirt');

  try {
    await connectionState.connectIface.DomainLookupByName(newVmName);
    throw vmError('VM_EXISTS', `VM "${newVmName}" already exists`);
  } catch (err) {
    if (err.code === 'VM_EXISTS') throw err;
  }

  const domainPath = join(backupPath, 'domain.xml');
  let xml;
  try {
    xml = await readFile(domainPath, 'utf8');
  } catch (err) {
    throw vmError('BACKUP_INVALID', `Backup missing domain.xml: ${backupPath}`, err.message);
  }

  let manifest = null;
  try {
    const raw = await readFile(join(backupPath, 'manifest.json'), 'utf8');
    manifest = JSON.parse(raw);
  } catch {
    /* legacy backup without manifest.json */
  }

  const config = parseVMFromXML(xml);
  if (!config) throw vmError('PARSE_ERROR', 'Failed to parse backup domain.xml');

  const newBase = normalizeBasePath(getVMBasePath(newVmName));
  await mkdir(newBase, { recursive: true });

  const diskMapping = [];
  for (const disk of (config.disks || [])) {
    if (disk.device !== 'disk' || !disk.source) continue;
    const logicalName = basename(disk.source);
    const newDiskPath = join(newBase, logicalName);
    await copyOrGunzip(backupPath, logicalName, newDiskPath);
    diskMapping.push({ oldPath: disk.source, newPath: newDiskPath });
  }

  const nvramBackup = join(backupPath, 'VARS.fd');
  try {
    await access(nvramBackup, constants.R_OK);
    await copyWithProgress(nvramBackup, join(newBase, 'VARS.fd'), () => {});
  } catch {
    /* optional NVRAM in backup */
  }

  try {
    await copyOrGunzip(backupPath, 'cloud-init.iso', join(newBase, 'cloud-init.iso'));
  } catch {
    /* optional — cloud-init ISO not in backup */
  }
  const cloudInitJsonSrc = join(backupPath, 'cloud-init.json');
  try {
    await access(cloudInitJsonSrc, constants.R_OK);
    await copyWithProgress(cloudInitJsonSrc, join(newBase, 'cloud-init.json'), () => {});
  } catch {
    /* optional — cloud-init JSON not in backup */
  }

  const parsed = parseDomainRaw(xml);
  const dom = parsed.domain;
  if (!dom) throw vmError('PARSE_ERROR', 'Failed to parse backup domain XML');

  dom.name = newVmName;
  dom.uuid = randomUUID();

  const oldBase = resolveOldVmBasePath(manifest, config, diskMapping);
  if (oldBase) {
    applyVmBasePrefixToDomain(dom, oldBase, newBase);
  }

  /* Disks outside the VM directory (e.g. image library) are not covered by prefix rewrite */
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

  return { name: newVmName };
}
