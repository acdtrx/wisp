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
 * Each container's backup is a job started through the one job starter
 * (same kind and title as a manual container backup), so scheduled runs are
 * listed and followed like any other job. The job holds the container's
 * operation lock; a container busy with another operation (a manual backup,
 * a start, a restore, …) is skipped for this run.
 *
 * The run itself is `runScheduledBackups({ trigger })`, invocable on its own
 * (ARCHITECTURE.md, Backend: events); the minute tick is one trigger. Every run logs its
 * trigger, and at most one runs at a time whatever triggered it.
 */
import { getSettings, getRawMounts, listConfiguredBackupRoots } from './settings.js';
import { resolveBackupDestinations, backupToEachDestination } from './backupDestinations.js';
import { computeScheduledBackupPruneList } from './backupRetention.js';
import {
  listContainers,
  getContainerConfig,
  createContainerBackup,
  listContainerBackups,
  deleteContainerBackup,
} from './containerManager/index.js';
import { startJob, BACKGROUND_JOB_KIND, titleForContainerBackup } from './jobs/index.js';
import { recordBackupAttempt } from './backupStatus.js';

const TICK_MS = 60 * 1000;

let intervalId = null;
let lastTickAt = null;
let runInFlight = false;

/** Most recent Date before-or-at `now` with the schedule's HH:MM (host-local). */
function latestTargetAt(now, time) {
  const [hh, mm] = time.split(':').map((s) => parseInt(s, 10));
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  if (target > now) target.setDate(target.getDate() - 1);
  return target;
}

async function tick(log) {
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
    log.warn({ err }, 'Backup scheduler: failed to read settings');
    return;
  }
  if (!schedule?.enabled) return;

  const target = latestTargetAt(now, schedule.time);
  /* Fire iff the target lies in (prev, now] — at most once per boundary. */
  if (!prev || target <= prev || target > now) return;

  try {
    await runScheduledBackups({ trigger: 'schedule', log });
  } catch (err) {
    log.error({ err }, 'Backup scheduler: run failed');
  }
}

/**
 * Back up every container with Auto Backup on to the schedule's destinations,
 * then prune scheduled-origin backups per its retention — the scheduled run,
 * on demand. Uses `settings.backupSchedule` (destinations, retention) whether
 * or not the schedule is enabled. Returns false when skipped because a run is
 * already in flight.
 * @param {{ trigger?: string, log: import('fastify').FastifyBaseLogger }} opts - `trigger`: what invoked the run, for the log
 * @returns {Promise<boolean>}
 */
export async function runScheduledBackups({ trigger = 'manual', log }) {
  if (runInFlight) {
    log.warn({ trigger }, 'Backup scheduler: previous run still in flight, skipping');
    return false;
  }
  runInFlight = true;
  try {
    await backupAutoBackupContainers(trigger, log);
    return true;
  } finally {
    runInFlight = false;
  }
}

async function backupAutoBackupContainers(trigger, log) {
  const settings = await getSettings();
  const schedule = settings.backupSchedule || {};
  const rawMounts = await getRawMounts();

  let destinations;
  try {
    destinations = await resolveBackupDestinations(settings, rawMounts, schedule.destinationIds);
  } catch (err) {
    /* Destination trouble (unmountable share, nothing configured) aborts the
     * whole run — containers stay untouched; next boundary is tomorrow. */
    log.warn({ trigger, err: err.message, detail: err.raw }, 'Backup scheduler: no usable destination, skipping run');
    return;
  }

  let list;
  try {
    list = await listContainers();
  } catch (err) {
    log.warn({ trigger, err }, 'Backup scheduler: listContainers failed, skipping run');
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
    log.info({ trigger }, 'Backup scheduler: fired, no containers with Auto Backup enabled');
    return;
  }
  log.info({ trigger, containers: names, destinations: destinations.map((d) => d.id) }, 'Backup scheduler: run started');

  const allowedRoots = listConfiguredBackupRoots(settings);
  let backedUp = 0;
  let failed = 0;
  let skipped = 0;

  const destinationIds = destinations.map((d) => d.id);
  for (const name of names) {
    // Settles with the backup's outcome: the containers are backed up one at a time.
    const ended = Promise.withResolvers();
    try {
      await startJob({
        kind: BACKGROUND_JOB_KIND.CONTAINER_BACKUP,
        title: titleForContainerBackup(name),
        subject: { type: 'container', name },
        log,
        run: async (report) => {
          let ok = false;
          try {
            let lastResult;
            try {
              lastResult = await backupToEachDestination(destinations, {
                push: report,
                backupOne: (dest, onProgress) => createContainerBackup(name, dest.path, { origin: 'scheduled', onProgress }),
                afterEach: (dest) => pruneScheduledBackups(name, dest, allowedRoots, log),
              });
            } catch (err) {
              await recordBackupAttempt({
                kind: 'container', name, ok: false, origin: 'scheduled', destinationIds, error: err?.message,
              });
              throw err;
            }
            await recordBackupAttempt({
              kind: 'container', name, ok: true, origin: 'scheduled', destinationIds, timestamp: lastResult?.timestamp,
            });
            ok = true;
            // The backup folder name only: its host path stays on the server.
            return { timestamp: lastResult?.timestamp };
          } finally {
            ended.resolve(ok);
          }
        },
      });
    } catch (err) {
      if (err?.code !== 'CONTAINER_BUSY') throw err;
      log.warn({ container: name }, 'Backup scheduler: another operation on the container is in progress, skipping container');
      skipped += 1;
      continue;
    }
    if (await ended.promise) backedUp += 1;
    else failed += 1;
  }
  log.info({ trigger, backedUp, failed, skipped }, 'Backup scheduler: run finished');
}

async function pruneScheduledBackups(name, dest, allowedRoots, log) {
  let rows;
  try {
    rows = await listContainerBackups([dest], name);
  } catch (err) {
    log.warn({ err, container: name, destination: dest.id }, 'Backup scheduler: retention listing failed');
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
      log.info(
        { container: name, destination: dest.id, timestamp: row.timestamp },
        'Backup scheduler: pruned scheduled backup',
      );
    } catch (err) {
      log.warn({ err, container: name, timestamp: row.timestamp }, 'Backup scheduler: prune failed');
    }
  }
}

/** Idempotent. Baseline is "now": a boot after today's boundary does not fire. */
export function startContainerBackupScheduler(log) {
  if (intervalId != null) return;
  lastTickAt = new Date();
  intervalId = setInterval(() => {
    tick(log).catch((err) => log.error({ err }, 'Backup scheduler: tick failed'));
  }, TICK_MS);
  intervalId.unref?.();
}

/** Clears the timer; an in-flight run finishes on its own. */
export function stopContainerBackupScheduler() {
  if (intervalId != null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
