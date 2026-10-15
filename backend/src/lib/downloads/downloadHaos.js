/**
 * Download latest Home Assistant OS KVM image from GitHub releases.
 * Uses the KVM image linked from https://www.home-assistant.io/installation/linux/
 * (haos_ova-*.qcow2.xz), with fallback to haos_generic-x86-64-*.qcow2.xz.
 */

import { unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { ensureImageDir } from '../paths.js';
import { openUniqueFile, downloadWithProgress } from './downloadUtils.js';
import { createAppError } from '../routeErrors.js';

const GITHUB_API = 'https://api.github.com/repos/home-assistant/operating-system/releases/latest';
const ASSET_PATTERNS = [
  /^haos_ova-[\d.]+\.qcow2\.xz$/,           // KVM image from official docs
  /^haos_generic-x86-64-[\d.]+\.qcow2\.xz$/, // alternative naming in releases
];

/**
 * Fetch latest release from GitHub API and return the download URL and final filename for the KVM qcow2.xz asset.
 */
export async function getLatestHaosAsset() {
  const headers = { Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(GITHUB_API, { headers });
  if (!res.ok) {
    throw createAppError('GITHUB_API', `GitHub API error: ${res.status}`, String(res.status));
  }
  const data = await res.json();
  const asset = data.assets?.find((a) => ASSET_PATTERNS.some((re) => re.test(a.name)));
  if (!asset) {
    throw createAppError('NO_ASSET', 'No haos_ova or haos_generic-x86-64 qcow2.xz asset found in latest release');
  }
  const finalName = asset.name.replace(/\.xz$/, '');
  return { url: asset.browser_download_url, name: asset.name, finalName };
}

/**
 * Decompress srcPath with `xz -dc` into the open file handle. Success needs
 * both outcomes: the output stream finished AND xz exited 0 — a corrupt or
 * truncated input makes xz write partial output then exit non-zero, and that
 * must fail rather than leave a truncated image. If the write side fails
 * (ENOSPC), pipeline destroys xz's stdout and xz dies on the broken pipe, so
 * both always settle; the write error is the root cause and wins.
 */
async function decompressXzToFile(srcPath, handle) {
  const xz = spawn('xz', ['-dc', srcPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve, reject) => {
    xz.on('error', reject);
    xz.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`xz exited with ${code ?? signal}`));
    });
  });
  const [written, exit] = await Promise.allSettled([
    pipeline(xz.stdout, handle.createWriteStream()),
    exited,
  ]);
  if (written.status === 'rejected') throw written.reason;
  if (exit.status === 'rejected') throw exit.reason;
}

/**
 * Download the .xz asset, decompress with xz, write to image dir.
 * onProgress(percent, loaded, total) during download. On any failure the
 * hidden compressed temp and the partial output are both removed.
 */
export async function downloadAndDecompressHaos(onProgress) {
  const { url, finalName } = await getLatestHaosAsset();
  const dir = await ensureImageDir();
  const tmpPath = join(dir, `.haos_download_${Date.now()}.qcow2.xz`);
  /* downloadWithProgress removes its own partial file on failure */
  await downloadWithProgress(url, tmpPath, onProgress);

  try {
    const { handle, destPath, filename: outputName } = await openUniqueFile(dir, finalName);
    try {
      await decompressXzToFile(tmpPath, handle);
    } catch (err) {
      await handle.close().catch(() => {
        /* the write stream already closed the handle */
      });
      await unlink(destPath).catch(() => {
        /* partial output already gone */
      });
      throw err;
    }
    const info = await stat(destPath);
    return {
      name: outputName,
      type: 'disk',
      size: info.size,
      modified: info.mtime.toISOString(),
    };
  } finally {
    await unlink(tmpPath).catch(() => {
      /* compressed temp already removed */
    });
  }
}
