/**
 * The few wisp-config.json keys migrations need — the storage paths, `mounts`,
 * `backupMountId` — read tolerantly: a missing or wrong-typed path takes its
 * default, and nothing else in the file is looked at. Migrations may run on a
 * file an older release wrote, before 0007 repairs it for the strict reader
 * (lib/configSchema.js), so none of them reads the config strictly. The
 * migration runner hands `readTolerantConfig` to migrations as `ctx.getConfig`
 * and to the manager setup. Not a parser to trust beyond paths: an invalid file
 * still fails the runner's strict check after the migrations.
 */
import { readFileSync } from 'node:fs';

import { defaultConfig } from '../../src/lib/configSchema.js';

const PATH_KEYS = ['vmsPath', 'imagePath', 'backupLocalPath', 'containersPath'];

/** The tolerant view of decoded wisp-config.json data (anything, even not an object). */
export function tolerantConfig(data) {
  const defaults = defaultConfig();
  const src = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = {};
  for (const key of PATH_KEYS) {
    const v = src[key];
    out[key] = typeof v === 'string' && v.trim().startsWith('/') ? v.trim() : defaults[key];
  }
  out.mounts = Array.isArray(src.mounts)
    ? src.mounts.filter((m) => m !== null && typeof m === 'object' && typeof m.id === 'string')
    : [];
  out.backupMountId = typeof src.backupMountId === 'string' ? src.backupMountId : null;
  return out;
}

/** Read the file at `path` tolerantly; a missing file is the defaults. Invalid JSON throws. */
export function readTolerantConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return tolerantConfig({});
    throw err;
  }
  return tolerantConfig(JSON.parse(raw));
}
