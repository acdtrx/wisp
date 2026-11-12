/**
 * Sync read of wisp-config.json for paths and other app config.
 * Settings (getSettings/updateSettings) is the single writer; this module is for sync consumers (e.g. paths.js).
 * Both parse through configSchema.js, strictly: an invalid file throws CONFIG_INVALID
 * naming the key, here and at the startup read that gates boot (index.js).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig, parseWispConfigText } from './configSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.WISP_CONFIG_PATH || resolve(__dirname, '../../../config/wisp-config.json');

/**
 * Read config synchronously. A missing file means defaults; an unreadable or
 * invalid one throws. Used by paths.js and any sync caller. For full settings
 * use getSettings().
 */
export function getConfigSync() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const cfg = raw === undefined ? defaultConfig() : parseWispConfigText(raw);
  return {
    serverName: cfg.serverName,
    vmsPath: cfg.vmsPath,
    imagePath: cfg.imagePath,
    backupLocalPath: cfg.backupLocalPath,
    containersPath: cfg.containersPath,
    mounts: cfg.mounts,
    backupMountId: cfg.backupMountId,
    trustedProxies: cfg.trustedProxies,
  };
}

export { CONFIG_PATH };
