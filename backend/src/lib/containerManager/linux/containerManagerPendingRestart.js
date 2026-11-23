/**
 * Restart-required flag: `pendingRestart: { since }` in container.json marks
 * a saved change the running task doesn't reflect yet. A container needs a
 * restart while the flag exists and its task has not started since `since`;
 * the stored flag is dropped by the start that outgrows it.
 */
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { processStartTimeMsFromProc } from './procUptime.js';
import { validateAndNormalizeMounts } from './containerManagerMounts.js';
import { validateAndNormalizeDevices } from './containerManagerDevices.js';
import { resolveMount } from './containerPaths.js';

/** Fields a running task only picks up on its next start. */
export const RESTART_FIELDS = new Set([
  'image', 'command', 'cpuLimit', 'memoryLimitMiB', 'env', 'mounts', 'devices', 'network', 'runAsRoot',
]);

/** `list` normalised as a save writes it; a stored list today's checks refuse is compared as it is. */
function normalisedList(list, normalize) {
  const raw = Array.isArray(list) ? list : [];
  try {
    return normalize(raw);
  } catch {
    return raw; // a stored list today's checks refuse is compared as it is (above)
  }
}

/** JSON with object keys in order, so a re-ordered env compares equal. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The one test of "this change needs a restart": the RESTART_FIELDS of a
 * config as the running task would see them — mounts and devices normalised,
 * a mount's `secret` left out (a file mode, applied live), the network without
 * the addresses a start writes. A container that is on needs a restart when
 * its signature before a save differs from its signature after.
 */
export function restartSignature(config) {
  const { ip: _ip, ip6: _ip6, ...network } = config.network || {};
  return stableJson({
    image: config.image ?? null,
    command: config.command ?? null,
    cpuLimit: config.cpuLimit ?? null,
    memoryLimitMiB: config.memoryLimitMiB ?? null,
    env: config.env ?? {},
    mounts: normalisedList(config.mounts, (l) => validateAndNormalizeMounts(l, resolveMount)).map(({ secret: _s, ...m }) => m),
    devices: normalisedList(config.devices, validateAndNormalizeDevices),
    network,
    runAsRoot: config.runAsRoot === true,
  });
}

/** Flag a config (mutates it) as needing a restart for a change saved now. */
export function markPendingRestart(config) {
  config.pendingRestart = { since: new Date().toISOString() };
}

/**
 * Set or clear a container's restart-required flag. `true` records
 * `since = now` (a later change moves it forward); `false` (or `null`)
 * removes the flag; a `{ since }` flag is written as given — to restore an
 * earlier flag exactly, e.g. after a rolled-back save. For callers that change
 * a container's state outside updateContainerConfig (migrations, app config)
 * and know whether the running task needs a restart to pick it up. Returns
 * `{ changed }`.
 */
export async function setContainerPendingRestart(name, value) {
  const config = await readContainerConfig(name);
  if (value === true) {
    markPendingRestart(config);
  } else if (typeof value?.since === 'string') {
    if (config.pendingRestart?.since === value.since) return { changed: false };
    config.pendingRestart = { since: value.since };
  } else {
    if (!('pendingRestart' in config)) return { changed: false };
    delete config.pendingRestart;
  }
  await writeContainerConfig(name, config);
  return { changed: true };
}

/**
 * The restart-required rule: the flag still in force — `{ since }` or null.
 * `pid` is the task's init process (0 when there is no task). A flag the
 * task started after is no longer in force; a stopped container, or one whose
 * start time /proc can't tell, keeps its flag. Writes nothing: reads apply it,
 * and the start drops the stored flag (`startExistingContainer`).
 */
export async function pendingRestartInForce(config, pid) {
  const flag = config.pendingRestart;
  if (!flag) return null;
  const startedAt = pid ? await processStartTimeMsFromProc(pid) : null;
  if (startedAt == null || !(startedAt > Date.parse(flag.since))) return flag;
  return null;
}
