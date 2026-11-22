/**
 * Sync read of wisp-config.json for paths and other app config.
 * Settings (getSettings/updateSettings) is the single writer; this module is for sync consumers (e.g. paths.js).
 * Both parse through configSchema.js, strictly: an invalid file throws CONFIG_INVALID
 * naming the key, here and at the startup read that gates boot (index.js).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultConfig, parseWispConfigText } from './configSchema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dirname, '../../..');
/** The install folder: what an install replaces, all of it but config/. */
export const INSTALL_ROOT = PROJECT_ROOT;
const INSTALL_CONFIG_DIR = join(PROJECT_ROOT, 'config');

const CONFIG_PATH = process.env.WISP_CONFIG_PATH || join(INSTALL_CONFIG_DIR, 'wisp-config.json');

/**
 * Whether this tree is an installed Wisp: it carries the RELEASE file that
 * scripts/stage-release.sh writes into every tree it stages, which the
 * installer and the updater install from and a git checkout never has.
 */
export function isInstalledTree(root = PROJECT_ROOT) {
  return existsSync(join(root, 'RELEASE'));
}

/**
 * Why the start must refuse `env`'s WISP_CONFIG_PATH, or null. The key is for
 * development and tests: an installed Wisp keeps its configuration in its own
 * config/, which the updater snapshots and restores on rollback
 * (docs/specs/CONFIGURATION.md → Password Storage). An empty value is unset.
 */
export function configPathOverrideProblem({ installed, env, configDir = INSTALL_CONFIG_DIR }) {
  const value = env.WISP_CONFIG_PATH;
  if (!installed || value === undefined || value === '') return null;
  return `WISP_CONFIG_PATH is set (${value}), but it is for development and tests: an installed Wisp `
    + `keeps its configuration in ${configDir}/. Remove the key from ${join(configDir, 'runtime.env')} `
    + 'or from the environment that starts Wisp';
}

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
