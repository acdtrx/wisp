/**
 * Config repair: the migration runner's first step, on every run (settled
 * 2026-11-13). Brings what older releases left in config/wisp-config.json and
 * config/runtime.env up to the strict schema the backend boots on
 * (lib/configSchema.js, lib/loadRuntimeEnv.js), so a host that ran an earlier
 * release still updates:
 *
 *   - retired keys: refreshIntervalSeconds, networkMounts, backupNetworkMountId
 *     (wisp-config.json); WISP_BACKEND_PORT, WISP_FRONTEND_PORT (runtime.env)
 *   - mounts whose mountPath is outside /mnt/wisp/ (the mount helper has refused
 *     them since 2026-04-29), each one logged
 *   - a backupMountId naming no mount, and schedule destinations that are not
 *     'local' or the backupMountId (a deleted mount older releases left listed)
 *
 * It reads both files raw — never through the strict parsers, which would
 * refuse exactly what it repairs. Not a ledgered migration: a rollback restores
 * config/ from the pre-update snapshot but keeps the ledger (UPDATES.md → No
 * in-tree config), and migrations that read settings run before any new id
 * would; so it runs, idempotently, before them on every run. Everything else
 * wrong with the files is left for the strict check that follows to report.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';

import { checkMountPath } from '../src/lib/configSchema.js';
import { writeJsonAtomic } from '../src/lib/atomicJson.js';

const RETIRED_CONFIG_KEYS = ['refreshIntervalSeconds', 'networkMounts', 'backupNetworkMountId'];
const RETIRED_ENV_KEYS = new Set(['WISP_BACKEND_PORT', 'WISP_FRONTEND_PORT']);

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The repaired runtime.env text, or the input when nothing changed. Retired
 * lines are dropped; every other line is kept byte for byte.
 */
function repairRuntimeEnvText(text, record) {
  const lines = text.split('\n');
  const kept = lines.filter((line, i) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m || !RETIRED_ENV_KEYS.has(m[1])) return true;
    record(`runtime.env line ${i + 1}: removed retired ${m[1]}`);
    return false;
  });
  return kept.length === lines.length ? text : kept.join('\n');
}

/** Repair the decoded wisp-config.json in place; returns whether it changed. */
function repairConfigData(data, record) {
  let changed = false;
  for (const key of RETIRED_CONFIG_KEYS) {
    if (Object.hasOwn(data, key)) {
      delete data[key];
      record(`wisp-config.json: removed retired key ${key}`);
      changed = true;
    }
  }
  if (Array.isArray(data.mounts)) {
    data.mounts = data.mounts.filter((m) => {
      if (!isPlainObject(m) || typeof m.mountPath !== 'string') return true;
      try {
        checkMountPath(m.mountPath);
        return true;
      } catch {
        record(`wisp-config.json: removed mount ${JSON.stringify(m.id)} (${JSON.stringify(m.label ?? '')}): mountPath ${JSON.stringify(m.mountPath)} is outside /mnt/wisp/`);
        changed = true;
        return false;
      }
    });
  }
  const mountIds = new Set(Array.isArray(data.mounts) ? data.mounts.map((m) => m?.id) : []);
  if (typeof data.backupMountId === 'string' && !mountIds.has(data.backupMountId)) {
    record(`wisp-config.json: backupMountId ${JSON.stringify(data.backupMountId)} names no mount — cleared`);
    data.backupMountId = null;
    changed = true;
  }
  const schedule = data.backupSchedule;
  if (isPlainObject(schedule) && Array.isArray(schedule.destinationIds)) {
    const allowed = new Set(['local', ...(typeof data.backupMountId === 'string' ? [data.backupMountId] : [])]);
    const kept = schedule.destinationIds.filter((id) => typeof id !== 'string' || allowed.has(id));
    if (kept.length !== schedule.destinationIds.length) {
      for (const id of schedule.destinationIds.filter((x) => !kept.includes(x))) {
        record(`wisp-config.json: backupSchedule.destinationIds: removed ${JSON.stringify(id)} (no such backup mount)`);
      }
      schedule.destinationIds = kept.length > 0 ? kept : ['local'];
      changed = true;
    }
  }
  return changed;
}

/**
 * Repair both files. Returns `{ changes, runtimeEnvText, configData }` — the
 * repaired content (what is on disk after a real run, what would be under
 * dry-run), for the strict check that follows. `configData` is undefined when
 * the file is missing, and the raw text when it isn't valid JSON (left for the
 * strict check to report).
 */
export async function repairConfig({ runtimeEnvPath, configPath, dryRun, log }) {
  const changes = [];
  const record = (text) => {
    changes.push(text);
    log.info({ step: 'config-repair', dryRun }, text);
  };

  let runtimeEnvText = await readIfExists(runtimeEnvPath);
  if (runtimeEnvText !== null) {
    const repaired = repairRuntimeEnvText(runtimeEnvText, record);
    if (repaired !== runtimeEnvText && !dryRun) {
      const { mode } = await stat(runtimeEnvPath);
      const tmp = `${runtimeEnvPath}.repair.${process.pid}`;
      await writeFile(tmp, repaired, { mode: mode & 0o777 });
      await rename(tmp, runtimeEnvPath);
    }
    runtimeEnvText = repaired;
  }

  const raw = await readIfExists(configPath);
  let configData;
  if (raw !== null) {
    try {
      configData = JSON.parse(raw);
    } catch {
      configData = raw; // invalid JSON: not ours to guess at
    }
    if (isPlainObject(configData) && repairConfigData(configData, record) && !dryRun) {
      await writeJsonAtomic(configPath, configData, { mode: 0o600 });
    }
  }
  return { changes, runtimeEnvText, configData };
}
