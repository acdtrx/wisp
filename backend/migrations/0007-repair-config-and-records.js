/**
 * Brings what older releases left in the config and the records up to what
 * this release reads (settled 2026-11-13: today's two unreleased migrations,
 * container-config-shape and backup-origin, merged into this one, its first
 * step the config repair).
 *
 * 1. runtime.env, read raw: lines setting the retired WISP_BACKEND_PORT /
 *    WISP_FRONTEND_PORT are removed; then the file is parsed strictly and the
 *    WISP_* values checked, as the backend's boot will — a file still invalid
 *    fails here, before wisp-config.json is touched. The runner resolved
 *    WISP_CONFIG_PATH from this same file, loading it strictly except for those
 *    two keys, so a malformed or repeated WISP_CONFIG_PATH has already stopped it.
 * 2. wisp-config.json, read raw: the retired keys refreshIntervalSeconds,
 *    networkMounts and backupNetworkMountId are removed; every mount whose
 *    mountPath is outside /mnt/wisp/ (the mount helper refuses them since
 *    2026-04-29) is removed, its log line naming the containers whose mounts
 *    use it as their source; a backupMountId naming no mount is cleared and
 *    schedule destinations that are neither 'local' nor the backupMountId are
 *    dropped. Anything else invalid is left for the runner's strict check.
 *    Nothing before this step reads the config strictly (0005 and 0006 read
 *    their paths tolerantly), and nothing in this migration does after it.
 * 3. container.json shape — what releases before 2026-11-12 repaired when the
 *    config was read:
 *    - `env` as a flat `{ KEY: "value" }` dict (before 2026-04-15) becomes the
 *      structured `{ KEY: { value } }`, non-secret; a missing env becomes `{}`;
 *    - a missing network, or a `network.type` other than `bridge` (macvlan,
 *      before 2026-04-14), becomes `bridge`, and a missing or malformed MAC is
 *      generated;
 *    - the ignored `network.vlan` field is removed.
 *    Env values are recorded by key count only: they may be secrets. A running
 *    container whose network type or MAC changed gets the restart-required flag
 *    (its task runs on the old network); the env conversion keeps every value,
 *    and `vlan` was never read, so neither flags.
 * 4. Backup origins: every manifest records `origin` (`manual` | `scheduled`)
 *    since scheduled container backups arrived (2026-07-14); VM and container
 *    backups written earlier have none. They get `origin: "manual"` — what they
 *    were — under the backup roots the backend lists (from the repaired config):
 *    the local path, and the backup mount when it is mounted. An unmounted
 *    backup mount is skipped (logged); its old backups keep no origin.
 *
 * Under --dry-run nothing is written, and steps 3 and 4 work from the config
 * as step 2 would leave it, so the run lists everything a real one would change.
 *
 * Backward-compatible: the previous release ignores the removed keys, never
 * used a mount the helper refused, and writes the container and manifest shapes
 * itself. A rollback reverts config/ and the ledger together, so this runs
 * again on the next update. Idempotent: state already in these shapes is left
 * alone.
 */
import { readFile, rename, stat, writeFile } from 'node:fs/promises';

import { writeJsonAtomic } from '../src/lib/atomicJson.js';
import { checkMountPath } from '../src/lib/configSchema.js';
import { checkRuntimeEnv, parseRuntimeEnvText, retiredKeyOfLine } from '../src/lib/loadRuntimeEnv.js';
import { listBackupDestinationsWithMountCheck, listConfiguredBackupRoots } from '../src/lib/settings.js';
import { tolerantConfig } from './lib/tolerantConfig.js';

export const id = '0007-repair-config-and-records';
export const description = 'Config cleaned of what older releases left; container.json shape; backup origins';

