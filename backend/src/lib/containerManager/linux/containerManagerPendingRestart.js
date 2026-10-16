/**
 * Restart-required flag: `pendingRestart: { since }` in container.json marks
 * a saved change the running task doesn't reflect yet. A container needs a
 * restart while the flag exists and its task has not started since `since`;
 * the flag is dropped when a read observes a task that started later.
 */
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { processStartTimeMsFromProc } from './procUptime.js';
import { containerState } from './containerManagerConnection.js';

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
 * The restart-required rule, applied wherever a container's state is read
 * (list refresh, detail). `pid` is the task's init process (0 when there is
 * no task). Returns the flag still in force — `{ since }` or null — and drops
 * it from container.json when the task started after `since` (unless the
 * connection doesn't repair on read). A stopped
 * container, or one whose start time /proc can't tell, keeps its flag.
 * Only the `{ since }` shape is a flag; anything else is returned as null and
 * left on disk untouched.
 */
export async function resolvePendingRestart(name, config, pid) {
  const since = config.pendingRestart?.since;
  if (typeof since !== 'string') return null;
  const startedAt = pid ? await processStartTimeMsFromProc(pid) : null;
  if (startedAt == null || !(startedAt > Date.parse(since))) return config.pendingRestart;
  if (!containerState.repairOnRead) return null;
  try {
    const latest = await readContainerConfig(name);
    // A newer flag (set after this read) belongs to a later change — keep it.
    if (latest.pendingRestart?.since === since) {
      delete latest.pendingRestart;
      await writeContainerConfig(name, latest);
      containerState.logger?.info?.({ container: name, since }, '[containerManager] restart-required flag cleared: task started after it was set');
    }
  } catch (err) {
    containerState.logger?.warn?.({ container: name, err: err?.message || err }, '[containerManager] failed to clear restart-required flag');
  }
  return null;
}
