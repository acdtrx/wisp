/**
 * Image library module facade: owns the writes to the library directory (upload,
 * rename, delete, and the downloads that land a file there) and the change cue
 * every one of them announces. Callers (routes/library.js) keep their request
 * checks — names, existence, use by a VM — and call these for the write.
 */
import { rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  downloadToLibrary as downloadUrl,
  downloadUbuntuCloudImage as downloadUbuntuCloud,
  downloadArchCloudImage as downloadArchCloud,
  downloadAndDecompressHaos as downloadHaos,
} from '../downloads/index.js';
import { createAppError } from '../routeErrors.js';
import { ensureImageDir, getImagePath } from '../paths.js';

/** Notified after a file is uploaded, renamed, deleted or downloaded into the
 *  library. No replay: a cue to list the library again. */
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

function announcing(write) {
  return async (...args) => {
    const result = await write(...args);
    announceLibraryChange();
    return result;
  };
}

/**
 * Stream a multipart upload into the library under `filename`. The name is
 * reserved with an exclusive create, as downloads do: a check then a write lets
 * two same-name uploads both pass and clobber each other, and would follow a
 * symlink planted at the name. On any failure after the reserve the partial
 * file is removed — this call created it — to avoid a disk-fill DoS.
 *
 * Throws the open error as is (`code: 'EEXIST'` when the name is taken), the
 * stream's error, or `LIBRARY_UPLOAD_TOO_LARGE` when multipart truncated the
 * file at its size limit.
 *
 * @param {string} filename — already validated by the caller
 * @param {import('node:stream').Readable & { truncated?: boolean }} file
 */
async function saveUpload(filename, file) {
  const destPath = join(await ensureImageDir(), filename);
  const handle = await open(destPath, 'wx');
  try {
    await pipeline(file, handle.createWriteStream());
  } catch (err) {
    await unlink(destPath).catch(() => { /* best-effort cleanup */ });
    throw err;
  }
  if (file.truncated) {
    await unlink(destPath).catch(() => { /* best-effort cleanup */ });
    throw createAppError('LIBRARY_UPLOAD_TOO_LARGE', 'Upload exceeded the configured size limit');
  }
}

/** Rename a library file (names already validated and checked by the caller). */
async function renameFile(fromName, toName) {
  const dir = getImagePath();
  await rename(join(dir, fromName), join(dir, toName));
}

/** Delete a library file (name already validated and checked by the caller). */
async function deleteFile(name) {
  await unlink(join(getImagePath(), name));
}

export const saveLibraryUpload = announcing(saveUpload);
export const renameLibraryFile = announcing(renameFile);
export const deleteLibraryFile = announcing(deleteFile);

/* The downloads land their file in the library: each announces once it is there. */
export const downloadUrlToLibrary = announcing(downloadUrl);
export const downloadUbuntuCloudToLibrary = announcing(downloadUbuntuCloud);
export const downloadArchCloudToLibrary = announcing(downloadArchCloud);
export const downloadHaosToLibrary = announcing(downloadHaos);
