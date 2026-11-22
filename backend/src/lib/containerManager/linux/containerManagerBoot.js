/**
 * The container passes at backend boot: autostart, and resuming a task an
 * interrupted backup left paused.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { containerState } from './containerManagerConnection.js';
import { getContainerDir } from './containerPaths.js';
import { tryAcquireOperationLock } from './containerOperationGuard.js';
import { listContainers } from './containerManagerList.js';
import { resumeContainer } from './containerManagerLifecycle.js';
import { startContainer } from './containerManagerStart.js';

/**
 * Start every container with autostart enabled that is not already running.
 * Best-effort: logs and continues on per-container failure (host boot / backend restart).
 * Each start holds the embedder's operation lock; a busy container is skipped.
 */
export async function startAutostartContainersAtBackendBoot(log) {
  if (!containerState.connected) return;

  let list;
  try {
    list = await listContainers();
  } catch (err) {
    log.warn({ err }, 'Container autostart: listContainers failed');
    return;
  }

  for (const c of list) {
    if (c.state === 'running') continue;

    let autostart = false;
    try {
      const raw = await readFile(join(getContainerDir(c.name), 'container.json'), 'utf8');
      autostart = JSON.parse(raw).autostart === true;
    } catch {
      continue;
    }
    if (!autostart) continue;

    const release = tryAcquireOperationLock(c.name, 'autostart');
    if (!release) {
      log.info({ container: c.name }, 'Container autostart skipped: another operation on the container is in progress');
      continue;
    }
    try {
      await startContainer(c.name);
    } catch (err) {
      log.warn({ err, container: c.name }, 'Container autostart failed');
    } finally {
      release();
    }
  }
}

/**
 * Resume any container whose task is still paused at backend boot.
 * Wisp exposes no user-facing pause — tasks are only ever paused around a
 * backup archive, so a paused task at boot means a backup was interrupted
 * by a crash. Best-effort: logs and continues per container.
 */
export async function resumeStalePausedContainersAtBackendBoot(log) {
  if (!containerState.connected) return;

  let list;
  try {
    list = await listContainers();
  } catch (err) {
    log.warn({ err }, 'Stale-pause recovery: listContainers failed');
    return;
  }

  for (const c of list) {
    if (c.state !== 'paused') continue;
    try {
      await resumeContainer(c.name);
      log.info({ container: c.name }, 'Resumed container left paused by an interrupted backup');
    } catch (err) {
      log.warn({ err, container: c.name }, 'Failed to resume stale paused container');
    }
  }
}
