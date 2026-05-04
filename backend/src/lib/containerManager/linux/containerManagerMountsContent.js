/**
 * Backing store for container mounts under files/<mountName>: upload, zip extract, init, delete.
 */
import { join, resolve } from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile as execFileCb } from 'node:child_process';
import { TextDecoder, TextEncoder } from 'node:util';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir } from './containerPaths.js';
import { findMount } from './containerManagerMounts.js';

/** Same contract as `import { execFile } from 'node:child_process/promises'` (avoids subpath builtin issues on some runtimes). */
function execFile(command, args, options) {
  return new Promise((resolve, reject) => {
    execFileCb(command, args, options, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stderr });
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function loadContainerJson(containerName) {
  const p = join(getContainerDir(containerName), 'container.json');
  let raw;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${containerName}" not found`);
  }
  return JSON.parse(raw);
}

function artifactPath(containerName, mountName) {
  return join(getContainerFilesDir(containerName), mountName);
}

/** Max size for GET/PUT mount file text editor (UTF-8 bytes). */
export const MOUNT_FILE_CONTENT_MAX_BYTES = 512 * 1024;

function isUnzipMissingError(err) {
  return err?.code === 'ENOENT' || err?.errno === 'ENOENT';
}

/**
 * Stream upload to files/<mountName> (file mount). Overwrites existing file.
 */
export async function uploadMountFileStream(containerName, mountName, fileStream) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const dest = artifactPath(containerName, mountName);
  await pipeline(fileStream, createWriteStream(dest));
  const s = await stat(dest);
  return { name: mountName, size: s.size, modified: s.mtime.toISOString() };
}

const UNZIP_MAX_LIST = 50 * 1024 * 1024;

/**
 * List archive entry names with Info-ZIP `unzip -Z1`, reject zip-slip paths before extraction.
 */
async function assertZipPathsSafe(zipPath) {
  let stdout;
  try {
    const r = await execFile('unzip', ['-Z1', zipPath], { maxBuffer: UNZIP_MAX_LIST });
    stdout = r.stdout;
  } catch (err) {
    if (isUnzipMissingError(err)) {
      throw containerError(
        'CONTAINER_ZIP_INVALID',
        'The unzip program is not available (install the unzip package)',
        err.message,
      );
    }
    throw containerError('CONTAINER_ZIP_INVALID', 'Invalid or corrupted zip archive', err.stderr || err.message);
  }
  const lines = String(stdout).split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    const norm = line.replace(/\\/g, '/');
    if (norm.startsWith('/') || /^[A-Za-z]:[\\/]/.test(norm)) {
      throw containerError('CONTAINER_ZIP_UNSAFE', 'Zip contains absolute paths');
    }
    const parts = norm.split('/').filter(Boolean);
    if (parts.some((p) => p === '..')) {
      throw containerError('CONTAINER_ZIP_UNSAFE', 'Zip contains unsafe path segments');
    }
  }
}

/**
 * Extract with system `unzip` into destDir (must exist). Exit 1 = warnings only (accepted).
 */
