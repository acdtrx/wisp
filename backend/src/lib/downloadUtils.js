/**
 * Shared download utilities: findUniqueFilename, downloadWithProgress.
 * Used by downloadFromUrl, downloadUbuntuCloud, downloadHaos.
 */
import { createWriteStream } from 'node:fs';
import { access, unlink, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createAppError } from './routeErrors.js';
import { detectType } from './fileTypes.js';

/**
 * Find a non-colliding path in dir for the given base filename.
 * Returns { destPath, filename }.
 */
export async function findUniqueFilename(dir, baseName) {
  const extIdx = baseName.lastIndexOf('.');
  const base = extIdx > 0 ? baseName.slice(0, extIdx) : baseName;
  const ext = extIdx > 0 ? baseName.slice(extIdx) : '';
  let filename = baseName;
  let destPath = join(dir, filename);
  let n = 1;
  while (true) {
    try {
      await access(destPath);
      filename = `${base} (${n})${ext}`;
      destPath = join(dir, filename);
      n += 1;
    } catch {
      /* destPath does not exist — use this filename */
      break;
    }
  }
  return { destPath, filename };
}

/**
 * Stream response body to destPath. onProgress(percent, loaded, totalBytes).
 * Cleans up (destroy writer, unlink) on error.
 */
export async function streamResponseToFile(res, destPath, onProgress) {
  const total = res.headers.get('content-length');
  const totalBytes = total ? parseInt(total, 10) : null;
  const reader = res.body?.getReader();
  if (!reader) {
    throw createAppError('NO_BODY', 'Response has no body');
  }
  const writer = createWriteStream(destPath);
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
      loaded += value.length;
      if (typeof onProgress === 'function' && totalBytes != null && totalBytes > 0) {
        const percent = Math.min(100, Math.round((loaded / totalBytes) * 100));
        onProgress(percent, loaded, totalBytes);
      }
    }
    writer.end();
  } catch (err) {
    writer.destroy();
    await unlink(destPath).catch(() => {
      /* partial file may not exist */
    });
    throw err;
  }
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  if (typeof onProgress === 'function') {
    onProgress(100, loaded, totalBytes);
  }
}

/**
 * Download url to destPath with progress. onProgress(percent, loaded, totalBytes).
 * Cleans up destPath on error. Returns { name, type, size, modified } on success.
 */
export async function downloadWithProgress(url, destPath, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw createAppError('DOWNLOAD_FAILED', `Download failed: HTTP ${res.status}`, String(res.status));
  }
  await streamResponseToFile(res, destPath, onProgress);
  const info = await stat(destPath);
  const name = basename(destPath);
  return {
    name,
    type: detectType(name),
    size: info.size,
    modified: info.mtime.toISOString(),
  };
}
