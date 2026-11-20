/**
 * Image library module facade: the library directory's files — the listing,
 * and every write (upload, rename, delete, and the downloads that land a file
 * there) with the change cue each announces. A name a caller passes is checked
 * here, where the path is built from it; a file a VM uses is never renamed or
 * deleted from under it.
 */
import { access, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  detectType,
  downloadToLibrary as downloadUrl,
  downloadUbuntuCloudImage as downloadUbuntuCloud,
  downloadArchCloudImage as downloadArchCloud,
  downloadAndDecompressHaos as downloadHaos,
} from '../downloads/index.js';
import { createAppError, isAppError, wrapAppError } from '../appErrors.js';
import { ensureImageDir, getImagePath } from '../paths.js';
import { findVMsUsingImage } from '../vmManager/index.js';

/** Notified after a file is uploaded, renamed, deleted or downloaded into the
 *  library, and after a failed upload or download removed its partial file. No
 *  replay: a cue to list the library again. */
const libraryChangeHandlers = new Set();

export function subscribeLibraryChange(handler) {
  libraryChangeHandlers.add(handler);
  return () => libraryChangeHandlers.delete(handler);
}

function announceLibraryChange() {
  for (const handler of libraryChangeHandlers) {
    try {
      handler();
    } catch (err) {
      // A broken subscriber must not fail the write or silence the others.
      console.error('library: change subscriber failed', err);
    }
  }
}

/** For a write that may leave a partial file in the library before it fails (a
 *  download): it announces however it settles, so a listing that caught the
 *  partial file is read again once it is gone. */
function announcingSettled(write) {
  return async (...args) => {
    try {
      return await write(...args);
    } finally {
      announceLibraryChange();
    }
  };
}

/** A library file's name: one path segment, not hidden, no `..`. Throws INVALID_FILENAME. */
function assertLibraryFilename(name, what = 'Filename') {
  const valid = typeof name === 'string' && name !== ''
    && !name.includes('/') && !name.includes('\\') && !name.includes('..')
    && !name.startsWith('.') && name === basename(name);
  if (!valid) throw createAppError('INVALID_FILENAME', `${what} "${name}" contains invalid characters`);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

/** The library file `name`, which must exist; its absolute path. */
async function existingLibraryFile(name) {
  assertLibraryFilename(name);
  const path = join(getImagePath(), name);
  if (!(await exists(path))) {
    throw createAppError('LIBRARY_FILE_NOT_FOUND', `"${name}" does not exist in the library`);
  }
  return path;
}

/* A domain XML that points at a missing file fails its next start. */
async function assertNotUsedByVMs(name, path) {
  const inUseBy = await findVMsUsingImage(path);
  if (inUseBy.length > 0) {
    throw createAppError('LIBRARY_FILE_IN_USE', `Detach "${name}" from these VMs first: ${inUseBy.join(', ')}`);
  }
}

/**
 * The library's files, by name, optionally only those of `type` (`iso` |
 * `disk`): `[{ name, type, size, modified }]`. Hidden entries (in-flight
 * downloads) and anything that is not a regular file are left out.
 */
export async function listLibraryFiles(type) {
  const dir = await ensureImageDir();
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw wrapAppError('LIBRARY_IO_FAILED', 'Failed to read the image library', err);
  }
  const files = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const entryType = detectType(entry);
    if (type && entryType !== type) continue;
    let info;
    try {
      info = await stat(join(dir, entry));
    } catch {
      /* removed or unreadable since the listing: left out */
      continue;
    }
    if (!info.isFile()) continue;
    files.push({ name: entry, type: entryType, size: info.size, modified: info.mtime.toISOString() });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Stream a multipart upload into the library under its own file name (its
 * last segment). The name is reserved with an exclusive create, as downloads
 * do: a check then a write lets two same-name uploads both pass and clobber
 * each other, and would follow a symlink planted at the name. On any failure
 * after the reserve the partial file is removed — this call created it — to
 * avoid a disk-fill DoS; that announces too, as the partial file was listed
 * meanwhile.
 *
 * Throws INVALID_FILENAME, LIBRARY_FILE_EXISTS, UPLOAD_TOO_LARGE (the file
 * passed multipart's size limit: the stream failed with it, or multipart
 * truncated the file), the stream's own error, or LIBRARY_IO_FAILED.
 *
 * @param {string} uploadName — the multipart part's file name
 * @param {import('node:stream').Readable & { truncated?: boolean }} file
 */
export async function saveLibraryUpload(uploadName, file) {
  const filename = basename(uploadName);
  assertLibraryFilename(filename);
  const destPath = join(await ensureImageDir(), filename);
  let handle;
  try {
    handle = await open(destPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw createAppError('LIBRARY_FILE_EXISTS', `A file named "${filename}" already exists in the library`);
    }
    throw wrapAppError('LIBRARY_IO_FAILED', `Failed to save the upload "${filename}"`, err);
  }
  try {
    try {
      await pipeline(file, handle.createWriteStream());
    } catch (err) {
      await unlink(destPath).catch(() => { /* best-effort cleanup */ });
      // The multipart file limit ends the stream with its own error.
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw createAppError('UPLOAD_TOO_LARGE', 'Upload exceeded the configured size limit');
      }
      if (isAppError(err)) throw err;
      throw wrapAppError('LIBRARY_IO_FAILED', `Failed to save the upload "${filename}"`, err);
    }
    if (file.truncated) {
      await unlink(destPath).catch(() => { /* best-effort cleanup */ });
      throw createAppError('UPLOAD_TOO_LARGE', 'Upload exceeded the configured size limit');
    }
  } finally {
    announceLibraryChange();
  }
}

