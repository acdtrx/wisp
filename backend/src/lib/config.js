/**
 * Sync read of wisp-config.json for paths and other app config.
 * Settings (getSettings/updateSettings) is the single writer; this module is for sync consumers (e.g. paths.js).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.WISP_CONFIG_PATH || resolve(__dirname, '../../../config/wisp-config.json');

const DEFAULTS = {
  serverName: null,
  refreshIntervalSeconds: 5,
  vmsPath: '/var/lib/wisp/vms',
  imagePath: '/var/lib/wisp/images',
  backupLocalPath: '/var/lib/wisp/backups',
  containersPath: '/var/lib/wisp/containers',
  mounts: [],
  backupMountId: null,
};

function validatePath(val, defaultVal) {
  return typeof val === 'string' && val.trim().startsWith('/') ? val.trim() : defaultVal;
}

/**
 * Read config synchronously. Returns defaults if file missing or invalid.
 * Used by paths.js and any sync caller. For full settings with env overrides use getSettings().
 */
export function getConfigSync() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      serverName: typeof data.serverName === 'string' ? data.serverName : DEFAULTS.serverName,
      refreshIntervalSeconds:
        typeof data.refreshIntervalSeconds === 'number' &&
        data.refreshIntervalSeconds >= 1 &&
        data.refreshIntervalSeconds <= 60
          ? data.refreshIntervalSeconds
          : DEFAULTS.refreshIntervalSeconds,
      vmsPath: validatePath(data.vmsPath, DEFAULTS.vmsPath),
      imagePath: validatePath(data.imagePath, DEFAULTS.imagePath),
      backupLocalPath: validatePath(data.backupLocalPath, DEFAULTS.backupLocalPath),
      containersPath: validatePath(data.containersPath, DEFAULTS.containersPath),
      mounts: Array.isArray(data.mounts) ? data.mounts : DEFAULTS.mounts,
      backupMountId:
        typeof data.backupMountId === 'string' && data.backupMountId.trim()
          ? data.backupMountId.trim()
          : null,
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    /* parse/read error — fall back to defaults rather than crash sync callers */
    console.warn('wisp-config.json parse error, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

export { CONFIG_PATH };