const RETIRED_CONFIG_KEYS = ['refreshIntervalSeconds', 'networkMounts', 'backupNetworkMountId'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Step 1. Returns nothing; throws when runtime.env is still invalid. */
async function repairRuntimeEnv(ctx) {
  const path = ctx.paths.runtimeEnvFile;
  const text = await readIfExists(path);
  if (text === null) return;
  const lines = text.split('\n');
  const kept = lines.filter((line, i) => {
    const key = retiredKeyOfLine(line);
    if (!key) return true;
    ctx.recordChange(`runtime.env line ${i + 1}: removed retired ${key}`);
    return false;
  });
  const repaired = kept.join('\n');
  if (kept.length !== lines.length && !ctx.dryRun) {
    const { mode } = await stat(path);
    const tmp = `${path}.0007.${process.pid}`;
    await writeFile(tmp, repaired, { mode: mode & 0o777 });
    await rename(tmp, path);
  }
  parseRuntimeEnvText(repaired);
  checkRuntimeEnv();
}

/** Container names by the storage mount ids their mounts use as `sourceId`. */
async function mountUsers(ctx) {
  const users = new Map();
  for (const { name } of await ctx.containerManager.listContainers()) {
    const config = await ctx.containerManager.readContainerConfig(name);
    for (const m of Array.isArray(config.mounts) ? config.mounts : []) {
      if (typeof m?.sourceId !== 'string') continue;
      if (!users.has(m.sourceId)) users.set(m.sourceId, new Set());
      users.get(m.sourceId).add(name);
    }
  }
  return users;
}

/**
 * Step 2. Returns the decoded config as this step leaves it (undefined when the
 * file is missing; the raw text when it isn't valid JSON — left for the strict check).
 */
async function repairWispConfig(ctx) {
  const path = ctx.paths.configFile;
  const raw = await readIfExists(path);
  if (raw === null) return undefined;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isPlainObject(data)) return data;
  let changed = false;

  for (const key of RETIRED_CONFIG_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    delete data[key];
    ctx.recordChange(`wisp-config.json: removed retired key ${key}`);
    changed = true;
  }

  if (Array.isArray(data.mounts)) {
    let users = null;
    const kept = [];
    for (const m of data.mounts) {
      let outside = false;
      if (isPlainObject(m) && typeof m.mountPath === 'string') {
        try {
          checkMountPath(m.mountPath);
        } catch {
          outside = true;
        }
      }
      if (!outside) {
        kept.push(m);
        continue;
      }
      users ??= await mountUsers(ctx);
      const usedBy = [...(users.get(m.id) ?? [])].sort();
      ctx.recordChange(
        `wisp-config.json: removed mount ${JSON.stringify(m.id)} (${JSON.stringify(m.label ?? '')}): `
          + `mountPath ${JSON.stringify(m.mountPath)} is outside /mnt/wisp/`
          + (usedBy.length ? `; used by container${usedBy.length > 1 ? 's' : ''} ${usedBy.join(', ')}` : '; used by no container'),
      );
      changed = true;
    }
    data.mounts = kept;
  }

  const mountIds = new Set(Array.isArray(data.mounts) ? data.mounts.map((m) => m?.id) : []);
  if (typeof data.backupMountId === 'string' && !mountIds.has(data.backupMountId)) {
    ctx.recordChange(`wisp-config.json: backupMountId ${JSON.stringify(data.backupMountId)} names no mount — cleared`);
    data.backupMountId = null;
    changed = true;
  }
  const schedule = data.backupSchedule;
  if (isPlainObject(schedule) && Array.isArray(schedule.destinationIds)) {
    const allowed = new Set(['local', ...(typeof data.backupMountId === 'string' ? [data.backupMountId] : [])]);
    const kept = schedule.destinationIds.filter((d) => typeof d !== 'string' || allowed.has(d));
    if (kept.length !== schedule.destinationIds.length) {
      for (const d of schedule.destinationIds.filter((x) => !kept.includes(x))) {
        ctx.recordChange(`wisp-config.json: backupSchedule.destinationIds: removed ${JSON.stringify(d)} (no such backup mount)`);
      }
      schedule.destinationIds = kept.length > 0 ? kept : ['local'];
      changed = true;
    }
  }

  if (changed && !ctx.dryRun) await writeJsonAtomic(path, data, { mode: 0o600 });
  return data;
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

/** Bring `config.env` to `{ KEY: { value } }` (mutates). Returns change texts. */
function migrateEnv(config) {
  if (!isPlainObject(config.env)) {
    config.env = {};
    return ['env → {}'];
  }
  let converted = 0;
  for (const [key, value] of Object.entries(config.env)) {
    if (isPlainObject(value)) continue;
    config.env[key] = { value: typeof value === 'string' ? value : String(value ?? '') };
    converted += 1;
  }
  return converted ? [`env: ${converted} flat entr${converted === 1 ? 'y' : 'ies'} → { value }`] : [];
}

/**
 * Bring `config.network` to a bridge network with a MAC and no `vlan` (mutates).
 * Returns `{ changes, needsRestart }`.
 */
function migrateNetwork(config, generateMac) {
  const changes = [];
  let needsRestart = false;
  if (!isPlainObject(config.network)) {
    config.network = {};
    changes.push('network missing → { type: bridge }');
  }
  const net = config.network;
  if (net.type !== 'bridge') {
    if (changes.length === 0) changes.push(`network.type ${JSON.stringify(net.type ?? null)} → bridge`);
    net.type = 'bridge';
    needsRestart = true;
  }
  const mac = typeof net.mac === 'string' ? net.mac.trim().toLowerCase() : '';
  if (!MAC_RE.test(mac)) {
    const was = net.mac == null || net.mac === '' ? 'missing' : 'malformed';
    net.mac = generateMac();
    changes.push(`network.mac ${was} → ${net.mac}`);
    needsRestart = true;
  }
  if ('vlan' in net) {
    delete net.vlan;
    changes.push('network.vlan removed');
  }
  return { changes, needsRestart };
}

/** Step 3. */
async function migrateContainerShapes(ctx) {
  const cm = ctx.containerManager;
  for (const { name, state } of await cm.listContainers()) {
    const config = await cm.readContainerConfig(name);
    const envChanges = migrateEnv(config);
    const { changes: netChanges, needsRestart } = migrateNetwork(config, cm.generateContainerMac);
    const changes = [...envChanges, ...netChanges];
    if (changes.length === 0) continue;

    const running = state === 'running' || state === 'paused';
    const flag = running && needsRestart;
    ctx.recordChange(`${name}: ${changes.join('; ')}${flag ? ' (restart required)' : ''}`);
    if (ctx.dryRun) continue;
    // The flag rides the same write as the change it is for.
    if (flag) config.pendingRestart = { since: new Date().toISOString() };
    await cm.writeContainerConfig(name, config);
  }
}

/** Step 4, over the backup roots of the config as step 2 left it. */
async function markBackupOrigins(ctx, config) {
  const settings = tolerantConfig(config);
  const destinations = await listBackupDestinationsWithMountCheck(settings);
  const listed = destinations.map((d) => d.path);
  for (const root of listConfiguredBackupRoots(settings)) {
    if (!listed.includes(root)) ctx.log.warn({ root }, 'Backup mount not mounted — its backups are left as they are');
  }
  for (const b of await ctx.vmManager.listBackups(destinations)) {
    if (b.origin != null) continue;
    ctx.recordChange(`${b.path}: origin → manual`);
    if (!ctx.dryRun) await ctx.vmManager.setVMBackupOrigin(b.path, 'manual');
  }
  for (const b of await ctx.containerManager.listContainerBackups(destinations)) {
    if (b.origin != null) continue;
    ctx.recordChange(`${b.path}: origin → manual`);
    if (!ctx.dryRun) await ctx.containerManager.setContainerBackupOrigin(b.path, 'manual');
  }
}

export async function run(ctx) {
  await repairRuntimeEnv(ctx);
  const config = await repairWispConfig(ctx);
  await migrateContainerShapes(ctx);
  await markBackupOrigins(ctx, config);
}
