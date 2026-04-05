import { extname } from 'node:path';

const ISO_EXTS = new Set(['.iso']);
const DISK_EXTS = new Set(['.qcow2', '.img', '.raw', '.vmdk']);

/**
 * Detect image type from filename extension. Returns 'iso', 'disk', or 'unknown'.
 */
export function detectType(filename) {
  const ext = extname(filename).toLowerCase();
  if (ISO_EXTS.has(ext)) return 'iso';
  if (DISK_EXTS.has(ext)) return 'disk';
  return 'unknown';
}