async function extractZipWithUnzipCli(zipPath, destDirAbs) {
  try {
    await execFile('unzip', ['-q', '-o', zipPath, '-d', destDirAbs], {
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    if (isUnzipMissingError(err)) {
      throw containerError(
        'CONTAINER_ZIP_INVALID',
        'The unzip program is not available (install the unzip package)',
        err.message,
      );
    }
    const code = err.code;
    if (code === 1 || code === '1') {
      return;
    }
    throw containerError('CONTAINER_ZIP_INVALID', 'Failed to extract zip archive', String(err.stderr || err.message));
  }
}

/**
 * Replace directory mount contents with extracted zip (system `unzip`, zip-slip check via `unzip -Z1`).
 */
export async function uploadMountZipStream(containerName, mountName, zipStream) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'directory') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a directory mount`);
  }
  if (m.sourceId) {
    throw containerError(
      'CONTAINER_MOUNT_TYPE_MISMATCH',
      `Zip upload is only supported for Local directory mounts; "${mountName}" is sourced from a storage mount`,
    );
  }
  const containerDir = getContainerDir(containerName);
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const destDir = artifactPath(containerName, mountName);
  const tmpZip = join(containerDir, '.wisp-upload.zip');
  await pipeline(zipStream, createWriteStream(tmpZip));
  try {
    await assertZipPathsSafe(tmpZip);
    await rm(destDir, { recursive: true, force: true });
    await mkdir(destDir, { recursive: true });
    await extractZipWithUnzipCli(tmpZip, resolve(destDir));
  } finally {
    /* Best-effort temp zip cleanup; ignore ENOENT/already removed */
    await unlink(tmpZip).catch(() => {});
  }
  return { ok: true };
}

/** Empty file (0 bytes) or empty directory. */
export async function initMountContent(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type === 'tmpfs') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is tmpfs and has no host backing store`);
  }
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const p = artifactPath(containerName, mountName);
  if (m.type === 'file') {
    await writeFile(p, Buffer.alloc(0));
  } else {
    await rm(p, { recursive: true, force: true });
    await mkdir(p, { recursive: true });
  }
  return { ok: true };
}

/** Remove backing file or directory; mount row stays in container.json until PATCH. */
export async function deleteMountData(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type === 'tmpfs') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is tmpfs and has no host backing store`);
  }
  const p = artifactPath(containerName, mountName);
  await rm(p, { recursive: true, force: true });
  return { ok: true };
}

/** Delete on-disk artifact when a mount definition is removed from config. No-op for tmpfs. */
export async function deleteMountBackingStore(containerName, mountEntry) {
  if (mountEntry?.type === 'tmpfs') return;
  const p = join(getContainerFilesDir(containerName), mountEntry.name);
  await rm(p, { recursive: true, force: true });
}

/**
 * Read mount backing file as UTF-8 text (for in-app editor). Rejects non-UTF-8 and oversize files.
 */
export async function getMountFileTextContent(containerName, mountName) {
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  const p = artifactPath(containerName, mountName);
  let st;
  try {
    st = await stat(p);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw containerError(
        'CONTAINER_MOUNT_SOURCE_MISSING',
        `No file on disk for mount "${mountName}"`,
      );
    }
    throw err;
  }
  if (!st.isFile()) {
    throw containerError(
      'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
      `Mount "${mountName}" must be backed by a file on the host`,
    );
  }
  if (st.size > MOUNT_FILE_CONTENT_MAX_BYTES) {
    throw containerError(
      'CONTAINER_MOUNT_FILE_TOO_LARGE',
      `Mount file exceeds ${MOUNT_FILE_CONTENT_MAX_BYTES} bytes`,
    );
  }
  const buf = await readFile(p);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw containerError('CONTAINER_MOUNT_FILE_NOT_UTF8', 'File is not valid UTF-8 text');
  }
  return { content: buf.toString('utf8') };
}

/**
 * Replace mount backing file with UTF-8 text from the editor.
 */
export async function putMountFileTextContent(containerName, mountName, content) {
  if (typeof content !== 'string') {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'content must be a string');
  }
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MOUNT_FILE_CONTENT_MAX_BYTES) {
    throw containerError(
      'CONTAINER_MOUNT_FILE_TOO_LARGE',
      `Mount file exceeds ${MOUNT_FILE_CONTENT_MAX_BYTES} bytes`,
    );
  }
  const config = await loadContainerJson(containerName);
  const m = findMount(config, mountName);
  if (!m) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  if (m.type !== 'file') {
    throw containerError('CONTAINER_MOUNT_TYPE_MISMATCH', `Mount "${mountName}" is not a file mount`);
  }
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const dest = artifactPath(containerName, mountName);
  await writeFile(dest, bytes);
  return { ok: true };
}
