/**
 * Shared download utilities: exclusive file creation, response-body → file
 * streaming with progress, and fetch-then-stream helpers.
 * Used by downloadFromUrl, downloadUbuntuCloud, downloadHaos, and wispUpdate.
 */
import { open, unlink, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAppError } from '../routeErrors.js';
import { detectType } from './fileTypes.js';
import { ssrfSafeFetch } from './downloadFromUrl.js';

/**
 * Create a new empty file in dir under the first free name of `baseName`,
 * `base (1).ext`, `base (2).ext`, … and return it open for writing.
 * Returns { handle, destPath, filename }.
 *
 * The exclusive create (O_CREAT|O_EXCL) is the name reservation: two downloads
 * of the same file racing here end up on distinct names instead of colliding,
 * and a symlink planted at a candidate name is never followed.
 */
export async function openUniqueFile(dir, baseName) {
  const extIdx = baseName.lastIndexOf('.');
  const base = extIdx > 0 ? baseName.slice(0, extIdx) : baseName;
  const ext = extIdx > 0 ? baseName.slice(extIdx) : '';
  for (let n = 0; ; n += 1) {
    const filename = n === 0 ? baseName : `${base} (${n})${ext}`;
    const destPath = join(dir, filename);
    try {
      const handle = await open(destPath, 'wx');
      return { handle, destPath, filename };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      /* name taken — an existing file or a concurrent download; try the next one */
    }
  }
}

/**
 * Pipe a fetch Response body into an already-created file. pipeline() gives
 * backpressure and surfaces an error from either end (network, ENOSPC) as a
 * rejection; the handle is closed when the stream settles. On failure the
 * file — which the caller created exclusively, so it is ours — is removed.
 * onBytes(loaded) runs after each chunk. Resolves to the byte count.
 */
async function pipeBodyToFile(body, handle, destPath, onBytes) {
  let loaded = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      loaded += chunk.length;
      if (typeof onBytes === 'function') onBytes(loaded);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body), counter, handle.createWriteStream());
  } catch (err) {
    await handle.close().catch(() => {
      /* the write stream already closed the handle */
    });
    await unlink(destPath).catch(() => {
      /* partial file already gone */
    });
    throw err;
  }
  return loaded;
}

function assertBody(res) {
  if (!res.body) {
    throw createAppError('NO_BODY', 'Response has no body');
  }
}

/** Adapt per-chunk byte counts to onProgress(percent, loaded, totalBytes) when the length is known. */
function percentReporter(res, onProgress) {
  const total = res.headers.get('content-length');
  const totalBytes = total ? parseInt(total, 10) : null;
  const onBytes = (loaded) => {
    if (typeof onProgress === 'function' && totalBytes != null && totalBytes > 0) {
      const percent = Math.min(100, Math.round((loaded / totalBytes) * 100));
      onProgress(percent, loaded, totalBytes);
    }
  };
  const done = (loaded) => {
    if (typeof onProgress === 'function') onProgress(100, loaded, totalBytes);
  };
  return { onBytes, done };
}

/**
 * Write a Response body to a new file at destPath (created exclusively — the
 * open fails with EEXIST rather than clobbering a file or following a symlink).
 * onBytes(loaded) per chunk. Partial file removed on error. Resolves to the
 * byte count.
 */
export async function writeResponseToFile(res, destPath, onBytes) {
  assertBody(res);
  const handle = await open(destPath, 'wx');
  return pipeBodyToFile(res.body, handle, destPath, onBytes);
}

/**
 * Stream response body to a new file at destPath. onProgress(percent, loaded, totalBytes).
 * Partial file removed on error.
 */
export async function streamResponseToFile(res, destPath, onProgress) {
  const { onBytes, done } = percentReporter(res, onProgress);
  const loaded = await writeResponseToFile(res, destPath, onBytes);
  done(loaded);
}

/**
 * Stream response body to a new file in dir named after baseName (with a
 * ` (n)` suffix when taken — see openUniqueFile). onProgress(percent, loaded,
 * totalBytes). Partial file removed on error. Returns { destPath, filename }.
 */
export async function streamResponseToUniqueFile(res, dir, baseName, onProgress) {
  assertBody(res);
  const { onBytes, done } = percentReporter(res, onProgress);
  const { handle, destPath, filename } = await openUniqueFile(dir, baseName);
  const loaded = await pipeBodyToFile(res.body, handle, destPath, onBytes);
  done(loaded);
  return { destPath, filename };
}

async function fetchOk(url) {
  const res = await ssrfSafeFetch(url);
  if (!res.ok) {
    throw createAppError('DOWNLOAD_FAILED', `Download failed: HTTP ${res.status}`, String(res.status));
  }
  return res;
}

async function describeFile(destPath) {
  const info = await stat(destPath);
  const name = basename(destPath);
  return {
    name,
    type: detectType(name),
    size: info.size,
    modified: info.mtime.toISOString(),
  };
}

/**
 * Download url to a new file at destPath with progress. onProgress(percent, loaded, totalBytes).
 * Partial file removed on error. Returns { name, type, size, modified } on success.
 *
 * Uses ssrfSafeFetch (DNS-pinned, manual redirect re-validation) so even
 * hardcoded mirror URLs cannot be redirected to private/loopback addresses by
 * a hostile or compromised mirror.
 */
export async function downloadWithProgress(url, destPath, onProgress) {
  const res = await fetchOk(url);
  await streamResponseToFile(res, destPath, onProgress);
  return describeFile(destPath);
}

/**
 * Download url into dir under baseName (or the next free ` (n)` variant).
 * Same progress, cleanup, and SSRF guarantees as downloadWithProgress.
 * Returns { name, type, size, modified } on success.
 */
export async function downloadToUniqueFile(url, dir, baseName, onProgress) {
  const res = await fetchOk(url);
  const { destPath } = await streamResponseToUniqueFile(res, dir, baseName, onProgress);
  return describeFile(destPath);
}
