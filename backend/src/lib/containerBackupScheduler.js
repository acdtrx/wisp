/**
 * Daily scheduler for container backups (app-glue).
 *
 * Every minute, checks whether the configured wall-clock time
 * (`settings.backupSchedule.time`, host-local) was crossed since the last
 * tick; when it fires, backs up every container with `autoBackup: true` in
 * its container.json — sequentially, so at most one container is paused at
 * a time — then prunes scheduled-origin backups per the GFS-lite retention
 * policy (see lib/backupRetention.js).
 *
 * No missed-window catch-up: the boundary must be crossed while the backend
 * is running (the server is assumed 24/7); a boot after the scheduled time
 * waits for the next day. State (`lastTickAt`) is in-memory only — nothing
 * new is persisted, so the self-updater needs no changes.
 *
 * Jobs are registered in the shared backupJobStore (same kind/title as
 * manual container backups), so scheduled runs surface in
 * GET /api/background-jobs, the per-job SSE progress endpoint, and the
 * frontend's page-load job rehydration.
 */
import { randomBytes } from 'node:crypto';

import { getSettings, getRawMounts, listConfiguredBackupRoots } from './settings.js';
import { resolveBackupDestinations } from './backupDestinations.js';
import { computeScheduledBackupPruneList } from './backupRetention.js';
import {
  listContainers,
  getContainerConfig,
  createContainerBackup,
  listContainerBackups,
  deleteContainerBackup,
} from './containerManager/index.js';
import { backupJobStore, BACKGROUND_JOB_KIND, titleForContainerBackup } from './jobs/index.js';

const TICK_MS = 60 * 1000;

let intervalId = null;
let lastTickAt = null;
let runInFlight = false;
let logger = null;

/** Most recent Date before-or-at `now` with the schedule's HH:MM (host-local). */
function latestTargetAt(now, time) {
  const [hh, mm] = time.split(':').map((s) => parseInt(s, 10));
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  if (target > now) target.setDate(target.getDate() - 1);
  return target;
}

async function tick() {
  const now = new Date();
  /* Clock moved backwards (NTP step, DST weirdness) — re-baseline instead of
   * firing on a boundary we may already have served. */
  if (lastTickAt && now < lastTickAt) {
    lastTickAt = now;
    return;
  }
  const prev = lastTickAt;
  lastTickAt = now;

  let schedule;
  try {
    schedule = (await getSettings()).backupSchedule;
  } catch (err) {
    logger?.warn({ err }, 'Backup scheduler: failed to read settings');
    return;
  }
  if (!schedule?.enabled) return;

  const target = latestTargetAt(now, schedule.time);
  /* Fire iff the target lies in (prev, now] — at most once per boundary. */
  if (!prev || target <= prev || target > now) return;
  if (runInFlight) {
    logger?.warn('Backup scheduler: previous run still in flight, skipping this boundary');
    return;
  }

  runInFlight = true;
  try {
    await runScheduledBackups(schedule);
  } catch (err) {
    logger?.error({ err }, 'Backup scheduler: run failed');
  } finally {
    runInFlight = false;
  }
}

async function runScheduledBackups(schedule) {
  const log = logger;
  const settings = await getSettings();
  const rawMounts = await getRawMounts();

  let destinations;
  try {
    destinations = await resolveBackupDestinations(settings, rawMounts, schedule.destinationIds);
  } catch (err) {
    /* Destination trouble (unmountable share, nothing configured) aborts the
     * whole run — containers stay untouched; next boundary is tomorrow. */
    log?.warn({ err: err.message, detail: err.raw }, 'Backup scheduler: no usable destination, skipping run');
    return;
  }

  let list;
  try {
    list = await listContainers();
  } catch (err) {
    log?.warn({ err }, 'Backup scheduler: listContainers failed, skipping run');
    return;
  }

  const names = [];
  for (const c of list) {
    try {
      const config = await getContainerConfig(c.name);
      if (config?.autoBackup === true) names.push(c.name);
    } catch { /* container dir may be mid-delete — skip it this run */ }
  }
  if (names.length === 0) {
    log?.info('Backup scheduler: fired, no containers with Auto Backup enabled');
    return;
  }
  log?.info({ containers: names, destinations: destinations.map((d) => d.id) }, 'Backup scheduler: run started');

  const allowedRoots = listConfiguredBackupRoots(settings);

  for (const name of names) {
    const title = titleForContainerBackup(name);
    const alreadyRunning = backupJobStore.listJobs().some(
      (j) => !j.done && j.kind === BACKGROUND_JOB_KIND.CONTAINER_BACKUP && j.title === title,
    );
    if (alreadyRunning) {
      log?.warn({ container: name }, 'Backup scheduler: manual backup in progress, skipping container');
      continue;
    }

    const jobId = randomBytes(12).toString('hex');
    backupJobStore.createJob(jobId, { kind: BACKGROUND_JOB_KIND.CONTAINER_BACKUP, title, log });
    log?.info({ jobId, container: name }, 'Backup scheduler: container backup started');
    try {
      let lastResult;
      for (const dest of destinations) {
        lastResult = await createContainerBackup(name, dest.path, {
          origin: 'scheduled',
          onProgress(ev) {
            backupJobStore.pushEvent(jobId, { step: ev.step, percent: ev.percent, currentFile: ev.currentFile });
          },
        });
        await pruneScheduledBackups(name, dest, allowedRoots);
      }
      backupJobStore.completeJob(jobId, lastResult);
    } catch (err) {
      backupJobStore.failJob(jobId, err);
      log?.error({ err, container: name, jobId }, 'Backup scheduler: container backup failed');
      /* Continue with the remaining containers. */
    }
  }
  log?.info('Backup scheduler: run finished');
}

async function pruneScheduledBackups(name, dest, allowedRoots) {
  const log = logger;
  let rows;
  try {
    rows = await listContainerBackups([dest], name);
  } catch (err) {
    log?.warn({ err, container: name, destination: dest.id }, 'Backup scheduler: retention listing failed');
    return;
  }
  const schedule = (await getSettings()).backupSchedule;
  const toDelete = computeScheduledBackupPruneList(rows, {
    retainDays: schedule.retainDays,
    retainWeeks: schedule.retainWeeks,
  });
  for (const row of toDelete) {
    try {
      await deleteContainerBackup(row.path, allowedRoots);
      log?.info(
        { container: name, destination: dest.id, timestamp: row.timestamp },
        'Backup scheduler: pruned scheduled backup',
      );
    } catch (err) {
      log?.warn({ err, container: name, timestamp: row.timestamp }, 'Backup scheduler: prune failed');
    }
  }
}

/** Idempotent. Baseline is "now": a boot after today's boundary does not fire. */
export function startContainerBackupScheduler(log) {
  if (intervalId != null) return;
  logger = log;
  lastTickAt = new Date();
  intervalId = setInterval(() => {
    tick().catch((err) => logger?.error({ err }, 'Backup scheduler: tick failed'));
  }, TICK_MS);
  intervalId.unref?.();
}

/** Clears the timer; an in-flight run finishes on its own. */
export function stopContainerBackupScheduler() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
  logger = null;
}
