/**
 * Restart-required flag: `pendingRestart: { since }` in container.json marks
 * a saved change the running task doesn't reflect yet. A container needs a
 * restart while the flag exists and its task has not started since `since`;
 * the stored flag is dropped by the start that outgrows it.
 */
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { processStartTimeMsFromProc } from './procUptime.js';

/** Flag a config (mutates it) as needing a restart for a change saved now. */
export function markPendingRestart(config) {
  config.pendingRestart = { since: new Date().toISOString() };
}

/**
 * Set or clear a container's restart-required flag. `true` records
 * `since = now` (a later change moves it forward); `false` removes the flag.
 * For callers that change a container's state outside updateContainerConfig
 * (migrations, app config) and know whether the running task needs a
 * restart to pick it up. Returns `{ changed }`.
 */
export async function setContainerPendingRestart(name, value) {
  const config = await readContainerConfig(name);
  if (value === true) {
    markPendingRestart(config);
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