/**
 * Rename library file `fromName` to `toName`. Throws INVALID_FILENAME,
 * LIBRARY_FILE_NOT_FOUND, LIBRARY_FILE_EXISTS, LIBRARY_FILE_IN_USE (a VM uses
 * it) or LIBRARY_IO_FAILED. Renaming a file to its own name changes nothing.
 */
export async function renameLibraryFile(fromName, toName) {
  const fromPath = await existingLibraryFile(fromName);
  assertLibraryFilename(toName, 'New filename');
  if (fromName === toName) return;
  const toPath = join(getImagePath(), toName);
  if (await exists(toPath)) {
    throw createAppError('LIBRARY_FILE_EXISTS', `A file named "${toName}" already exists in the library`);
  }
  await assertNotUsedByVMs(fromName, fromPath);
  try {
    await rename(fromPath, toPath);
  } catch (err) {
    throw wrapAppError('LIBRARY_IO_FAILED', `Failed to rename "${fromName}" to "${toName}"`, err);
  }
  announceLibraryChange();
}

/**
 * Delete library file `name`. Throws INVALID_FILENAME, LIBRARY_FILE_NOT_FOUND,
 * LIBRARY_FILE_IN_USE (a VM uses it) or LIBRARY_IO_FAILED.
 */
export async function deleteLibraryFile(name) {
  const path = await existingLibraryFile(name);
  await assertNotUsedByVMs(name, path);
  try {
    await unlink(path);
  } catch (err) {
    throw wrapAppError('LIBRARY_IO_FAILED', `Failed to delete "${name}"`, err);
  }
  announceLibraryChange();
}

/* The downloads land their file in the library (HAOS its decompressed output too):
 * each announces however it settles — a failed or cancelled one removes the
 * partial file it reserved. One that failed before reserving announces too: a
 * cue that changed nothing is allowed. */
export const downloadUrlToLibrary = announcingSettled(downloadUrl);
export const downloadUbuntuCloudToLibrary = announcingSettled(downloadUbuntuCloud);
export const downloadArchCloudToLibrary = announcingSettled(downloadArchCloud);
export const downloadHaosToLibrary = announcingSettled(downloadHaos);
