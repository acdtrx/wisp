/**
 * Download latest Ubuntu Server LTS cloud image (QCOW2/IMG) from cloud-images.ubuntu.com.
 * Uses a hardcoded LTS list and stable URL pattern; update when Canonical add new LTS.
 */

import { ensureImageDir } from './paths.js';
import { findUniqueFilename, downloadWithProgress } from './downloadUtils.js';

const BASE = 'https://cloud-images.ubuntu.com/releases';
const LTS_LIST = [
  { codename: 'noble', version: '24.04' },
  { codename: 'jammy', version: '22.04' },
  { codename: 'focal', version: '20.04' },
];

/**
 * URL for the server cloudimg amd64 .img file (raw disk image, works like qcow2 for our use).
 */
function getLatestLtsUrl() {
  const lts = LTS_LIST[0];
  const filename = `ubuntu-${lts.version}-server-cloudimg-amd64.img`;
  return {
    url: `${BASE}/${lts.codename}/release/${filename}`,
    filename,
    version: lts.version,
    codename: lts.codename,
  };
}

/**
 * Download the image to the library. onProgress(percent, loaded, total).
 * Returns { name, type, size, modified }.
 */
export async function downloadUbuntuCloudImage(onProgress) {
  const { url, filename } = getLatestLtsUrl();
  const dir = await ensureImageDir();
  const { destPath, filename: finalName } = await findUniqueFilename(dir, filename);
  const result = await downloadWithProgress(url, destPath, onProgress);
  return {
    name: finalName,
    type: result.type,
    size: result.size,
    modified: result.modified,
  };
}
