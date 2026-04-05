import { join } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { getConfigSync } from './config.js';

/**
 * Base directory for a VM's files: <vmsPath>/<name>/
 * All VM-owned files (disk, cloud-init ISO, NVRAM, config) live here.
 * vmsPath comes from wisp-config.json (or env WISP_CONFIG_PATH).
 */
export function getVMBasePath(name) {
  const { vmsPath } = getConfigSync();
  return join(vmsPath, name);
}

/**
 * Base directory for the image library (ISOs, disk images).
 * Comes from wisp-config.json.
 */
export function getImagePath() {
  const { imagePath } = getConfigSync();
  return imagePath;
}

/**
 * Ensure the image library directory exists (create if missing).
 */
export async function ensureImageDir() {
  const dir = getImagePath();
  try {
    await access(dir);
  } catch {
    /* directory missing — create it */
    await mkdir(dir, { recursive: true });
  }
  return dir;
}
