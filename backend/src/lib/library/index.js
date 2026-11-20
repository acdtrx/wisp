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
import { createAppError } from '../appErrors.js';
import { ensureImageDir, getImagePath } from '../paths.js';

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

function announcing(write) {
  return async (...args) => {
    const result = await write(...args);
    announceLibraryChange();
    return result;
  };
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

/**
 * Stream a multipart upload into the library under `filename`. The name is
 * reserved with an exclusive create, as downloads do: a check then a write lets
 * two same-name uploads both pass and clobber each other, and would follow a
 * symlink planted at the name. On any failure after the reserve the partial
 * file is removed — this call created it — to avoid a disk-fill DoS.
 *
 * Throws the open error as is (`code: 'EEXIST'` when the name is taken), the
 * stream's error, or `UPLOAD_TOO_LARGE` when the file passed multipart's size
 * limit (the stream failed with it, or multipart truncated the file). Announces once the name was reserved, however it ends:
 * the partial file was in the library meanwhile.
 *
 * @param {string} filename — already validated by the caller
 * @param {import('node:stream').Readable & { truncated?: boolean }} file
 */
async function saveUpload(filename, file) {
  const destPath = join(await ensureImageDir(), filename);
  const handle = await open(destPath, 'wx');
  try {
    try {
      await pipeline(file, handle.createWriteStream());
    } catch (err) {
      await unlink(destPath).catch(() => { /* best-effort cleanup */ });
      // The multipart file limit ends the stream with its own error.
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw createAppError('UPLOAD_TOO_LARGE', 'Upload exceeded the configured size limit');
      }
      throw err;
    }
    if (file.truncated) {
      await unlink(destPath).catch(() => { /* best-effort cleanup */ });
      throw createAppError('UPLOAD_TOO_LARGE', 'Upload exceeded the configured size limit');
    }
  } finally {
    announceLibraryChange();
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

export const saveLibraryUpload = saveUpload;
export const renameLibraryFile = announcing(renameFile);
export const deleteLibraryFile = announcing(deleteFile);

/* The downloads land their file in the library (HAOS its decompressed output too):
 * each announces however it settles — a failed or cancelled one removes the
 * partial file it reserved. One that failed before reserving announces too: a
 * cue that changed nothing is allowed. */
export const downloadUrlToLibrary = announcingSettled(downloadUrl);
export const downloadUbuntuCloudToLibrary = announcingSettled(downloadUbuntuCloud);
export const downloadArchCloudToLibrary = announcingSettled(downloadArchCloud);
export const downloadHaosToLibrary = announcingSettled(downloadHaos);
