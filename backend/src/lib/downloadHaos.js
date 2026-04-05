/**
 * Download latest Home Assistant OS KVM image from GitHub releases.
 * Uses the KVM image linked from https://www.home-assistant.io/installation/linux/
 * (haos_ova-*.qcow2.xz), with fallback to haos_generic-x86-64-*.qcow2.xz.
 */

import { createWriteStream } from 'node:fs';
import { unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureImageDir } from './paths.js';
import { findUniqueFilename, downloadWithProgress } from './downloadUtils.js';
import { createAppError } from './routeErrors.js';

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
 * Download the .xz asset, decompress with xz, write to image dir.
 * onProgress(percent, loaded, total) during download.
 */
export async function downloadAndDecompressHaos(onProgress) {
  const { url, finalName } = await getLatestHaosAsset();
  const dir = await ensureImageDir();
  const { destPath, filename: outputName } = await findUniqueFilename(dir, finalName);
  const tmpPath = join(dir, `.haos_download_${Date.now()}.qcow2.xz`);
  try {
    await downloadWithProgress(url, tmpPath, onProgress);
  } catch (err) {
    await unlink(tmpPath).catch(() => {
      /* partial download may not exist */
    });
    throw err;
  }

  await new Promise((resolve, reject) => {
    const xz = spawn('xz', ['-dc', tmpPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const out = createWriteStream(destPath);
    xz.stdout.pipe(out);
    out.on('finish', () => resolve());
    out.on('error', reject);
    xz.on('error', reject);
    xz.on('exit', (code) => {
      if (code !== 0) reject(new Error(`xz exited with code ${code}`));
    });
  });

  await unlink(tmpPath).catch(() => {
    /* compressed temp may already be removed */
  });

  const info = await stat(destPath);
  return {
    name: outputName,
    type: 'disk',
    size: info.size,
    modified: info.mtime.toISOString(),
  };
}
